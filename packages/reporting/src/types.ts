/** Вхід buildReport: артефакти аудиту (S1a/S2) + необов'язкові результати LLM (S3). */
import type { Evidence, PAGE_TYPES, AUDIT_STAGES, STAGE_STATUSES } from "@sitelens/schemas";
import type { SessionObs } from "@sitelens/scoring";

export type VP = "D" | "M";
export type PageType = (typeof PAGE_TYPES)[number];
export type Lang = "uk" | "en";

/** підмножина capture.json S1a, яку читають позитивні предикати */
export interface CaptureLite {
  width: number;
  height: number;
  buttons: Array<{ name: string; visible: boolean; rect: { x: number; y: number; w: number; h: number } }>;
  price_candidates: Array<{ in_fv: boolean; excluded: boolean; text?: string; rect: { x: number; y: number; w: number; h: number } }>;
  visible_text: string;
  overflow: { client_width: number; scroll_width: number };
  images: Array<{ alt: string | null; is_background: boolean }>;
}

export interface PageIn {
  id: string;
  url: string;
  path: string;
  page_type: PageType;
  page_type_reason: "capture" | "product_likely" | null;
  capture: Partial<Record<VP, { capture_complete: boolean; incomplete_reasons: string[] }>>;
  viewport: Partial<Record<VP, { w: number; h: number }>>;
  captures: Partial<Record<VP, CaptureLite>>;
  screenshot: Partial<Record<VP, string>>;
}

export interface CoverageRowIn { detector_id: string; page: string; page_type: PageType; status: "not_applicable" | "withheld" | "capped"; reason: string }
export interface AxeGroupIn { rule: string; page_group: string; component: string; instances: number; impact: string | null; viewports: VP[]; pages: string[] }

export interface LighthouseIn {
  status: "done" | "partial" | "not_run" | "failed";
  reason: string | null;
  runs: Array<{ page_url: string; form_factor: "mobile" | "desktop"; status: "done" | "failed"; scores: { performance: number | null; accessibility: number | null; best_practices: number | null; seo: number | null }; metrics: { lcp_ms: number | null; tbt_ms: number | null; cls: number | null; fcp_ms: number | null } }>;
}

export interface AuditIn {
  id: string;
  input_url: string;
  normalized_url: string;
  domain: string;
  language: Lang;
  status: "completed" | "failed" | "aggregating";
  created_at: string | null;
  completed_at: string | null;
  snapshot_at: string | null;
  stage_status: Partial<Record<(typeof AUDIT_STAGES)[number], { status: (typeof STAGE_STATUSES)[number]; reason: string | null }>>;
}

export interface AuditArtifacts {
  audit: AuditIn;
  pages: PageIn[];
  evidence: Evidence[];
  coverage: CoverageRowIn[];
  axe_groups: AxeGroupIn[];
  axe_version: string | null;
  lighthouse: LighthouseIn | null;
}

/**
 * LLM-текст до структурної перевірки. Числа — лише плейсхолдери зі словника FINDING_VARS (підставляє код);
 * будь-яка цифра чи числівник → текст відхилено, замість нього — шаблон коду (DEV-58).
 */
export interface LlmText { text: string; source_class: "INFERRED" | "SYNTHETIC"; prompt_id: string; guard_status: "passed" | "regenerated" | "sentences_removed" | "pending"; guard_attempts?: number; guard_rule_ids?: string[] }

export interface LlmResults {
  mode: "live" | "replay";
  provider: "anthropic" | "openai" | "openai_compatible" | "claude_cli" | "replay" | "session";
  model: string;
  prompt_versions: string[];
  evidence: Evidence[];
  evidence_text: Record<string, LlmText>;
  sessions: SessionObs[];
  finding_texts: Record<string, Partial<Record<"title" | "problem" | "why_it_matters" | "recommended_change" | "how_to_validate", LlmText>>>;
  site_understanding: null | { what_it_sells: LlmText; positioning: LlmText; price_positioning: LlmText; core_value_proposition: LlmText; primary_customer_journey: LlmText; likely_objections: LlmText[] };
  primary_conversion_goal: LlmText | null;
  summary: LlmText | null;
  lenses: Array<{ id: string; name: LlmText; description: LlmText; poles: Array<"P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7"> }>;
  pole_unmet: Array<{ pole: "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7"; nearest_lens_id: string | null }>;
  budget: { max_audit_tokens: number; used_tokens: number; billed_tokens: number; cache_read_tokens: number; llm_calls: number; cost: null | { amount: number; currency: "USD"; price_date: string; price_source: string } };
  /** негатив детектора того самого claim_kind (правило суперечності) — ключ finding_key */
  counter?: Record<string, Evidence[]>;
}

export interface BuildOptions {
  generated_at: string;
  provenance?: { kind: "audit" | "example_fixture"; note: string | null };
  /** DEV-44: MAX_AUDIT_TOKENS за замовчуванням */
  max_audit_tokens?: number;
}
