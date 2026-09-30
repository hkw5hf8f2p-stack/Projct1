/** run_accessibility: axe-докази сторінки (axe виконується під час захоплення — йому потрібна жива сторінка; тут — фіксація доказів із збереженого захоплення). */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job } from "pg-boss";
import { addWarning, auditDir, getJob, insertEvidence, upsertJob, type JobData } from "@sitelens/pipeline";
import { detectAxe, type PageCapture } from "../browser-api.js";
import type { Runtime } from "../runtime.js";
import { advancePostCrawl, isFinalAttempt, liveAudit } from "./common.js";

export async function accessibilityJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const { auditRunId, pageId, url } = job.data as JobData & { pageId: string; url: string };
  const audit = await liveAudit(rt, auditRunId);
  if (!audit) return;
  const key = `accessibility:${pageId}`;
  if (await getJob(rt.pool, auditRunId, key)) {
    await advancePostCrawl(rt, auditRunId);
    return;
  }
  const dir = auditDir(rt.cfg.artifactDir, auditRunId);
  try {
    const cap = JSON.parse(await readFile(path.join(dir, "pages", pageId, "page-capture.json"), "utf8")) as PageCapture;
    const ev = detectAxe({ url: cap.url, path: cap.path, page_type: cap.page_type, page_type_reason: cap.page_type_reason, page_group: cap.page_group, D: cap.D, M: cap.M, classification: cap.classification, engine: "v2" });
    await writeFile(path.join(dir, "pages", pageId, "evidence-axe.json"), JSON.stringify(ev, null, 2) + "\n");
    if (!(await liveAudit(rt, auditRunId))) return;
    const c = await rt.pool.connect();
    try {
      await c.query("BEGIN");
      await insertEvidence(c, auditRunId, ev.map((e) => ({ ...e, page_id: pageId })));
      await upsertJob(c, { audit_run_id: auditRunId, job_key: key, kind: "accessibility", page_url: url, status: "done", error_class: null, error: null, result_json: { axe_evidence: ev.length, axe_version: cap.D.axe.version } });
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    if (!isFinalAttempt("run_accessibility", job)) throw e;
    const msg = `Перевірку доступності сторінки не виконано: ${(e as Error).message.slice(0, 200)}`;
    await upsertJob(rt.pool, { audit_run_id: auditRunId, job_key: key, kind: "accessibility", page_url: url, status: "failed", error_class: null, error: msg, result_json: {} });
    await addWarning(rt.pool, auditRunId, { stage: "accessibility", page_url: url, message: msg });
  }
  await advancePostCrawl(rt, auditRunId);
}
