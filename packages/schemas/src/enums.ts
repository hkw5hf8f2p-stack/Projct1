/**
 * Закриті enum-и SiteLens. Єдине джерело для Zod-схем і для SQL-міграції (тест `migration-consistency`
 * звіряє CHECK-списки в packages/db/migrations із цими масивами).
 * Джерела: SPEC §8, §22, §23, §27; SCORING_SPEC §1–§5; DEV-11, DEV-19.
 */
import { z } from "zod";

const e = <const T extends readonly [string, ...string[]]>(v: T): T => v;

export const SOURCE_CLASSES = e(["OBSERVED", "BENCHMARKED", "INFERRED", "SYNTHETIC"]);
export const EVIDENCE_TYPES = e(["screenshot", "dom", "accessibility", "lighthouse", "axe", "browser_session", "repeated_agent_observation"]);
/** SCORING_SPEC §1.2 (+ ET-INC, DEV-19). ET-SUP — не рівень сили, а опорний факт. */
export const EVIDENCE_TIERS = e(["ET-DET", "ET-BRW", "ET-SYN-M", "ET-SYN-1", "ET-INF", "ET-INC", "ET-SUP"]);
/** SCORING_SPEC §2: родини доказів */
export const EVIDENCE_FAMILIES = e(["F-DET", "F-SUP", "F-BRW", "F-SYN", "F-INF", "F-INC"]);
export const CONFIDENCES = e(["VERIFIED", "STRONG_HYPOTHESIS", "HYPOTHESIS"]);
/** значення `evidence_strength` (SCORING_SPEC §1.2); 0.4 — ET-SYN-1 */
export const EVIDENCE_STRENGTHS = [1, 0.9, 0.7, 0.4, 0.3] as const;
/** SPEC §22: дозволені категорії frictions = категорії знахідок */
export const CATEGORIES = e([
  "value_proposition", "navigation", "product_selection", "pricing", "trust", "shipping", "terminology",
  "visual_hierarchy", "cta", "mobile_usability", "performance", "accessibility", "content_overload",
  "missing_information", "comparison", "checkout", "other",
]);
/** актуальний набір класифікатора S1a (packages/browser/src/audit/types.ts, page-type-spec) */
export const PAGE_TYPES = e(["homepage", "category", "product", "cart", "checkout", "info_shipping", "about", "faq", "other", "unknown"]);
export const UNKNOWN_REASONS = e(["capture", "product_likely"]);
/** S1a пише "D" | "M" у EvidenceRow.viewport */
export const VP_CODES = e(["D", "M"]);
export const ASSERTIONS = e(["presence", "absence"]);
export const LEVELS = e(["snapshot", "journey"]);
export const BROWSER_FAILURE_KINDS = e(["not_actionable", "obscured", "http_error", "nav_timeout", "blocked_overlay"]);
/** SPEC §8 AuditRun.status */
export const AUDIT_STATUSES = e(["queued", "crawling", "profiling", "generating_lenses", "running_scenarios", "aggregating", "completed", "failed"]);
/** DEV-11 */
export const LLM_MODES = e(["live", "replay", "none"]);
export const STAGE_STATUSES = e(["done", "skipped", "budget_limited", "failed"]);
/** етапи для `stage_status` (SPEC §47, згруповано; ключ = етап, значення = StageState) */
export const AUDIT_STAGES = e([
  "crawl", "capture", "lighthouse", "accessibility", "site_profile", "tasks", "lenses",
  "scenario_matrix", "snapshot_sessions", "browser_sessions", "aggregate", "report",
]);
/** SCORING_SPEC §4.1 FUN-STAGE */
export const FUNNEL_STAGES = e(["landing", "understand_offering", "browse", "select", "evaluate_product", "price_shipping_confidence", "cart"]);
/** SCORING_SPEC §10.1 */
export const TASK_TYPES = e(["understand_offering", "suitability", "choose_between", "total_price", "delivery", "credibility", "add_to_cart", "other"]);
/** SPEC §22 success: true | false | partial */
export const SESSION_SUCCESS = e(["true", "false", "partial"]);
export const SEVERITY_LABELS = e(["low", "medium", "high"]);
export const SESSION_STATUSES = e(["pending", "running", "done", "failed"]);
export const LLM_CALL_STATUSES = e(["ok", "error", "cached"]);
export const LLM_PROVIDERS = e(["anthropic", "openai", "openai_compatible", "claude_cli", "replay", "session"]);
/** SPEC §52 prompt ids — префікс; версія в суфіксі */
export const PROMPT_ID_RE = /^[a-z][a-z0-9-]*-v\d+$/;

