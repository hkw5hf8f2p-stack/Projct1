/** Агрегація доказів у знахідки (packages/scoring) і відображення в рядки таблиці findings. Той самий `aggregate()`, що всередині buildReport — числа збігаються. */
import { aggregate, ratio, type ScoredFinding } from "@sitelens/scoring";
import type { FindingRowIn } from "@sitelens/pipeline";
import type { AuditArtifacts, LlmResults } from "@sitelens/reporting";

export function computeFindings(art: AuditArtifacts, llm: LlmResults | null): { findings: ScoredFinding[]; evidenceById: Map<string, { detector_id?: string }> } {
  const all = [...art.evidence, ...(llm?.evidence ?? [])];
  const agg = aggregate({ evidence: all, sessions: llm?.sessions ?? [], pageTypes: Object.fromEntries(art.pages.map((p) => [p.path, p.page_type])), counter: llm?.counter ?? {} });
  return { findings: agg.findings, evidenceById: new Map(all.map((e) => [e.id, e])) };
}

const frac = (r: { n: number; m: number }): number | null => (r.m === 0 ? null : ratio(r));

export function findingRows(s: ReturnType<typeof computeFindings>): FindingRowIn[] {
  return s.findings.map((f) => ({
    id: f.id, finding_key: f.finding_key, category: f.category, page_group: f.page_group, claim_kind: f.claim_kind, component: f.component, stage: f.funnel.stage,
    detector_ids: [...new Set(f.evidence_ids.map((id) => s.evidenceById.get(id)?.detector_id).filter((x): x is string => !!x))].sort(),
    evidence_families: [...f.confidence.families], confidence: f.confidence.level, evidence_strength: f.strength.value, instances: f.instances,
    lens_coverage: f.synthetic_in_priority ? frac(f.coverage.lens) : null, task_coverage: frac(f.coverage.task), session_frequency: f.synthetic_in_priority ? frac(f.coverage.session) : null,
    funnel_proximity: f.funnel.value, severity: f.severity.value, priority: f.priority.value, title: null, problem: null, why_it_matters: null,
    evidence_ids: f.evidence_ids, counter_evidence_ids: f.confidence.contradiction?.counter_evidence_ids ?? [], recommendation: null,
  }));
}
