/**
 * aggregate_findings (S2): фіналізація детермінованих доказів — axe-області (assignAxeScopes), глибини кліків (як enrichDepths у run-site) — і завершення аудиту.
 * Агрегація знахідок/пріоритети — S4; тут `aggregate: done` з поясненням. Аудит `completed` навіть при частковому збої (§47, DEV-11).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job } from "pg-boss";
import { advanceStatus, auditDir, completeAudit, setStage, updateEvidenceMeasurement, type JobData } from "@sitelens/pipeline";
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
  await writeFile(path.join(dir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  await writeFile(path.join(dir, "axe-groups.json"), JSON.stringify(groupAxe(evidence), null, 2) + "\n");
  await setStage(rt.pool, id, "aggregate", "done", `S2: детерміновані докази зведено (${evidence.length}, оновлено ${changed}); агрегація знахідок і пріоритети — S4`);
  for (const st of ["snapshot_sessions", "browser_sessions", "report"]) await setStage(rt.pool, id, st, "skipped", "поза обсягом S2 (S4/S5)");
  await completeAudit(rt.pool, id);
}
