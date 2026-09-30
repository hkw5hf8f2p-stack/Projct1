/**
 * Схеми ВИХОДУ LLM для етапів S4: snapshot-оцінка (§19A), крок браузерного агента (§19B/§20–§21), тексти знахідок (§24).
 * Без `.optional()` (OpenAI strict → nullable). Числа модель не ставить: у полях немає числових значень, крім `confidence` агента
 * (внутрішнє, у формули не входить — SCORING_SPEC §2). Службові поля й ключі finding_key проставляє код.
 */
import { z } from "zod";
import { Category, CLAIM_KINDS_BY_CATEGORY, SEVERITY_LABELS, SESSION_SUCCESS } from "@sitelens/schemas";

export const SNAPSHOT_VERDICTS = ["no_issue", "issues_found", "cannot_judge"] as const;
export const AGENT_ACTIONS = ["click", "scroll", "back", "navigate_internal_link", "stop_success", "stop_failure"] as const;
export const SEMANTIC_ROLES = ["link", "button", "tab", "menuitem", "checkbox", "radio", "option", "heading", "textbox", "combobox", "img", "text", "label"] as const;
/** claim_kind для промпту: закритий список на категорію + `general` (SCORING_SPEC §5); axe-правила LLM не пише */
export const CLAIM_KIND_LIST: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(CLAIM_KINDS_BY_CATEGORY).filter(([c]) => c !== "accessibility").map(([c, ks]) => [c, ["general", ...ks]]),
);

const Short = (max: number) => z.string().min(1).max(max);

/** friction: evidence — `"дослівна цитата"` або `NOT_FOUND: чого бракує` (код звіряє, §23) */
export const FrictionLlm = z.object({
  category: Category,
  claim_kind: Short(40),
  severity: z.enum(SEVERITY_LABELS),
  evidence: z.string().min(3).max(400),
  page_url: Short(500),
}).strict();
export type FrictionLlm = z.infer<typeof FrictionLlm>;

export const SnapshotFrictionLlm = FrictionLlm.omit({ page_url: true }).extend({ tile_id: Short(12) }).strict();

export const SnapshotEvalLlm = z.object({
  verdict: z.enum(SNAPSHOT_VERDICTS),
  noticed: z.array(Short(200)).max(6),
  understood: z.array(Short(200)).max(6),
  unclear: z.array(Short(200)).max(6),
  likely_next_action: Short(200),
  frictions: z.array(SnapshotFrictionLlm).max(6),
  positive_signals: z.array(Short(200)).max(4),
  uncertainties: z.array(Short(200)).max(4),
  success: z.enum(SESSION_SUCCESS),
  final_summary: Short(400),
}).strict();
export type SnapshotEvalLlm = z.infer<typeof SnapshotEvalLlm>;

export const AgentStepLlm = z.object({
  action: z.enum(AGENT_ACTIONS),
  /** семантичний локатор `role:"accessible name"` (click, navigate_internal_link), `down|up|top` (scroll), `` (back, stop_*) */
  target: z.string().max(200),
  reason_summary: z.string().max(200),
  task_progress: Short(200),
  friction_detected: z.array(Category).max(4),
  confidence: z.number().min(0).max(1),
}).strict();

export const AgentResultLlm = z.object({
  success: z.enum(SESSION_SUCCESS),
  frictions: z.array(FrictionLlm).max(6),
  positive_signals: z.array(Short(200)).max(4),
  uncertainties: z.array(Short(200)).max(4),
  final_summary: Short(400),
}).strict();
export type AgentResultLlm = z.infer<typeof AgentResultLlm>;

export const AgentTurnLlm = z.object({ step: AgentStepLlm, result: AgentResultLlm.nullable() }).strict();
export type AgentTurnLlm = z.infer<typeof AgentTurnLlm>;

// ------------------------------------------------------------------ тексти знахідки (§24): числа — лише плейсхолдери
export const FINDING_PLACEHOLDERS = ["page_count", "instances", "priority", "lens_coverage", "session_frequency", "task_coverage"] as const;
export const FindingTextLlm = z.object({
  verdict: z.enum(["supported", "not_supported"]),
  title: z.string().max(120),
  problem: z.string().max(400),
  why_it_matters: z.string().max(300),
}).strict();
export type FindingTextLlm = z.infer<typeof FindingTextLlm>;

export const RecommendationLlm = z.object({
  verdict: z.enum(["supported", "not_supported"]),
  recommended_change: z.string().max(400),
  how_to_validate: z.string().max(400),
}).strict();
export type RecommendationLlm = z.infer<typeof RecommendationLlm>;

// ------------------------------------------------------------------ семантичний локатор (§11)
export interface SemanticTarget { role: (typeof SEMANTIC_ROLES)[number]; name: string }
const TARGET_RE = new RegExp(`^(${SEMANTIC_ROLES.join("|")}):"([^"]{1,150})"$`, "u");
const COORDS_RE = /(?:^|[^\p{L}\p{N}])(?:x|y|left|top)\s*[=:]\s*-?\d|-?\d+\s*,\s*-?\d+|\d+\s?px|(?:^|[^\p{L}\p{N}])(?:coords?|coordinates|pixel)/iu;
const CSS_RE = /^[.#[]|>\s|::|\[[a-z-]+=|nth-child|\/\/[a-z*]/iu;
/** `role:"name"` → локатор; координати, CSS/XPath, «сирі» URL → null (§11: жодних координат від LLM) */
export function parseSemanticTarget(t: string): SemanticTarget | null {
  const s = t.trim();
  if (COORDS_RE.test(s) || CSS_RE.test(s)) return null;
  const m = TARGET_RE.exec(s);
  if (!m) return null;
  return { role: m[1] as SemanticTarget["role"], name: m[2] as string };
}
export const SCROLL_TARGETS = ["down", "up", "top"] as const;
