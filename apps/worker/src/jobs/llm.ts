/**
 * LLM-етапи як задачі черги за сигнатурами @sitelens/llm (build_site_profile → generate_tasks → generate_lenses → build_scenario_matrix).
 * S2 (DEV-11, G0-2): llm_mode=none за замовчуванням → етап `skipped: no LLM provider`, аудит завершується. Якщо провайдер налаштовано —
 * S2 НЕ викликає модель: збереження виходів етапів (site_profiles/customer_tasks/behavioral_lenses/scenarios) підключає S4; без нього
 * виклик витратив би токени даремно. Тому етап `skipped` з чесною причиною. Шлях none перевірено; шлях live/replay — неперевірений (S4).
 */
import type { Job } from "pg-boss";
import { Q, advanceStatus, enqueue, setStage, type JobData, type QueueName } from "@sitelens/pipeline";
import { buildSiteProfile, createClientFromEnv, loadPagesFromArtifacts } from "@sitelens/llm";
import { auditDir } from "@sitelens/pipeline";
import type { Runtime } from "../runtime.js";
import { liveAudit } from "./common.js";

interface Spec { stage: "site_profile" | "tasks" | "lenses" | "scenario_matrix"; status: "profiling" | "generating_lenses" | "running_scenarios"; next: QueueName; upstream: string | null }
export const LLM_JOBS: Record<string, Spec> = {
  [Q.profile]: { stage: "site_profile", status: "profiling", next: Q.tasks, upstream: null },
  [Q.tasks]: { stage: "tasks", status: "profiling", next: Q.lenses, upstream: "site_profile" },
  [Q.lenses]: { stage: "lenses", status: "generating_lenses", next: Q.matrix, upstream: "site_profile" },
  [Q.matrix]: { stage: "scenario_matrix", status: "running_scenarios", next: Q.aggregate, upstream: "tasks/lenses" },
};

export async function llmStageJob(rt: Runtime, name: string, job: Job<JobData>): Promise<void> {
  const spec = LLM_JOBS[name]!;
  const id = job.data.auditRunId;
  const audit = await liveAudit(rt, id);
  if (!audit) return;
  await advanceStatus(rt.pool, id, spec.status);
  if (!audit.stage_status[spec.stage]) {
    const { client } = createClientFromEnv(process.env);
    if (client.mode !== "none") {
      await setStage(rt.pool, id, spec.stage, "skipped", "провайдер LLM налаштовано, але збереження виходів етапів підключається в S4; S2 модель не викликає (неперевірено)");
    } else if (spec.upstream === null) {
      // реальний виклик сигнатури: у режимі none етап сам повертає skipped (перевірка контракту packages/llm)
      const pages = (() => { try { return loadPagesFromArtifacts(auditDir(rt.cfg.artifactDir, id)); } catch { return []; } })();
      const r = await buildSiteProfile({ audit_run_id: id, client, language: audit.language }, { pages });
      await setStage(rt.pool, id, spec.stage, r.status, r.reason ?? "no LLM provider");
    } else {
      await setStage(rt.pool, id, spec.stage, "skipped", "no LLM provider");
    }
  }
  await enqueue(rt.boss, spec.next, { auditRunId: id });
}
