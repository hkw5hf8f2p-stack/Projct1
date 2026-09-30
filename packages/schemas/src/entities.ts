/** Сутності SPEC §8 (+ §16 Task, §18 Scenario, §21–§22 Session, §35/§52 LlmCall). Варіанти/порівняння — `later.ts` (S6). */
import { z } from "zod";
import {
  AuditStage, AuditStatus, Category, LlmMode, PageType, StageStatus, TaskType, UnknownReason, Level,
  LLM_CALL_STATUSES, LLM_PROVIDERS, PROMPT_ID_RE, SESSION_SUCCESS, SEVERITY_LABELS, SESSION_STATUSES,
} from "./enums.js";
import { ERROR_CLASSES } from "./errors.js";

const Ts = z.string().datetime({ offset: true });
const Unit = z.number().min(0).max(1);
export const PromptVersion = z.string().regex(PROMPT_ID_RE, "prompt id виду site-profile-v1 (SPEC §52)");

// ---------------------------------------------------------------- AuditRun (§8, DEV-11)
export const StageState = z
  .object({ status: StageStatus, reason: z.string().min(1).optional(), updated_at: Ts.optional() })
  .strict()
  .refine((s) => s.status === "done" || s.reason !== undefined, { message: "skipped/budget_limited/failed потребують reason" });
/** частковий запис: етапи, до яких не дійшли, відсутні */
export const StageStatusMap = z.record(AuditStage, StageState);

export const AuditRun = z
  .object({
    id: z.string().min(1),
    input_url: z.string().url(),
    normalized_url: z.string().url(),
    domain: z.string().min(1),
    status: AuditStatus,
    created_at: Ts,
    started_at: Ts.nullable(),
    completed_at: Ts.nullable(),
    error: z.string().nullable(),
    prompt_version: z.string().nullable(),
    /** DEV-11 */
    llm_mode: LlmMode,
    stage_status: StageStatusMap,
    // §35 відтворюваність
    snapshot_at: Ts.nullable().optional(),
    llm_provider: z.enum(LLM_PROVIDERS).nullable().optional(),
    llm_model: z.string().nullable().optional(),
    /** MAX_PAGES, MAX_CRAWL_DEPTH, MAX_AUDIT_TOKENS, конфіг агента (§35 «agent configuration») */
    config_json: z.record(z.unknown()).optional(),
    /** ARTIFACT_TTL_DAYS: коли артефакти підлягають видаленню; `artifacts_deleted_at` — коли видалено */
    artifact_expires_at: Ts.nullable().optional(),
    artifacts_deleted_at: Ts.nullable().optional(),
    // ---- 002_pipeline.sql (DEV-55, DEV-68): мова звіту, лічильник токенів E4, клас помилки §48, часткові збої
    language: z.enum(["uk", "en"]).default("uk"),
    tokens_input: z.number().int().nonnegative().default(0),
    tokens_output: z.number().int().nonnegative().default(0),
    error_class: z.enum(ERROR_CLASSES).nullable().optional(),
    warnings: z.array(z.object({ stage: z.string().min(1), page_url: z.string().optional(), class: z.enum(ERROR_CLASSES).optional(), message: z.string().min(1) }).strict()).default([]),
    updated_at: Ts.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (r.status === "failed" && !r.error) bad("failed потребує error", ["error"]);
    if (r.status === "failed" && !r.error_class) bad("failed потребує error_class (§48; chk_audit_runs_failed_class)", ["error_class"]);
    if (r.status === "completed" && r.completed_at === null) bad("completed потребує completed_at", ["completed_at"]);
    // DEV-11: без LLM усі LLM-етапи skipped
    if (r.llm_mode === "none") {
      for (const st of ["site_profile", "tasks", "lenses", "scenario_matrix", "snapshot_sessions", "browser_sessions"] as const) {
        const s = r.stage_status[st];
        if (s && s.status !== "skipped") bad(`llm_mode=none: етап ${st} має бути skipped`, ["stage_status", st]);
      }
    }
  });
