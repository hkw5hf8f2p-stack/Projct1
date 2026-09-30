/** Форми API S2 (SPEC §42): вхід і вихід. Жодного LLM-тексту в S2-відповідях (guard звіту — S4). */
import { z } from "zod";
import { AuditStatus, LlmMode } from "./enums.js";
import { ERROR_CLASSES } from "./errors.js";

export const ErrorClassEnum = z.enum(ERROR_CLASSES);
/** DEV-93: «швидкий» аудит (менше сторінок/лінз/сесій) або повний (типово). Числа профілів — MODE_PROFILES (одне джерело для API, worker і UI). */
export const AuditMode = z.enum(["quick", "full"]);
export type AuditMode = z.infer<typeof AuditMode>;
export const MODE_PROFILES = {
  quick: { max_pages: 6, lens_count: 6, snapshot_sessions: 12, journals_max: 2 },
  full: { max_pages: null, lens_count: 12, snapshot_sessions: null, journals_max: null },
} as const;
export const CreateAuditRequest = z.object({ url: z.string().min(1).max(2048), language: z.enum(["uk", "en"]).optional(), mode: AuditMode.optional() }).strict();
export const CreateAuditResponse = z.object({ auditId: z.string().regex(/^aud_[0-9a-f]{16}$/) });
export const ApiError = z.object({ error: z.object({ class: ErrorClassEnum.or(z.enum(["unauthorized", "rate_limited", "not_found", "bad_request", "internal", "report_not_ready", "report_unavailable"])), message: z.string().min(1) }) });

export const AuditWarning = z.object({ stage: z.string(), page_url: z.string().optional(), class: ErrorClassEnum.optional(), message: z.string() });
/** DEV-92: детальні лічильники етапів. Лічильники монотонні (done не спадає); total може з'явитись пізніше (null → невідомо); approx — верхня межа/оцінка. */
export const PROGRESS_STEP_IDS = ["discovering_pages", "capturing", "technical_checks", "understanding_offering", "building_lenses", "testing_journeys", "aggregating_evidence", "preparing_report"] as const;
export const ProgressStepId = z.enum(PROGRESS_STEP_IDS);
export const STEP_COUNTER_UNITS = ["pages", "lighthouse", "accessibility", "llm_calls", "lenses", "snapshot_sessions", "journals"] as const;
export const StepCounter = z.object({ unit: z.enum(STEP_COUNTER_UNITS), done: z.number().int().min(0), total: z.number().int().min(0).nullable(), approx: z.boolean().optional() });
export const StepDetail = z.object({
  id: ProgressStepId,
  counters: z.array(StepCounter),
  /** оцінка за середньою тривалістю завершених задач ЦЬОГО етапу в ЦЬОМУ аудиті; null — даних немає (не вигадуємо) */
  eta_seconds: z.number().int().min(0).nullable(),
  /** коли етап розпочався (за часом завершення попередніх етапів) — для «працює N хв»; null — ще не почався/невідомо */
  started_at: z.string().nullable(),
});
export type StepDetail = z.infer<typeof StepDetail>;

export const AuditStatusResponse = z.object({
  id: z.string(),
  status: AuditStatus,
  input_url: z.string(),
  normalized_url: z.string(),
  language: z.enum(["uk", "en"]),
  llm_mode: LlmMode,
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  stage_status: z.record(z.unknown()),
  progress: z.object({
    pages_captured: z.number().int(), pages_failed: z.number().int(), lighthouse_done: z.number().int(), lighthouse_failed: z.number().int(),
    /** S4: сценарії симуляції (snapshot + журнали): виконано / очікувано */
    scenarios_done: z.number().int().optional(), scenarios_total: z.number().int().optional(),
  }),
  /** SPEC §43: 8 кроків прогресу для UI */
  steps: z.array(z.object({ id: ProgressStepId, state: z.enum(["pending", "active", "done", "skipped", "budget_limited", "failed"]) })).optional(),
  step_details: z.array(StepDetail).optional(),
  mode: AuditMode.optional(),
  /** паралельність LLM цього аудиту (знімок на момент створення) */
  llm_concurrency: z.number().int().min(1).max(6).optional(),
  warnings: z.array(AuditWarning),
  error: z.object({ class: ErrorClassEnum, message: z.string() }).nullable(),
  artifacts_deleted: z.boolean(),
  artifact_expires_at: z.string().nullable(),
});
