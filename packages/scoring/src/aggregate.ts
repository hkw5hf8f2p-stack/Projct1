/**
 * Агрегація доказів у знахідки за детермінованим `finding_key` (DEV-7, DEV-38; SCORING_SPEC §5) — лексично, без
 * embeddings і vector DB (§63). Потім — усі компоненти оцінки й детермінований порядок (§6.5).
 */
import { buildFindingKey, findingId, type Evidence } from "@sitelens/schemas";
import {
  confidence, coverage, evidenceStrength, funnel, priority, ratio, severity, tiersInGroup,
  type Category, type ConfidenceResult, type CoverageResult, type PageType, type PriorityOut, type SessionObs, type SeverityResult, type StrengthResult, type Tier,
} from "./score.js";
import { CONFIDENCE_RANK } from "./tables.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pathOf = (e: Evidence): string => e.page_path ?? new URL(e.page_url).pathname;

/**
 * Ключ доказу. axe: `page_group` = `measurement.finding_page_group` (наскрізні `*`), `component` = сигнатура компонента.
 * Доказ без category/page_group/claim_kind не агрегується (повертає null → `withheld: no_key`).
 */
export function evidenceKey(e: Evidence): string | null {
  if (!e.category || !e.claim_kind) return null;
  const m = e.measurement ?? {};
  const pg = typeof m["finding_page_group"] === "string" ? (m["finding_page_group"] as string) : e.page_group;
  if (!pg) return null;
  const comp = e.claim_kind.startsWith("axe:") && typeof m["component_signature"] === "string" ? (m["component_signature"] as string) : undefined;
  return buildFindingKey({ category: e.category, page_group: pg, claim_kind: e.claim_kind, component: comp });
}

export interface ScoredFinding {
  id: string;
  finding_key: string;
  category: Category;
  page_group: string;
  claim_kind: string;
  component: string | null;
  pages: Array<{ url: string; path: string; page_type: PageType }>;
  evidence_ids: string[];
  tiers: Record<string, Tier | null>;
  instances: number;
  strength: StrengthResult;
  confidence: ConfidenceResult;
  severity: SeverityResult;
  funnel: ReturnType<typeof funnel>;
  coverage: CoverageResult;
  /** false для VERIFIED (N/A) */
  synthetic_in_priority: boolean;
  priority: PriorityOut;
  rank: number;
}

export interface Withheld { finding_key: string; reason: "sup_only" | "no_strength_evidence"; evidence_ids: string[] }

export interface AggregateInput {
  evidence: readonly Evidence[];
  sessions?: readonly SessionObs[];
  /** шлях → тип сторінки (для SYNTHETIC-доказів без page_type) */
  pageTypes: Readonly<Record<string, PageType>>;
  /** контрдокази детекторів (негатив того самого claim_kind на сторінці), ключовані finding_key */
  counter?: Readonly<Record<string, readonly Evidence[]>>;
}

/** §6.5 порядок */
export function compareFindings(a: ScoredFinding, b: ScoredFinding): number {
  return (
    b.priority.value - a.priority.value ||
    CONFIDENCE_RANK[b.confidence.level] - CONFIDENCE_RANK[a.confidence.level] ||
    b.strength.value - a.strength.value ||
    b.severity.value - a.severity.value ||
    b.funnel.value - a.funnel.value ||
    cmp(a.finding_key, b.finding_key)
  );
}

export function aggregate(input: AggregateInput): { findings: ScoredFinding[]; withheld: Withheld[]; unkeyed_evidence_ids: string[] } {
  const groups = new Map<string, Evidence[]>();
  const unkeyed: string[] = [];
  for (const e of input.evidence) {
    const k = evidenceKey(e);
    if (k === null) {
      unkeyed.push(e.id);
      continue;
    }
    const g = groups.get(k) ?? [];
    g.push(e);
    groups.set(k, g);
  }
  const sessions = input.sessions ?? [];
  const findings: ScoredFinding[] = [];
  const withheld: Withheld[] = [];
  for (const key of [...groups.keys()].sort(cmp)) {
    const evs = (groups.get(key) as Evidence[]).slice().sort((a, b) => cmp(a.id, b.id));
    const ids = evs.map((e) => e.id);
    const tiers = tiersInGroup(evs);
    const strength = evidenceStrength(evs, tiers);
    if (!strength) {
      const allSup = [...tiers.values()].every((t) => t === "ET-SUP");
      withheld.push({ finding_key: key, reason: allSup ? "sup_only" : "no_strength_evidence", evidence_ids: ids });
      continue;
    }
    const [category, page_group, claim_kind, component] = key.split("|") as [Category, string, string, string | undefined];
    const pageMap = new Map<string, { url: string; path: string; page_type: PageType }>();
    // тип сторінки: з доказу, що його має (детерміновані — першими), інакше з карти аудиту, інакше unknown;
    // не від порядку доказів (SYNTHETIC без page_type не затирає тип детектора)
    const byClass = evs.slice().sort((a, b) => Number(a.source_class === "SYNTHETIC" || a.source_class === "INFERRED") - Number(b.source_class === "SYNTHETIC" || b.source_class === "INFERRED") || cmp(a.id, b.id));
    for (const e of byClass) {
      const p = pathOf(e);
      const prev = pageMap.get(p);
      if (prev && prev.page_type !== "unknown") continue;
      const t = (e.page_type ?? input.pageTypes[p] ?? prev?.page_type ?? "unknown") as PageType;
      pageMap.set(p, { url: prev?.url ?? e.page_url, path: p, page_type: t });
    }
    const pages = [...pageMap.values()].sort((a, b) => cmp(a.path, b.path));
    const pageTypes = pages.map((p) => p.page_type);
    const conf = confidence(evs, { claim_kind, counter: input.counter?.[key] ?? [] }, tiers);
    const sev = severity({ key, category, evidence: evs, pageTypes, sessions });
    const fun = funnel(category, pageTypes);
    const cov = coverage(key, pages.map((p) => p.path), page_group === "*", sessions);
    const verified = conf.level === "VERIFIED";
    const pr = priority({
      severity: sev.value,
      funnel_proximity: fun.value,
      evidence_strength: strength.value,
      lens_coverage: verified ? null : ratio(cov.lens),
      session_frequency: verified ? null : ratio(cov.session),
    }, conf.level);
    findings.push({
      id: findingId(key),
      finding_key: key,
      category, page_group, claim_kind, component: component ?? null,
      pages,
      evidence_ids: ids,
      tiers: Object.fromEntries(ids.map((id) => [id, (tiers.get(id) ?? null) === "ET-SUP" ? null : (tiers.get(id) as Tier)])),
      instances: evs.length,
      strength, confidence: conf, severity: sev, funnel: fun, coverage: cov,
      synthetic_in_priority: !verified,
      priority: pr,
      rank: 0,
    });
  }
  findings.sort(compareFindings);
  findings.forEach((f, i) => (f.rank = i + 1));
  return { findings, withheld, unkeyed_evidence_ids: unkeyed.sort(cmp) };
}
