import { AuditRun } from "@sitelens/schemas";
import type { AuditStage, StageStatus } from "../types.js";
import type { LlmClient } from "../client.js";
import type { PageInput } from "../page-input.js";
import { resolveAuditLanguage } from "../page-input.js";
import { buildScenarioMatrix } from "./build-scenario-matrix.js";
import { buildSiteProfile } from "./build-site-profile.js";
import { generateLenses } from "./generate-lenses.js";
import { generateTasks } from "./generate-tasks.js";
import type { Task } from "@sitelens/schemas";
import type { LensesOutput } from "./generate-lenses.js";
import type { MatrixOutput } from "./build-scenario-matrix.js";
import { notRun, type StageResult } from "./types.js";

export interface PipelineResult {
  language: "uk" | "en";
  stages: { site_profile: StageResult<unknown>; tasks: StageResult<unknown>; lenses: StageResult<unknown>; scenario_matrix: StageResult<unknown> };
  stage_status: Partial<Record<AuditStage, { status: StageStatus; reason?: string }>>;
  llm_mode: "live" | "replay" | "none";
  budget: ReturnType<LlmClient["budget"]["snapshot"]>;
  /** серіалізовані вихідні об'єкти (те, що worker збереже) */
  stored: { profile?: unknown; tasks?: unknown; lenses?: unknown; scenarios?: unknown; journals?: unknown };
}

/**
 * Композиція чотирьох етапів для інтеграційних тестів; worker S2 викликає кожен етап окремо (README).
 * Якщо етап не `done`, залежні етапи `skipped` з причиною — рішення приймає код, аудит все одно завершується (DEV-11).
 */
export async function runLlmStages(o: { audit_run_id: string; client: LlmClient; pages: readonly PageInput[]; language?: string; lens_count?: number; llm_mode: "live" | "replay" | "none" }): Promise<PipelineResult> {
  const language = resolveAuditLanguage(o.language, o.pages);
  const ctx = { audit_run_id: o.audit_run_id, client: o.client, language };
  const profile = await buildSiteProfile(ctx, { pages: o.pages });
  const why = (name: string) => (o.client.mode === "none" ? "no LLM provider" : `upstream ${name} не завершено`);
  const tasks: StageResult<{ tasks: Task[] }> = profile.output
    ? await generateTasks(ctx, { pages: o.pages, profile: profile.output.profile })
    : notRun("tasks", null, "skipped", why("site_profile"));
  const lenses: StageResult<LensesOutput> = profile.output
    ? await generateLenses(ctx, { profile: profile.output.profile, k: o.lens_count })
    : notRun("lenses", null, "skipped", why("site_profile"));
  const matrix: StageResult<MatrixOutput> = tasks.output && lenses.output
    ? await buildScenarioMatrix(ctx, { lenses: lenses.output.lenses, tasks: tasks.output.tasks })
    : notRun("scenario_matrix", null, "skipped", why("tasks/lenses"));
  const stages = { site_profile: profile, tasks, lenses, scenario_matrix: matrix } as PipelineResult["stages"];
  const stage_status: PipelineResult["stage_status"] = {};
  for (const [k, r] of Object.entries(stages)) stage_status[k as AuditStage] = r.reason ? { status: r.status, reason: r.reason } : { status: r.status };
  return {
    language, stages, stage_status, llm_mode: o.llm_mode, budget: o.client.budget.snapshot(),
    stored: {
      profile: profile.output ? { ...profile.output.profile, audit_run_id: o.audit_run_id, prompt_version: profile.output.prompt_id, customer_tasks: tasks.output ? tasks.output.tasks : undefined } : undefined,
      tasks: tasks.output ?? undefined, lenses: lenses.output ?? undefined,
      scenarios: matrix.output ? matrix.output.scenarios : undefined, journals: matrix.output ? matrix.output.journal_scenarios : undefined,
    },
  };
}

/** Мінімальний AuditRun (для перевірки схемою DEV-11): аудит завершується, навіть якщо LLM-етапи skipped/budget_limited */
export function toAuditRunRecord(o: { id: string; url: string; llm_mode: "live" | "replay" | "none"; stage_status: PipelineResult["stage_status"]; provider?: string | null; model?: string | null; config_json?: Record<string, unknown>; now?: Date }): AuditRun {
  const t = (o.now ?? new Date()).toISOString();
  const u = new URL(o.url);
  return AuditRun.parse({
    id: o.id, input_url: o.url, normalized_url: u.toString(), domain: u.host, status: "completed", created_at: t, started_at: t, completed_at: t, error: null,
    prompt_version: null, llm_mode: o.llm_mode,
    stage_status: Object.fromEntries(Object.entries(o.stage_status).map(([k, v]) => [k, { ...v, updated_at: t }])),
    llm_provider: o.provider === "anthropic" || o.provider === "openai" || o.provider === "replay" ? o.provider : null, llm_model: o.model ?? null, config_json: o.config_json ?? {},
  });
}
