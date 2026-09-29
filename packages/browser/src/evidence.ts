/**
 * Форма Evidence: SPEC §23 (type, page_url, description, artifact_reference, selector_or_region, source_class)
 * + поля SCORING_SPEC §1 (id, self_confirming, detector_id, claim_kind). Рядки PageArtifact — SPEC §8.
 */
import { createHash } from "node:crypto";

export type SourceClass = "OBSERVED" | "BENCHMARKED" | "INFERRED" | "SYNTHETIC";
export type EvidenceType =
  | "screenshot"
  | "dom"
  | "accessibility"
  | "lighthouse"
  | "axe"
  | "browser_session"
  | "repeated_agent_observation";

export interface Region {
  /** координати в системі повно-сторінкового скриншота, CSS px */
  x: number;
  y: number;
  width: number;
  height: number;
  coordinate_space: "full_page" | "viewport";
}

export interface Evidence {
  id: string;
  type: EvidenceType;
  source_class: SourceClass;
  page_url: string;
  /** ставить лише код детектора (SCORING_SPEC §1) */
  self_confirming: boolean;
  detector_id: string;
  claim_kind: string;
  viewport: "desktop" | "mobile";
  description: string;
  /** шлях відносно каталогу прогону; файл існує */
  artifact_reference: string;
  selector_or_region: { selector: string; region: Region | null };
  /** необов'язково: обрізка регіону — окремий файл для людини */
  region_artifact?: string;
  data?: Record<string, unknown>;
}

export const evidenceId = (...parts: Array<string | number>): string =>
  "ev_" + createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