export const SourceClass = z.enum(SOURCE_CLASSES);
export const EvidenceType = z.enum(EVIDENCE_TYPES);
export const EvidenceTier = z.enum(EVIDENCE_TIERS);
export const EvidenceFamily = z.enum(EVIDENCE_FAMILIES);
export const Confidence = z.enum(CONFIDENCES);
export const Category = z.enum(CATEGORIES);
export const PageType = z.enum(PAGE_TYPES);
export const UnknownReason = z.enum(UNKNOWN_REASONS);
export const VpCode = z.enum(VP_CODES);
export const Assertion = z.enum(ASSERTIONS);
export const Level = z.enum(LEVELS);
export const AuditStatus = z.enum(AUDIT_STATUSES);
export const LlmMode = z.enum(LLM_MODES);
export const StageStatus = z.enum(STAGE_STATUSES);
export const AuditStage = z.enum(AUDIT_STAGES);
export const FunnelStage = z.enum(FUNNEL_STAGES);
export const TaskType = z.enum(TASK_TYPES);
export const EvidenceStrength = z.union([z.literal(1), z.literal(0.9), z.literal(0.7), z.literal(0.4), z.literal(0.3)]);

/**
 * `claim_kind` — закритий enum на категорію (SCORING_SPEC §5); LLM обирає зі списку, інакше `general`.
 * Список — те, що є в специфікації й у детекторах S1a; розширюється версією scoring-vN.
 * `axe:<rule-id>` — окремий шаблон (категорія accessibility).
 */
export const CLAIM_KINDS_BY_CATEGORY: Record<(typeof CATEGORIES)[number], readonly string[]> = {
  shipping: ["not_on_product_page", "collapsed_hidden", "cost_unknown", "time_unknown", "deep_link_only"],
  pricing: ["not_in_first_viewport", "only_in_cart", "total_unclear"],
  cta: ["below_fold", "ambiguous_label", "competing_ctas"],
  accessibility: [],
  mobile_usability: ["horizontal_overflow"],
  performance: ["oversized_image"],
  value_proposition: [], navigation: [], product_selection: [], trust: [], terminology: [], visual_hierarchy: [],
  content_overload: [], missing_information: [], comparison: [], checkout: [], other: [],
};
/**
 * DEV-68: claim_kind, який видає лише детектор/інструмент (Lighthouse); LLM його не пропонується (sim-schemas читає лише CLAIM_KINDS_BY_CATEGORY),
 * тому окремий від закритого списку категорії. Lighthouse-доказ: category performance | accessibility, claim_kind lighthouse_category_score.
 */
export const DETECTOR_ONLY_CLAIM_KINDS: Partial<Record<(typeof CATEGORIES)[number], readonly string[]>> = {
  performance: ["lighthouse_category_score"],
  accessibility: ["lighthouse_category_score"],
};
export const AXE_CLAIM_RE = /^axe:[a-z0-9][a-z0-9-]*$/;
export const GENERAL_CLAIM = "general";
export const ALL_CLAIM_KINDS: ReadonlySet<string> = new Set([GENERAL_CLAIM, ...Object.values(CLAIM_KINDS_BY_CATEGORY).flat(), ...Object.values(DETECTOR_ONLY_CLAIM_KINDS).flat()]);

export const isClaimKind = (s: string): boolean => ALL_CLAIM_KINDS.has(s) || AXE_CLAIM_RE.test(s);
/** claim_kind допустимий для категорії: свій список, `general`, або `axe:*` лише в accessibility */
export const isClaimKindFor = (category: (typeof CATEGORIES)[number], s: string): boolean =>
  s === GENERAL_CLAIM || CLAIM_KINDS_BY_CATEGORY[category].includes(s) || (DETECTOR_ONLY_CLAIM_KINDS[category] ?? []).includes(s) || (category === "accessibility" && AXE_CLAIM_RE.test(s));
export const ClaimKind = z.string().refine(isClaimKind, { message: "unknown claim_kind (not in closed enum, not axe:<rule>, not general)" });

/** твердження відсутності (DEV-17): claim_kind, що стверджують «немає» */
export const ABSENCE_CLAIM_KINDS: ReadonlySet<string> = new Set([
  "not_in_first_viewport", "not_on_product_page", "deep_link_only", "only_in_cart", "cost_unknown", "time_unknown",
  "absent_in_first_viewport", "absent_on_page", "not_found_within_depth",
]);
/** позиційні твердження, що залежать від відкритого банера (DEV-19) */
export const POSITIONAL_CLAIM_KINDS: ReadonlySet<string> = new Set(["below_fold", "not_in_first_viewport"]);
