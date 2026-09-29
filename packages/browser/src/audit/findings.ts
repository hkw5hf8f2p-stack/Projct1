/**
 * Зведення доказів у знахідки й мінімальна `confidence()` для перевірки S1a (SCORING_SPEC §1.2, §2, DEV-19).
 * Це не пакет scoring (його власник — sl-eval-science): лише підмножина, потрібна детермінованим детекторам —
 * F-DET → VERIFIED; F-INC (доказ відсутності з неповного захоплення) → HYPOTHESIS, strength 0.30.
 */
import type { Confidence, EvidenceRow, FindingRow } from "./types.js";

export type Family = "F-DET" | "F-INC" | "F-SUP";
export function familyOf(e: EvidenceRow): Family {
  if ((e.source_class === "OBSERVED" || e.source_class === "BENCHMARKED") && e.self_confirming) return "F-DET";
  if (e.source_class === "OBSERVED" && !e.self_confirming && e.capture_complete === false) return "F-INC";
  return "F-SUP";
}
export function confidenceOf(families: Set<Family>): { confidence: Confidence; strength: number } | null {
  if (families.has("F-DET")) return { confidence: "VERIFIED", strength: 1 };
  if (families.has("F-INC")) return { confidence: "HYPOTHESIS", strength: 0.3 };
  return null; // лише ET-SUP — не знахідка
}
export const findingKey = (e: EvidenceRow): string => `${e.category}|${e.page_group}|${e.claim_kind}`;

export function buildFindings(evidence: EvidenceRow[]): FindingRow[] {
  const groups = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    const k = findingKey(e);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  const out: FindingRow[] = [];
  for (const [key, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fams = new Set(list.map(familyOf));
    const c = confidenceOf(fams);
    if (!c) continue;
    out.push({
      finding_key: key,
      category: list[0]!.category,
      page_group: list[0]!.page_group,
      claim_kind: list[0]!.claim_kind,
      detector_ids: [...new Set(list.map((e) => e.detector_id))].sort(),
      evidence_ids: list.map((e) => e.id).sort(),
      evidence_families: [...fams].sort(),
      confidence: c.confidence,
      evidence_strength: c.strength,
    });
  }
  return out;
}
