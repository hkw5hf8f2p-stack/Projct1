/**
 * Схеми ВИХОДУ LLM для етапів S3. Похідні від @sitelens/schemas (сутності не змінюються, DEV-41):
 * службові поля (audit_run_id, prompt_version, llm_call_id) проставляє код; `.optional()` немає (OpenAI strict → nullable).
 */
import { z } from "zod";
import { BehavioralLens, LENS_VARIABLES, SiteProfile, TASK_TYPES } from "@sitelens/schemas";

/** поля профілю, які можуть посилатись на докази */
export const PROFILE_EVIDENCE_FIELDS = [
  "business_type", "offering_summary", "primary_products", "price_positioning", "primary_conversion_goal", "secondary_conversion_goals",
  "apparent_geography", "brand_tone", "key_value_propositions", "trust_signals", "purchase_objections", "domain_terminology",
] as const;

export const EvidenceRef = z.object({
  field: z.enum(PROFILE_EVIDENCE_FIELDS),
  page_id: z.string().min(1),
  /** дослівна цитата з title/meta/заголовків/видимого тексту сторінки — код звіряє */
  quote: z.string().min(3).max(300),
}).strict();

/** SiteProfile без customer_tasks (їх дає етап generate_tasks) і без службових полів + посилання на докази */
export const SiteProfileLlm = SiteProfile.omit({ audit_run_id: true, customer_tasks: true, prompt_version: true, llm_call_id: true })
  .extend({ evidence: z.array(EvidenceRef).min(1).max(60) });
export type SiteProfileLlm = z.infer<typeof SiteProfileLlm>;
export type SiteProfileCore = Omit<SiteProfileLlm, "evidence">;

export const TaskLlm = z.object({
  task_id: z.string().min(1).max(20),
  name: z.string().min(3).max(120),
  goal: z.string().min(3).max(400),
  success_conditions: z.array(z.string().min(1).max(300)).min(1).max(6),
  failure_conditions: z.array(z.string().min(1).max(300)).max(6),
  /** id сторінки зі списку наданих сторінок */
  recommended_start_page: z.string().min(1),
  max_actions: z.number().int().min(1).max(30),
  task_type: z.enum(TASK_TYPES),
  is_primary_goal: z.boolean(),
}).strict();
export const TasksLlm = z.object({ tasks: z.array(TaskLlm).min(4).max(7) }).strict();
export type TasksLlm = z.infer<typeof TasksLlm>;

const Var = z.union([z.number().min(0).max(1), z.literal("unknown")]);
const lensVarShape = Object.fromEntries(LENS_VARIABLES.map((k) => [k, Var])) as Record<(typeof LENS_VARIABLES)[number], typeof Var>;
export const LensCandidate = z.object({
  id: z.string().min(1).max(20),
  name: z.string().min(2).max(80),
  description: z.string().min(3).max(500),
  ...lensVarShape,
  primary_goal: z.string().min(3).max(300),
  likely_questions: z.array(z.string().min(1).max(200)).max(6),
  likely_objections: z.array(z.string().min(1).max(200)).max(6),
}).strict();
export type LensCandidate = z.infer<typeof LensCandidate>;
/** для JSON-схеми провайдера (сувора форма) */
export const LensCandidatesLlm = z.object({ lenses: z.array(LensCandidate).min(1).max(30) }).strict();
/** для розбору: елементи перевіряються окремо (поганий кандидат відкидається з позначкою, не валить весь набір) */
export const LensCandidatesLenient = z.object({ lenses: z.array(z.unknown()).min(1).max(30) }).strict();

export const LENS_MIN = 8, LENS_MAX = 20, LENS_DEFAULT = 12, LENS_CANDIDATES = 18;

/** кандидат → BehavioralLens (unknown → 0.5 + прапорець, SCORING_SPEC §9.1) */
export function candidateToLens(c: LensCandidate, audit_run_id: string): { lens: BehavioralLens; flags: string[] } {
  const flags: string[] = [];
  const vars: Record<string, number> = {};
  for (const k of LENS_VARIABLES) {
    const v = c[k];
    if (v === "unknown") { vars[k] = 0.5; flags.push(`unknown_var:${c.id}:${k}`); } else vars[k] = v;
  }
  const lens = BehavioralLens.parse({
    id: c.id, audit_run_id, name: c.name, description: c.description, ...vars,
    primary_goal: c.primary_goal, likely_questions: c.likely_questions, likely_objections: c.likely_objections,
  });
  return { lens, flags };
}
