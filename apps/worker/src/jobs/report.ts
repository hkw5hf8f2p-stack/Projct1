/**
 * generate_report: buildReport (packages/reporting) + guard-скан по JSON (fail-closed) → audit_reports; тексти знахідок і рекомендації → findings/recommendations;
 * аудит `completed`. Якщо звіт не пройшов контракт або guard — звіту НЕ існує (audit_reports без рядка, GET /report → 503 report_unavailable),
 * етап `report` = failed з нейтральною причиною (без LLM-тексту), аудит усе одно `completed` (DEV-11, DEV-68): детерміновані докази й артефакти лишаються.
 */
import { createHash } from "node:crypto";
import type { Job } from "pg-boss";
import { resolveConfig } from "@sitelens/llm";
import { addWarning, completeAudit, saveReport, setStage, type JobData } from "@sitelens/pipeline";
import { renderText, type Report } from "@sitelens/schemas";
import { buildReport } from "@sitelens/reporting";
import { loadAuditArtifacts } from "../artifacts.js";
import { llmResultsFromDb, withTx } from "../llm-store.js";
import type { Runtime } from "../runtime.js";
import { liveAudit } from "./common.js";

export async function reportJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const id = job.data.auditRunId;
  const audit = await liveAudit(rt, id);
  if (!audit) return;
  const at = new Date();
  const art = await loadAuditArtifacts(rt.pool, rt.cfg.artifactDir, audit, { completedAt: at.toISOString() });
  const llmR = await llmResultsFromDb(rt.pool, id, art, audit);
  let max: number | undefined;
  try { max = resolveConfig(process.env).max_audit_tokens; } catch { max = undefined; }
  let built: ReturnType<typeof buildReport>;
  try {
    built = buildReport(art, llmR?.llm ?? null, { generated_at: at.toISOString(), ...(max ? { max_audit_tokens: max } : {}) });
    await assertMatchesDb(rt, id, built.report);
  } catch (e) {
    // fail-closed: детальна причина — лише в лог worker; у БД/API — нейтральний текст
    rt.log("error", "generate_report: звіт заблоковано (контракт/guard/розбіжність з БД)", { audit: id, err: String((e as Error).message).slice(0, 600) });
    await withTx(rt.pool, async (c) => {
      await setStage(c, id, "report", "failed", "звіт заблоковано: не пройшов контракт або guard (fail-closed); користувачу не показується");
      await addWarning(c, id, { stage: "report", message: "звіт заблоковано перевіркою контракту/guard (fail-closed)" });
      await completeAudit(c, id, at);
    });
    return;
  }
  const { report } = built;
  const lang = report.audit.language;
  await withTx(rt.pool, async (c) => {
    for (const f of report.findings) {
      await c.query("UPDATE findings SET title = $3, problem = $4, why_it_matters = $5 WHERE audit_run_id = $1 AND id = $2", [id, f.id, renderText(f.title, report, lang), renderText(f.problem, report, lang), f.why_it_matters ? renderText(f.why_it_matters, report, lang) : null]);
      if (f.recommendation) {
        await c.query(
          "INSERT INTO recommendations (audit_run_id, id, finding_id, recommended_change, how_to_validate) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (audit_run_id, id) DO UPDATE SET recommended_change = EXCLUDED.recommended_change, how_to_validate = EXCLUDED.how_to_validate",
          [id, "rec_" + f.id.slice(4), f.id, renderText(f.recommendation.recommended_change, report, lang), renderText(f.recommendation.how_to_validate, report, lang)],
        );
      }
    }
    await saveReport(c, id, {
      report, sha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"), schema_version: report.schema_version, scoring_version: report.scoring_version,
      guard_version: report.guard.version, guard_events: report.guard.events, rejected: built.rejected, generated_at: report.generated_at,
    });
    await setStage(c, id, "report", "done", `знахідок ${report.findings.length}, позитивів ${report.positive_findings.length}, доказів ${report.evidence.length}`);
    await completeAudit(c, id, at);
  });
}

/** звіт і таблиця findings — один результат агрегації (той самий aggregate()); розбіжність = дефект → fail-closed */
async function assertMatchesDb(rt: Runtime, id: string, report: Report): Promise<void> {
  const rows = (await rt.pool.query("SELECT id, priority FROM findings WHERE audit_run_id = $1 ORDER BY id", [id])).rows as Array<{ id: string; priority: number }>;
  const want = report.findings.map((f) => `${f.id}:${f.priority.value}`).sort().join(",");
  const have = rows.map((r) => `${r.id}:${r.priority}`).sort().join(",");
  if (want !== have) throw new Error(`звіт ≠ findings у БД: ${want.slice(0, 120)} vs ${have.slice(0, 120)}`);
}
