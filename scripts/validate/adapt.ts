/** Звіт (`Report`) → знімок знахідок для чистих функцій E1–E4 (`packages/scoring/src/validation.ts`). */
import type { Report } from "../../packages/schemas/src/index.js";
import { familyOfTier, type Family, type VFinding } from "../../packages/scoring/src/index.js";

export function toVFindings(report: Report): VFinding[] {
  const tier = new Map(report.evidence.map((e) => [e.id, e.tier]));
  const ev = new Map(report.evidence.map((e) => [e.id, e]));
  return report.findings.map((f) => {
    const fam = new Set<Family>();
    for (const id of f.evidence_ids) {
      const x = familyOfTier(tier.get(id) ?? null);
      if (x) fam.add(x);
    }
    return {
      finding_key: f.finding_key, category: f.category, page_group: f.page_group, claim_kind: f.claim_kind, confidence: f.confidence.level,
      priority: f.priority.value, rank: f.rank, families: [...fam].sort(), pages: f.pages.map((p) => p.path),
      evidence: f.evidence_ids.flatMap((id) => { const e = ev.get(id); return e ? [{ page_path: e.page_path, source_class: e.source_class, excerpt: e.excerpt }] : []; }),
    };
  });
}
