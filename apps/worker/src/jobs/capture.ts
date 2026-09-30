/** capture_page: захоплення однієї сторінки; маркер завершення — рядок audit_jobs у ТІЙ САМІЙ транзакції, що й page_artifacts + evidence (ідемпотентно). */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { Job } from "pg-boss";
import { addWarning, ensureAuditDir, getJob, humanMessage, insertEvidence, upsertJob, upsertPage, type JobData } from "@sitelens/pipeline";
import { detectAllWithCoverage } from "../browser-api.js";
import { capturePageFlow } from "../capture.js";
import { failedRow, pageRowOf } from "../page-row.js";
import type { Runtime } from "../runtime.js";
import { liveAudit } from "./common.js";

export async function captureJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const { auditRunId, url, pageId, seedUrl } = job.data as JobData & { url: string; pageId: string; seedUrl: string };
  const audit = await liveAudit(rt, auditRunId);
  if (!audit) return;
  const key = `capture:${pageId}`;
  if (await getJob(rt.pool, auditRunId, key)) return; // уже зроблено (повтор після kill -9 / дубль)
  const runDir = ensureAuditDir(rt.cfg.artifactDir, auditRunId);
  const out = await capturePageFlow(rt, { url, pageId, runDir, seedUrl });
  if (!(await liveAudit(rt, auditRunId))) return; // аудит видалено під час захоплення: нічого не пишемо (файли прибере видалення/TTL)
  const c = await rt.pool.connect();
  try {
    if (out.ok) {
      const cap = out.capture;
      mkdirSync(path.join(runDir, "pages", pageId), { recursive: true });
      await writeFile(path.join(runDir, "pages", pageId, "page-capture.json"), JSON.stringify(cap) + "\n"); // джерело для crawl-replay і run_accessibility
      const det = detectAllWithCoverage({ url: cap.url, path: cap.path, page_type: cap.page_type, page_type_reason: cap.page_type_reason, page_group: cap.page_group, D: cap.D, M: cap.M, classification: cap.classification, engine: "v2" });
      const ev = det.evidence.filter((e) => e.type !== "axe"); // axe-докази — задача run_accessibility
      await writeFile(path.join(runDir, "pages", pageId, "coverage.json"), JSON.stringify(det.coverage, null, 2) + "\n");
      await writeFile(path.join(runDir, "pages", pageId, "evidence-detectors.json"), JSON.stringify(ev, null, 2) + "\n");
      await c.query("BEGIN");
      await upsertPage(c, auditRunId, pageRowOf(cap));
      await insertEvidence(c, auditRunId, ev.map((e) => ({ ...e, page_id: pageId })));
      await upsertJob(c, { audit_run_id: auditRunId, job_key: key, kind: "capture", page_url: url, status: "done", error_class: null, error: null, result_json: { page_type: cap.page_type, evidence: ev.length } });
      await c.query("COMMIT");
    } else {
      const f = out.failure;
      const msg = humanMessage(f.errorClass, audit.language);
      await c.query("BEGIN");
      await upsertPage(c, auditRunId, failedRow(url, pageId, f.errorClass, f.detail, audit.language, out.http_status, out.attempts));
      await upsertJob(c, { audit_run_id: auditRunId, job_key: key, kind: "capture", page_url: url, status: "failed", error_class: f.errorClass, error: `${msg} (${f.detail})`.slice(0, 1000), attempts: out.attempts, result_json: { detail: f.detail } });
      await addWarning(c, auditRunId, { stage: "capture", page_url: url, class: f.errorClass, message: msg });
      await c.query("COMMIT");
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
