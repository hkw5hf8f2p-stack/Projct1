/** run_lighthouse: Lighthouse через egress-проксі (S1b). Збій ≠ збій аудиту (§47): запис failed + попередження; решта конвеєра йде далі. */
import { createHash } from "node:crypto";
import path from "node:path";
import type { Job } from "pg-boss";
import { cmdlineOf, descendantsOf } from "@sitelens/db";
import { addWarning, ensureAuditDir, getJob, insertEvidence, upsertJob, type EvidenceInput, type JobData } from "@sitelens/pipeline";
import type { ErrorClass } from "@sitelens/schemas";
import { runLighthouseIsolated, type FormFactor, type LighthouseRunResult } from "../browser-api.js";
import type { Runtime } from "../runtime.js";
import { advancePostCrawl, isFinalAttempt, liveAudit } from "./common.js";

/** Evidence Lighthouse (BENCHMARKED, опорний факт ET-SUP) → рядок таблиці evidence з обов'язковими полями детермінованого шляху. */
export function lighthouseEvidenceRow(e: LighthouseRunResult["evidence"][number], pageId: string): EvidenceInput {
  const data = (e.data ?? {}) as Record<string, unknown>;
  const category = data["category"] === "accessibility" ? "accessibility" : "performance";
  return {
    id: e.id, type: "lighthouse", source_class: "BENCHMARKED", page_url: e.page_url, page_id: pageId, page_path: new URL(e.page_url).pathname + new URL(e.page_url).search,
    category, description: e.description, artifact_reference: e.artifact_reference, selector_or_region: { selector: e.selector_or_region.selector },
    detector_id: e.detector_id, claim_kind: e.claim_kind, assertion: "presence", viewport: e.viewport === "mobile" ? "M" : "D", measurement: data,
    self_confirming: false, capture_complete: true,
    capture_context: { banner_state: "none", banner_actions: [], blocked_requests_count: 0, js_error_count: 0, scroll_completed: true, layout_stable: true, http_status: null },
  };
}

/**
 * DEV-97: лабораторна метрика гірша за опублікований поріг «добре» (Core Web Vitals LCP ≤ 2500 мс; Lighthouse TBT ≤ 200 мс = LH_THRESHOLDS moderate) —
 * самопідтверджувальний BENCHMARKED-факт (порівняння виміру інструмента з зовнішнім еталоном, без інтерпретації) → ET-DET, знахідка performance.
 * Категорійна оцінка лишається опорним фактом (ET-SUP, DEV-68). Жодного прогнозу ефекту: лише вимір і поріг.
 */
export const LH_GOOD = { lcp_ms: 2500, tbt_ms: 200 } as const;
export function lighthouseMetricEvidenceRow(e: LighthouseRunResult["evidence"][number], pageId: string, page: { page_type: string | null; path: string }): EvidenceInput | null {
  const data = (e.data ?? {}) as { category?: string; score_100?: number; metrics?: Record<string, number | null> };
  if (data.category !== "performance" || !data.metrics) return null;
  const lcp = typeof data.metrics["largest-contentful-paint"] === "number" ? Math.round(data.metrics["largest-contentful-paint"]) : null;
  const tbt = typeof data.metrics["total-blocking-time"] === "number" ? Math.round(data.metrics["total-blocking-time"]) : null;
  const lcpBad = lcp !== null && lcp > LH_GOOD.lcp_ms;
  const tbtBad = tbt !== null && tbt > LH_GOOD.tbt_ms;
  if (!lcpBad && !tbtBad) return null;
  const u = new URL(e.page_url);
  const pt = page.page_type ?? "unknown";
  const group = pt === "product" || pt === "category" ? pt : page.path.replace(/(.)\/$/, "$1");
  return {
    id: "ev_" + createHash("sha256").update(`${e.id}|lighthouse_metric_poor`).digest("hex").slice(0, 12), type: "lighthouse", source_class: "BENCHMARKED", page_url: e.page_url, page_id: pageId, page_path: u.pathname + u.search, page_type: pt, page_group: group,
    category: "performance", description: `Lighthouse (${e.viewport}): ${lcpBad ? `LCP ${lcp} мс > ${LH_GOOD.lcp_ms} мс` : ""}${lcpBad && tbtBad ? "; " : ""}${tbtBad ? `TBT ${tbt} мс > ${LH_GOOD.tbt_ms} мс` : ""}`,
    artifact_reference: e.artifact_reference, selector_or_region: { selector: "lhr.audits" },
    detector_id: "lighthouse:metrics", claim_kind: "lighthouse_metric_poor", assertion: "presence", viewport: e.viewport === "mobile" ? "M" : "D",
    measurement: { lcp_ms: lcp, tbt_ms: tbt, lcp_good_ms: LH_GOOD.lcp_ms, tbt_good_ms: LH_GOOD.tbt_ms, lcp_over: lcpBad, tbt_over: tbtBad, performance_score: data.score_100 ?? null, form_factor: e.viewport },
    self_confirming: true, capture_complete: true,
    capture_context: { banner_state: "none", banner_actions: [], blocked_requests_count: 0, js_error_count: 0, scroll_completed: true, layout_stable: true, http_status: null },
  };
}

