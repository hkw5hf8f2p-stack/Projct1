/**
 * aggregate_findings: (S2) фіналізація детермінованих доказів — axe-області (assignAxeScopes), глибини кліків (як enrichDepths у run-site);
 * (S4) інтеграція SYNTHETIC-сесій у докази (§23: цитата звіряється з текстом сторінки), агрегація в знахідки й пріоритети (packages/scoring),
 * запис findings + finding_evidence в БД (одна транзакція, deferred-тригер «знахідка без доказу не існує»), далі — generate_report.
 * Аудит завершує generate_report (completed навіть при частковому збої, §47, DEV-11).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job } from "pg-boss";
import { Q, txDb, advanceStatus, auditDir, enqueue, getAudit, insertEvidence, replaceFindings, setStage, updateEvidenceMeasurement, type EvidenceInput, type JobData } from "@sitelens/pipeline";
import { loadAuditArtifacts } from "../artifacts.js";
import { computeFindings, findingRows } from "../findings.js";
import { llmResultsFromDb, withTx } from "../llm-store.js";
import { runFindingTexts } from "../finding-texts.js";
import { SHIP_RE, assignAxeScopes, bfsDepth, groupAxe, type EvidenceRow, type PageCapture } from "../browser-api.js";
import type { Runtime } from "../runtime.js";
import { liveAudit } from "./common.js";

export async function aggregateJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const id = job.data.auditRunId;
  const audit = await liveAudit(rt, id);
  if (!audit) return;
  await advanceStatus(rt.pool, id, "aggregating");
  const dir = auditDir(rt.cfg.artifactDir, id);
  const okPages = (await rt.pool.query("SELECT job_key FROM audit_jobs WHERE audit_run_id = $1 AND kind = 'capture' AND status = 'done' ORDER BY job_key", [id])).rows.map((r) => (r.job_key as string).slice("capture:".length));
  const evidence: EvidenceRow[] = [];
  const caps: PageCapture[] = [];
  const read = async <T>(p: string): Promise<T | null> => readFile(path.join(dir, p), "utf8").then((s) => JSON.parse(s) as T).catch(() => null);
  for (const pid of okPages) {
    for (const f of ["evidence-detectors.json", "evidence-axe.json"]) evidence.push(...((await read<EvidenceRow[]>(`pages/${pid}/${f}`)) ?? []));
    const cap = await read<PageCapture>(`pages/${pid}/page-capture.json`);
    if (cap) caps.push(cap);
  }
  const before = new Map(evidence.map((e) => [e.id, JSON.stringify(e.measurement) + "|" + (e.excerpt ?? "")]));
  assignAxeScopes(evidence);
  const crawlDoc = await read<{ edges: string[] }>("crawl.json");
  const edges = (crawlDoc?.edges ?? []).map((s) => { const [from, to] = s.split(" -> "); return { from: from!, to: to! }; });
  const byUrl = new Map(caps.map((p) => [p.url, p]));
  const shipTarget = (url: string) => { const p = byUrl.get(url); return !!p && [p.D, p.M].some((c) => c.text_nodes.some((n) => !n.a && SHIP_RE.test(n.t))); };
  const priceTarget = (url: string) => { const p = byUrl.get(url); return !!p && p.D.price_candidates.some((c) => !c.excluded); };
  for (const e of evidence) {
    if (e.detector_id === "shipping_depth") {
      const r = bfsDepth(e.page_url, edges, shipTarget);
      e.measurement = { ...e.measurement, depth_clicks: r?.depth ?? null, shipping_found_via: r ? r.path.map((u) => new URL(u).pathname).join(" → ") : null, crawl_pages: caps.length };
      if (r) e.excerpt = `${e.excerpt ?? ""} | Доставку знайдено: ${e.measurement["shipping_found_via"]}`.slice(0, 300);
    }
    if (e.detector_id === "price_first_viewport") {
      const r = bfsDepth(e.page_url, edges, priceTarget);
      e.measurement = { ...e.measurement, price_depth_clicks: r?.depth ?? null, crawl_pages: caps.length };
    }
  }
  let changed = 0;
  for (const e of evidence) {
    if (before.get(e.id) === JSON.stringify(e.measurement) + "|" + (e.excerpt ?? "")) continue;
    await updateEvidenceMeasurement(rt.pool, id, e.id, e.measurement, e.excerpt);
    changed++;
  }
  await writeFile(path.join(dir, "axe-groups.json"), JSON.stringify(groupAxe(evidence), null, 2) + "\n");
  // етапи сесій: якщо join не виставив стан (режим none, матриця skipped/failed) — чесна причина, а не «поза обсягом»
  const cur = (await getAudit(rt.pool, id))!;
  for (const st of ["snapshot_sessions", "browser_sessions"] as const) {
    if (!cur.stage_status[st]) await setStage(rt.pool, id, st, "skipped", cur.llm_mode === "none" ? "no LLM provider" : `upstream scenario_matrix: ${cur.stage_status["scenario_matrix"]?.status ?? "не виконано"}`);
  }
  // ---- S4: докази сесій → знахідки → БД
  const art = await loadAuditArtifacts(rt.pool, rt.cfg.artifactDir, cur, { completedAt: new Date().toISOString() });
  const llmR = await llmResultsFromDb(rt.pool, id, art, cur);
  const scored = computeFindings(art, llmR?.llm ?? null);
  // DEV-98: тексти знахідок від моделі (finding-aggregator-v1 → recommendation-v1) — до запису знахідок; кожна група комітиться окремо
  // fail-open: будь-який збій текстів (провайдер, тайм-аут, помилка коду) не блокує знахідки й звіт — лише кодові тексти
  const ft = llmR ? await runFindingTexts(rt, cur, art, llmR.llm, scored.findings).catch((e: unknown) => { rt.log("warn", "finding texts: збій етапу, кодові тексти", { audit: id, err: String((e as Error).message).slice(0, 200) }); return null; }) : null;
  const ftNote = ft && ft.eligible ? `; тексти знахідок LLM: ${ft.supported + ft.skipped_existing} з ${ft.eligible} груп (not_supported ${ft.not_supported}, збій ${ft.failed}${ft.timed_out ? `, тайм-аут ${ft.timed_out}` : ""}${ft.deadline_hit ? ", ліміт часу" : ""}${ft.budget_limited ? ", зупинено бюджетом" : ""})` : "";
  await withTx(rt.pool, async (c) => {
    if (llmR && llmR.llm.evidence.length) await insertEvidence(c, id, llmR.llm.evidence as unknown as EvidenceInput[]);
    await replaceFindings(c, id, findingRows(scored));
    await setStage(c, id, "aggregate", ft?.budget_limited ? "budget_limited" : "done", `докази зведено (${art.evidence.length} детермінованих, ${llmR?.llm.evidence.length ?? 0} синтетичних; оновлено ${changed}); знахідок ${scored.findings.length}, відхилено тверджень без доказу ${llmR?.rejected.length ?? 0}${llmR && llmR.rejected.length ? ` (${Object.entries(llmR.rejected.reduce<Record<string, number>>((m, r) => ({ ...m, [r.reason]: (m[r.reason] ?? 0) + 1 }), {})).map(([k, n]) => `${k}: ${n}`).join(", ")})` : ""}${ftNote}`);
    await enqueue(rt.boss, Q.report, { auditRunId: id }, { db: txDb(c) });
  });
}