export type AuditRun = z.infer<typeof AuditRun>;

// ---------------------------------------------------------------- PageArtifact (§8)
const LinkRowLoose = z.object({ href: z.string(), abs: z.string(), text: z.string(), name: z.string(), visible: z.boolean() }).passthrough();

/** Форма, яку видає S1a (pages.json): audit_run_id і created_at ще null — проставляє імпорт у БД (S2) */
export const PageArtifactCapture = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().nullable(),
    url: z.string().url(),
    page_type: PageType,
    page_type_reason: UnknownReason.nullable(),
    title: z.string().nullable(),
    http_status: z.number().int().nullable(),
    desktop_screenshot: z.string().nullable(),
    mobile_screenshot: z.string().nullable(),
    dom_text: z.string().nullable(),
    aria_snapshot: z.string().nullable(),
    visible_text: z.string().nullable(),
    metadata_json: z.record(z.unknown()),
    links_json: z.array(LinkRowLoose),
    technical_json: z.record(z.unknown()),
    created_at: Ts.nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.page_type === "unknown" && p.page_type_reason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "page_type=unknown потребує page_type_reason (page-type-spec §4)", path: ["page_type_reason"] });
    }
    if (p.page_type !== "unknown" && p.page_type_reason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "page_type_reason лише для unknown", path: ["page_type_reason"] });
    }
  });
export type PageArtifactCapture = z.infer<typeof PageArtifactCapture>;

/** Збережений рядок: audit_run_id і created_at обов'язкові */
export const PageArtifact = PageArtifactCapture.and(z.object({ audit_run_id: z.string().min(1), created_at: Ts }));
export type PageArtifact = z.infer<typeof PageArtifact>;

// ---------------------------------------------------------------- Task (§16)
export const Task = z
  .object({
    /** у межах аудиту: `t1`… */
    task_id: z.string().min(1),
    audit_run_id: z.string().min(1).optional(),
    name: z.string().min(1),
    goal: z.string().min(1),
    success_conditions: z.array(z.string().min(1)).min(1),
    failure_conditions: z.array(z.string().min(1)),
    recommended_start_page: z.string().min(1),
    max_actions: z.number().int().min(1).max(30).default(8),
    /** SCORING_SPEC §10.1: LLM лише класифікує */
    task_type: TaskType,
    /** відповідає primary_conversion_goal → важлива задача (§10.1) */
    is_primary_goal: z.boolean().optional(),
  })
  .strict();
export type Task = z.infer<typeof Task>;

// ---------------------------------------------------------------- SiteProfile (§8, §15)
export const SiteProfile = z
  .object({
    audit_run_id: z.string().min(1),
    business_type: z.string().min(1),
    offering_summary: z.string().min(1),
    primary_products: z.array(z.string()),
    price_positioning: z.string(),
    primary_conversion_goal: z.string().min(1),
    secondary_conversion_goals: z.array(z.string()),
    site_language: z.string().min(2),
    apparent_geography: z.string(),
    brand_tone: z.string(),
    key_value_propositions: z.array(z.string()),
    trust_signals: z.array(z.string()),
    purchase_objections: z.array(z.string()),
    domain_terminology: z.array(z.string()),
    /** 4–7 задач (§16); у БД зберігаються в таблиці customer_tasks */
    customer_tasks: z.array(Task).min(4).max(7),
    confidence_notes: z.array(z.string()),
    prompt_version: PromptVersion.optional(),
    llm_call_id: z.string().nullable().optional(),
  })
  .strict();
export type SiteProfile = z.infer<typeof SiteProfile>;

