/**
 * Компоненти оцінки знахідки (SCORING_SPEC §1–§4, §6): сила доказу, впевненість (C3), severity (C2), воронка (C2),
 * покриття (§4.3), пріоритет з перерозподілом ваг (C1, DEV-4). Чисті функції; результат не залежить від порядку входу.
 */
import { tierOf, ABSENCE_CLAIM_KINDS, roundHalfUp, type Evidence, type PAGE_TYPES, type CATEGORIES, type FUNNEL_STAGES, type EVIDENCE_TIERS, type EVIDENCE_FAMILIES } from "@sitelens/schemas";
import {
  AXE_IMPACT_BASE, CATEGORY_STAGE, EPS, ET_STRENGTH, FUN_STAGE, LH_BASE, LH_THRESHOLDS, MOD, NETWORK_FLOOR, NETWORK_IMAGE_BYTES,
  PAGE_MOD, PAGE_STAGE, PERCEPTUAL_CLAIM_KINDS, SEV_BASE, W, type ModId,
} from "./tables.js";

export type PageType = (typeof PAGE_TYPES)[number];
export type Category = (typeof CATEGORIES)[number];
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type Tier = (typeof EVIDENCE_TIERS)[number];
export type Family = (typeof EVIDENCE_FAMILIES)[number];
export type ConfidenceLevel = "VERIFIED" | "STRONG_HYPOTHESIS" | "HYPOTHESIS";

