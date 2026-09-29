/** Типи наскрізного аудиту S1a. Форма рядків — PageArtifact (SPEC §8) і Evidence (SPEC §23 + SCORING_SPEC §1.1). */

export type VP = "D" | "M";
export interface Rect { x: number; y: number; w: number; h: number }

export interface ViewportSpec { name: VP; width: number; height: number; dpr: 1 | 2; isMobile: boolean }
export const VIEWPORT_SPECS: Record<VP, ViewportSpec> = {
  D: { name: "D", width: 1440, height: 1000, dpr: 1, isMobile: false },
  M: { name: "M", width: 390, height: 844, dpr: 2, isMobile: true },
};
export const vpDir = (s: ViewportSpec): string => `${s.width}x${s.height}`;

export interface BannerAction { step: "reject" | "close" | "accept"; label: string; clicked: boolean; method: "click" | "dispatch" | "none"; hidden_after: boolean }
export interface BannerRecord { detected: boolean; state: "none" | "closed" | "open"; actions: BannerAction[] }

export interface Completeness {
  blocked_requests_count: number;
  js_error_count: number;
  banner_state: "none" | "closed" | "open";
  scroll_completed: boolean;
  layout_stable: boolean;
  http_status: number | null;
  navigation_completed: boolean;
  failed_critical_requests: number;
  visible_text_length: number;
  capture_complete: boolean;
  incomplete_reasons: string[];
}

export interface NetworkRow {
  method: string;
  url: string;
  resource_type: string;
  status: number | null;
  content_type: string | null;
  body_bytes: number | null;
  blocked: boolean;
  failure: string | null;
}

export interface LinkRow { href: string; abs: string; text: string; name: string; visible: boolean; rect: Rect; selector: string }
export interface InteractiveRow { selector: string; tag: string; name: string; rect: Rect; vis: number }
export interface ImageRow { selector: string; src: string | null; current_src: string; alt: string | null; natural_w: number; natural_h: number; rect: Rect; is_background: boolean }
export interface PriceCandidate { selector: string; text: string; rect: Rect; in_fv: boolean; excluded: boolean; kind: "text" | "img_alt" }
export interface TextNodeRow { t: string; a: boolean }

export interface AxeNode { target: string; html: string; failureSummary: string; rect: Rect | null }
export interface AxeViolation { id: string; impact: string | null; help: string; helpUrl: string; nodes: AxeNode[] }

export interface ExtractResult {
  title: string;
  meta_description: string | null;
  headings: Array<{ level: number; text: string }>;
  links: LinkRow[];
  buttons: Array<{ selector: string; name: string; type: string; visible: boolean; rect: Rect }>;
  form_controls: Array<{ selector: string; tag: string; type: string; name: string | null; label: string; visible: boolean }>;
  forms: Array<{ method: string; action: string }>;
  images: ImageRow[];
  visible_text: string;
  text_nodes: TextNodeRow[];
  fv_text: string;
  interactive: InteractiveRow[];
  price_candidates: PriceCandidate[];
  overflow: { client_width: number; scroll_width: number; scroll_height: number; offenders: Array<{ selector: string; rect: Rect; right: number }> };
  jsonld_types: string[];
  h1_count: number;
  signature: number[];
}

export interface ScreenshotRef { file: string; width_px: number; height_px: number; written: boolean }

export interface ViewportCapture extends ExtractResult {
  vp: VP;
  width: number;
  height: number;
  dpr: number;
  url: string;
  final_url: string;
  http_status: number | null;
  redirect_chain: Array<{ url: string; status: number | null }>;
  aria_snapshot: string;
  console_errors: Array<{ text: string; location: string }>;
  failed_requests: Array<{ url: string; resource_type: string; failure: string }>;
  requests: NetworkRow[];
  screenshots: { viewport: ScreenshotRef; fullpage: ScreenshotRef };
  banner: BannerRecord;
  completeness: Completeness;
  axe: { version: string; violations: AxeViolation[]; error?: string };
  tiles: TilesManifest | null;
  fx_markers?: Record<string, Rect[]>;
  /** шляхи (відносно каталогу прогону) */
  files: { capture: string; network: string; axe: string; dir: string };
}

export interface TilesManifest {
  viewport: VP;
  first_viewport: string;
  tile_height_css: number;
  overlap_css: number;
  full_height_css: number;
  width_css: number;
  dpr: number;
  tiles: Array<{ index: number; file: string; y_css: number; height_css: number }>;
}

export type PageType = "product" | "category" | "unknown";

export interface PageCapture {
  url: string;
  path: string;
  page_id: string;
  page_type: PageType;
  page_group: string;
  D: ViewportCapture;
  M: ViewportCapture;
  timing: Record<VP, Record<string, number | null>>;
}

export type SourceClass = "OBSERVED" | "BENCHMARKED" | "INFERRED" | "SYNTHETIC";
export type EvidenceType = "screenshot" | "dom" | "accessibility" | "lighthouse" | "axe" | "browser_session" | "repeated_agent_observation";

export interface EvidenceRow {
  id: string;
  type: EvidenceType;
  source_class: SourceClass;
  page_url: string;
  page_path: string;
  page_type: PageType;
  page_group: string;
  category: string;
  description: string;
  artifact_reference: string;
  screenshot_reference: string;
  selector_or_region: { selector?: string; region: Rect; dpr: number; coord: "css_px_document" };
  excerpt?: string;
  detector_id: string;
  claim_kind: string;
  assertion: "presence" | "absence";
  viewport: VP;
  measurement: Record<string, unknown>;
  self_confirming: boolean;
  capture_complete: boolean;
  incomplete_reasons?: string[];
  /** факт і дія банера, повнота захоплення (G0-10, DEV-5) */
  capture_context: {
    banner_state: string;
    banner_actions: BannerAction[];
    blocked_requests_count: number;
    js_error_count: number;
    scroll_completed: boolean;
    layout_stable: boolean;
    http_status: number | null;
  };
}

export type Confidence = "VERIFIED" | "STRONG_HYPOTHESIS" | "HYPOTHESIS";
export interface FindingRow {
  finding_key: string;
  category: string;
  page_group: string;
  claim_kind: string;
  detector_ids: string[];
  evidence_ids: string[];
  evidence_families: string[];
  confidence: Confidence;
  evidence_strength: number;
}