// ---------------------------------------------------------------- BehavioralLens (§8)
/** 10 поведінкових змінних, 0.0–1.0; поля частки ринку немає (§8, рецензія) */
export const LENS_VARIABLES = [
  "category_knowledge", "price_sensitivity", "trust_requirement", "decision_speed", "detail_preference",
  "visual_sensitivity", "comparison_tendency", "risk_aversion", "convenience_priority", "social_proof_need",
] as const;
export const BehavioralLens = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    category_knowledge: Unit,
    price_sensitivity: Unit,
    trust_requirement: Unit,
    decision_speed: Unit,
    detail_preference: Unit,
    visual_sensitivity: Unit,
    comparison_tendency: Unit,
    risk_aversion: Unit,
    convenience_priority: Unit,
    social_proof_need: Unit,
    primary_goal: z.string().min(1),
    likely_questions: z.array(z.string()),
    likely_objections: z.array(z.string()),
    prompt_version: PromptVersion.optional(),
    llm_call_id: z.string().nullable().optional(),
  })
  .strict();
export type BehavioralLens = z.infer<typeof BehavioralLens>;

// ---------------------------------------------------------------- Scenario (§18, SCORING_SPEC §9–§10)
export const Scenario = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().min(1),
    lens_id: z.string().min(1),
    task_id: z.string().min(1),
    level: Level,
    /** r(lens, task) з SCORING_SPEC §10.1, детермінований */
    relevance: Unit,
    selected: z.boolean(),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------- SyntheticSession (§21–§22)
/** §21: лише стисла структура, жодного chain-of-thought */
export const AgentStep = z
  .object({
    action: z.string().min(1),
    target: z.string(),
    reason_summary: z.string().max(200),
    task_progress: z.string(),
    friction_detected: z.array(Category),
    /** внутрішнє, у формули не входить (SCORING_SPEC §2) */
    confidence: Unit.optional(),
  })
  .strict();
export type AgentStep = z.infer<typeof AgentStep>;

export const Friction = z
  .object({
    category: Category,
    /** мітка агента; числову severity ставить код (SCORING_SPEC §3) */
    severity: z.enum(SEVERITY_LABELS),
    /** цитата/посилання агента на побачене; не Evidence, доки код не звірить (S3) */
    evidence: z.string().min(1),
    page_url: z.string(),
  })
  .strict();

export const SyntheticSession = z
  .object({
    session_id: z.string().min(1),
    audit_run_id: z.string().min(1),
    lens_id: z.string().min(1),
    task_id: z.string().min(1),
    level: Level,
    status: z.enum(SESSION_STATUSES),
    success: z.enum(SESSION_SUCCESS),
    actions_used: z.number().int().nonnegative(),
    frictions: z.array(Friction),
    positive_signals: z.array(z.string()),
    uncertainties: z.array(z.string()),
    final_summary: z.string(),
    steps: z.array(AgentStep).optional(),
    llm_call_ids: z.array(z.string()).optional(),
    prompt_version: PromptVersion.optional(),
    /** 003_report.sql: шляхи сторінок, які бачила сесія (експозиція для lens_coverage) */
    pages_seen: z.array(z.string()).optional(),
  })
  .strict();
export type SyntheticSession = z.infer<typeof SyntheticSession>;

/** Структурований вихід LLM для сесії (SPEC §22) — без службових полів, без self_confirming */
export const SessionResultLlm = SyntheticSession.omit({
  audit_run_id: true, status: true, llm_call_ids: true, prompt_version: true, pages_seen: true,
});

// ---------------------------------------------------------------- LlmCall (§35, §52)
export const LlmCall = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().min(1).nullable(),
    stage: AuditStage,
    prompt_version: PromptVersion,
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().min(1),
    /** sha256 канонічного запиту; ключ кешу «identical model calls» (§35) */
    request_hash: z.string().regex(/^[0-9a-f]{64}$/),
    request_json: z.unknown().optional(),
    /** сирий структурований вихід (§35) */
    response_json: z.unknown().nullable(),
    status: z.enum(LLM_CALL_STATUSES),
    error: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    latency_ms: z.number().int().nonnegative().nullable(),
    created_at: Ts,
  })
  .strict();
export type LlmCall = z.infer<typeof LlmCall>;