/** Результат синтетичної сесії в тій формі, яку бачить скоринг (SPEC §22). Мітка severity агента сюди НЕ входить. */
export interface SessionObs {
  session_id: string;
  lens_id: string;
  task_id: string;
  level: "snapshot" | "journey";
  success: "true" | "false" | "partial";
  /** шляхи сторінок, які сесія оцінила/відвідала */
  pages_seen: string[];
  /** finding_key, про які сесія повідомила */
  reported_keys: string[];
  /** ключ останнього зафіксованого friction (MOD-BLOCKER) */
  last_friction_key: string | null;
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round3 = (x: number): number => Math.round(x * 1000 + EPS * 1000) / 1000;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const pathOf = (e: Evidence): string => e.page_path ?? new URL(e.page_url).pathname;

// ---------------------------------------------------------------- §1.2 рівні й сила
/** рівень кожного доказу в контексті групи (ET-SYN-M/ET-BRW залежать від групи) */
export function tiersInGroup(evs: readonly Evidence[]): Map<string, Tier> {
  const synSessions = uniq(evs.filter((e) => e.source_class === "SYNTHETIC").map((e) => e.session_id)).length;
  const bfLogs = new Map<string, Set<string>>();
  for (const e of evs) {
    if (!e.browser_failure) continue;
    const sig = `${pathOf(e)}|${e.browser_failure.selector ?? ""}|${e.browser_failure.kind}`;
    const s = bfLogs.get(sig) ?? new Set<string>();
    s.add(e.session_id ?? e.id);
    bfLogs.set(sig, s);
  }
  const out = new Map<string, Tier>();
  for (const e of evs) {
    const sig = e.browser_failure ? `${pathOf(e)}|${e.browser_failure.selector ?? ""}|${e.browser_failure.kind}` : "";
    out.set(e.id, tierOf(e, { distinctSessionsForKey: synSessions, distinctLogsForBrowserFailure: bfLogs.get(sig)?.size ?? 0 }) as Tier);
  }
  return out;
}

export function familyOf(e: Evidence, tier: Tier): Family {
  if (tier === "ET-DET") return "F-DET";
  if (tier === "ET-INC") return "F-INC";
  if (tier === "ET-BRW") return "F-BRW";
  if (e.source_class === "SYNTHETIC") return "F-SYN";
  if (e.source_class === "INFERRED") return "F-INF";
  return "F-SUP";
}

export interface StrengthResult { value: 1 | 0.9 | 0.7 | 0.4 | 0.3; tier: Tier }
/** §1.2 evidenceStrength; `null` — знахідка без доказу сили (§23: відкинути) */
export function evidenceStrength(evs: readonly Evidence[], tiers = tiersInGroup(evs)): StrengthResult | null {
  const ts = new Set(tiers.values());
  const syn = uniq(evs.filter((e) => e.source_class === "SYNTHETIC").map((e) => e.session_id)).length;
  const pick = (tier: keyof typeof ET_STRENGTH): StrengthResult => ({ value: ET_STRENGTH[tier], tier });
  if (ts.has("ET-DET")) return pick("ET-DET");
  if (ts.has("ET-BRW")) return pick("ET-BRW");
  if (syn >= 2) return pick("ET-SYN-M");
  if (syn === 1) return pick("ET-SYN-1");
  if (ts.has("ET-INF")) return pick("ET-INF");
  if (ts.has("ET-INC")) return pick("ET-INC"); // DEV-19
  return null;
}

// ---------------------------------------------------------------- §2 впевненість (C3)
export type ConfidenceRule = "C3-VERIFIED-DET" | "C3-VERIFIED-BRW-REPLAY" | "C3-HYP-INC-CAP" | "C3-STRONG-A" | "C3-STRONG-B" | "C3-HYP-CONTRADICTION" | "C3-HYP-DEFAULT";
export interface ConfidenceResult { level: ConfidenceLevel; rule: ConfidenceRule; families: Family[]; contradiction: { detector_id: string; counter_evidence_ids: string[] } | null }

/**
 * `counter` — негативні результати детектора того самого claim_kind на тих самих сторінках (правило суперечності §2).
 */
export function confidence(evs: readonly Evidence[], opts: { claim_kind: string; counter?: readonly Evidence[] } , tiers = tiersInGroup(evs)): ConfidenceResult {
  const fams = new Set<Family>();
  for (const e of evs) fams.add(familyOf(e, tiers.get(e.id) as Tier));
  const families = [...fams].sort(cmp);
  const base = (level: ConfidenceLevel, rule: ConfidenceRule): ConfidenceResult => ({ level, rule, families, contradiction: null });

  if (fams.has("F-DET")) return base("VERIFIED", "C3-VERIFIED-DET");
  if (fams.has("F-INC")) return base("HYPOTHESIS", "C3-HYP-INC-CAP");
  if (fams.has("F-BRW") && evs.some((e) => e.browser_failure?.reproduced_by_replay)) return base("VERIFIED", "C3-VERIFIED-BRW-REPLAY");

  const counter = (opts.counter ?? []).slice().sort((a, b) => cmp(a.id, b.id));
  if (counter.length > 0 && !PERCEPTUAL_CLAIM_KINDS.has(opts.claim_kind)) {
    return { level: "HYPOTHESIS", rule: "C3-HYP-CONTRADICTION", families, contradiction: { detector_id: counter[0]?.detector_id ?? "unknown", counter_evidence_ids: counter.map((e) => e.id) } };
  }
  const nonLlm = (["F-SUP", "F-BRW"] as const).filter((x) => fams.has(x)).length;
  if (fams.size >= 2 && nonLlm >= 1) return base("STRONG_HYPOTHESIS", "C3-STRONG-A");
  const syn = evs.filter((e) => e.source_class === "SYNTHETIC");
  const lenses = uniq(syn.map((e) => e.lens_id)).length;
  const contexts = uniq(syn.map((e) => `${e.task_id}|${e.level}`)).length;
  if (lenses >= 3 && contexts >= 2) return base("STRONG_HYPOTHESIS", "C3-STRONG-B");
  return base("HYPOTHESIS", "C3-HYP-DEFAULT");
}

// ---------------------------------------------------------------- §3 severity (C2)
export interface SeverityResult { value: number; base: number; base_source: "category" | "axe_impact" | "lighthouse" | "network"; modifiers: Array<{ id: ModId; delta: number }> }

const num = (m: Record<string, unknown> | undefined, k: string): number | null => (m && typeof m[k] === "number" ? (m[k] as number) : null);

export function lighthouseBase(m: Record<string, unknown> | undefined): number | null {
  const lcp = num(m, "lcp_ms"), tbt = num(m, "tbt_ms");
  if ((lcp !== null && lcp > LH_THRESHOLDS.lcp_severe_ms) || (tbt !== null && tbt > LH_THRESHOLDS.tbt_severe_ms)) return LH_BASE.severe;
  if ((lcp !== null && lcp > LH_THRESHOLDS.lcp_moderate_ms) || (tbt !== null && tbt > LH_THRESHOLDS.tbt_moderate_ms)) return LH_BASE.moderate;
  if (m && m["opportunities_only"] === true) return LH_BASE.opportunities_only;
  return null;
}

export function severity(input: { key: string; category: Category; evidence: readonly Evidence[]; pageTypes: readonly PageType[]; sessions?: readonly SessionObs[] }): SeverityResult {
  let base = SEV_BASE[input.category];
  let source: SeverityResult["base_source"] = "category";
  const overrides: Array<[number, SeverityResult["base_source"]]> = [];
  for (const e of input.evidence) {
    if (e.type === "axe" || e.detector_id?.startsWith("axe:")) {
      const imp = e.measurement?.["impact"];
      if (typeof imp === "string" && imp in AXE_IMPACT_BASE) overrides.push([AXE_IMPACT_BASE[imp as keyof typeof AXE_IMPACT_BASE], "axe_impact"]);
    }
    if (e.type === "lighthouse") {
      const b = lighthouseBase(e.measurement);
      if (b !== null) overrides.push([b, "lighthouse"]);
    }
  }
  if (overrides.length) {
    // максимум перевизначень; при рівності — стабільно за назвою джерела
    overrides.sort((a, b) => b[0] - a[0] || cmp(a[1], b[1]));
    [base, source] = overrides[0] as [number, SeverityResult["base_source"]];
  }
  const bigImage = input.evidence.some((e) => (e.detector_id === "oversized_image" || e.claim_kind === "oversized_image") && (num(e.measurement, "body_bytes") ?? 0) >= NETWORK_IMAGE_BYTES);
  if (bigImage && NETWORK_FLOOR > base + EPS) {
    base = NETWORK_FLOOR;
    source = "network";
  }
  const modifiers: SeverityResult["modifiers"] = [];
  const pm = uniq(input.pageTypes.map((t) => PAGE_MOD[t]));
  if (pm.length) {
    const best = pm.sort((a, b) => MOD[b] - MOD[a])[0] as ModId;
    modifiers.push({ id: best, delta: MOD[best] });
  }
  if ((input.sessions ?? []).some((s) => s.success === "false" && s.last_friction_key === input.key)) modifiers.push({ id: "MOD-BLOCKER", delta: MOD["MOD-BLOCKER"] });
  const value = clamp01(round3(base + modifiers.reduce((a, m) => a + m.delta, 0)));
  return { value, base, base_source: source, modifiers };
}

// ---------------------------------------------------------------- §4.1–4.2 воронка
export function funnel(category: Category, pageTypes: readonly PageType[]): { stage: FunnelStage; value: number; stage_source: "category" | "page_type" } {
  const c = CATEGORY_STAGE[category];
  if (c) return { stage: c, value: FUN_STAGE[c], stage_source: "category" };
  if (pageTypes.length === 0) throw new Error("funnel: знахідка без сторінок");
  const stages = uniq(pageTypes.map((t) => PAGE_STAGE[t])).sort((a, b) => FUN_STAGE[b] - FUN_STAGE[a]);
  const s = stages[0] as FunnelStage;
  return { stage: s, value: FUN_STAGE[s], stage_source: "page_type" };
}

// ---------------------------------------------------------------- §4.3 покриття
export interface Ratio { n: number; m: number }
export interface CoverageResult { lens: Ratio; session: Ratio; task: Ratio; reported_session_ids: string[]; lens_ids: string[]; task_ids: string[] }

/** експозиція через сторінки: сесія бачила хоча б одну сторінку знахідки; `siteWide` — будь-яку */
export function coverage(key: string, findingPaths: readonly string[], siteWide: boolean, sessions: readonly SessionObs[]): CoverageResult {
  const fp = new Set(findingPaths);
  const exp = sessions.filter((s) => (siteWide ? s.pages_seen.length > 0 : s.pages_seen.some((p) => fp.has(p))));
  const rep = exp.filter((s) => s.reported_keys.includes(key));
  const lensExp = uniq(exp.map((s) => s.lens_id)), lensRep = uniq(rep.map((s) => s.lens_id));
  const taskExp = uniq(exp.map((s) => s.task_id)), taskRep = uniq(rep.map((s) => s.task_id));
  return {
    lens: { n: lensRep.length, m: lensExp.length },
    session: { n: rep.length, m: exp.length },
    task: { n: taskRep.length, m: taskExp.length },
    reported_session_ids: rep.map((s) => s.session_id).sort(cmp),
    lens_ids: lensRep.sort(cmp),
    task_ids: taskRep.sort(cmp),
  };
}
export const ratio = (r: Ratio): number => (r.m === 0 ? 0 : r.n / r.m);

// ---------------------------------------------------------------- §6 пріоритет (C1, DEV-4)
export interface PriorityComponentOut { name: keyof typeof W; base_weight: number; applicable: boolean; value: number | null; effective_weight: number; na_reason: "verified_synthetic_not_scored" | null }
export interface PriorityOut {
  value: number;
  /** індекс до кепу асиметрії (DEV-60) */
  uncapped: number;
  cap: { rule: "CAP-HYP-VERIFIED-EQUIV"; value: number } | null;
  formula: "scoring-v1/redistributed";
  components: PriorityComponentOut[];
}

/**
 * DEV-60 (асиметрія, критерій S4 п.3): HYPOTHESIS не може мати priority вище, ніж мала б та сама знахідка, якби її
 * перевірили: cap = round(100·(W_sev·sev + W_fun·fun + W_ev·1) / (W_sev + W_fun + W_ev)). Без кепу 12/12 лінз в
 * одному контексті (HYPOTHESIS) дають 84 проти 82 у VERIFIED з рівними severity/funnel (контрприклад у тестах).
 */
export function verifiedEquivalentCap(sev: number, fun: number): number {
  return roundHalfUp((100 * (W.severity * sev + W.funnel_proximity * fun + W.evidence_strength * 1)) / (W.severity + W.funnel_proximity + W.evidence_strength));
}

export function priority(
  c: { severity: number; funnel_proximity: number; evidence_strength: number; lens_coverage: number | null; session_frequency: number | null },
  level: ConfidenceLevel = "VERIFIED",
): PriorityOut {
  const names = ["severity", "funnel_proximity", "lens_coverage", "session_frequency", "evidence_strength"] as const;
  for (const n of names) {
    const v = c[n];
    if (v !== null && (!(v >= 0) || v > 1 + EPS)) throw new Error(`priority: ${n}=${v} поза [0,1]`);
  }
  if (level === "VERIFIED" && (c.lens_coverage !== null || c.session_frequency !== null)) throw new Error("priority: для VERIFIED синтетичне покриття N/A (SCORING_SPEC §4.3)");
  if (level !== "VERIFIED" && (c.lens_coverage === null || c.session_frequency === null)) throw new Error("priority: для гіпотези покриття застосовне (0, якщо S_exp = ∅)");
  const sw = names.reduce((a, n) => a + (c[n] !== null ? W[n] : 0), 0);
  if (sw < 0.65 - EPS) throw new Error("priority: Σ застосовних ваг < 0.65");
  let score = 0;
  const components = names.map((n): PriorityComponentOut => {
    const v = c[n];
    if (v === null) return { name: n, base_weight: W[n], applicable: false, value: null, effective_weight: 0, na_reason: "verified_synthetic_not_scored" };
    score += (W[n] / sw) * v;
    return { name: n, base_weight: W[n], applicable: true, value: v, effective_weight: W[n] / sw, na_reason: null };
  });
  const uncapped = roundHalfUp(100 * score);
  const cap = level === "HYPOTHESIS" ? { rule: "CAP-HYP-VERIFIED-EQUIV" as const, value: verifiedEquivalentCap(c.severity, c.funnel_proximity) } : null;
  return { value: cap ? Math.min(uncapped, cap.value) : uncapped, uncapped, cap, formula: "scoring-v1/redistributed", components };
}

export { ABSENCE_CLAIM_KINDS };