const classOf = (m: string): ErrorClass | null => (/timed? ?out|timeout/i.test(m) ? "timeout" : /NAME_NOT_RESOLVED|DNS/i.test(m) ? "dns_failure" : /cert|ssl/i.test(m) ? "ssl_failure" : null);

export async function lighthouseJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const { auditRunId, pageId, url, formFactor } = job.data as JobData & { pageId: string; url: string; formFactor: FormFactor };
  const audit = await liveAudit(rt, auditRunId);
  if (!audit) return;
  const key = `lighthouse:${pageId}:${formFactor}`;
  if (await getJob(rt.pool, auditRunId, key)) {
    await advancePostCrawl(rt, auditRunId);
    return;
  }
  const runDir = ensureAuditDir(rt.cfg.artifactDir, auditRunId);
  const broken = rt.hasFault("lighthouse_broken");
  const net = rt.netOptions();
  let res: LighthouseRunResult;
  try {
    res = await rt.gate.run(url, async () => {
      await rt.gate.wait(url);
      return runLighthouseIsolated({
        url, formFactor, mode: net.mode, fixtureOrigins: net.fixtureOrigins, allowFixtureLoopback: net.allowFixtureLoopback, resolver: net.resolver, dial: net.dial,
        chromePath: rt.chromeWrapper.script, outDir: path.join(runDir, "pages", pageId), lhrName: `lighthouse-${formFactor}.json`, timeoutMs: rt.cfg.lighthouse.timeoutMs,
        ...(broken ? { lighthouseImpl: (async () => { throw new Error("Lighthouse зламано навмисно (fault injection lighthouse_broken)"); }) as never } : {}),
      });
    });
  } catch (e) {
    // runLighthouseIsolated не кидає; будь-що тут — збій інфраструктури: повторити, а на останній спробі записати як збій
    if (!isFinalAttempt("run_lighthouse", job)) throw e;
    res = { ok: false, error: (e as Error).message, evidence: [] } as unknown as LighthouseRunResult;
  }
  // Страховка: Chrome Lighthouse (chrome-launcher) міг пережити прогін (збій/тайм-аут ізоляції). Прибираємо ЛИШЕ власних нащадків цього процесу з профілем sl-lh-.
  const stray = descendantsOf(process.pid).filter((p) => cmdlineOf(p).includes("/sl-lh-"));
  for (const pid of stray) try { process.kill(pid, "SIGKILL"); } catch { /* уже вийшов */ }
  if (stray.length > 0) rt.log("warn", "Chrome Lighthouse пережив прогін — прибрано власних нащадків", { audit: auditRunId, pids: stray });
  if (!(await liveAudit(rt, auditRunId))) return;
  const c = await rt.pool.connect();
  try {
    await c.query("BEGIN");
    if (res.ok) {
      const pg = (await c.query("SELECT page_type FROM page_artifacts WHERE audit_run_id = $1 AND id = $2", [auditRunId, pageId])).rows[0] as { page_type: string | null } | undefined;
      const metricRows = res.evidence.map((e) => lighthouseMetricEvidenceRow(e, pageId, { page_type: pg?.page_type ?? null, path: new URL(e.page_url).pathname })).filter((x): x is EvidenceInput => x !== null);
      await insertEvidence(c, auditRunId, [...res.evidence.map((e) => lighthouseEvidenceRow(e, pageId)), ...metricRows]);
      await upsertJob(c, { audit_run_id: auditRunId, job_key: key, kind: "lighthouse", page_url: url, status: "done", error_class: null, error: null, result_json: { scores: res.scores, lhr_path: `pages/${pageId}/${res.lhr_path}`, version: res.lighthouse_version, duration_ms: res.duration_ms, stray_chrome_killed: stray.length } });
    } else {
      const msg = `Lighthouse (${formFactor}) не виконано: ${(res.error ?? "невідома помилка").slice(0, 300)}`;
      await upsertJob(c, { audit_run_id: auditRunId, job_key: key, kind: "lighthouse", page_url: url, status: "failed", error_class: classOf(res.error ?? ""), error: msg, result_json: { runtime_error: res.runtime_error ?? null } });
      await addWarning(c, auditRunId, { stage: "lighthouse", page_url: url, class: classOf(res.error ?? "") ?? undefined, message: msg });
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  await advancePostCrawl(rt, auditRunId);
}
