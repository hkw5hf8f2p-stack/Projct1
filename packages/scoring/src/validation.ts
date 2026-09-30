/**
 * Чисті функції валідації E1–E4 (SCORING_SPEC §8, §12). Без I/O, мережі й LLM: приймають знімок звіту (`VFinding[]`)
 * і повертають числа й вердикти. Пороги зафіксовано ДО результатів (SCORING_SPEC §8); змінювати їх після прогону —
 * лише із записом «чому» у planning/eval/VALIDATION_PROTOCOLS.md і DEVIATION_LOG.
 */

import type { Family } from "./score.js";

export type VConfidence = "VERIFIED" | "STRONG_HYPOTHESIS" | "HYPOTHESIS";

/** мінімальний знімок знахідки звіту, потрібний валідації */
export interface VFinding {
  finding_key: string;
  category: string;
  page_group: string;
  claim_kind: string;
  confidence: VConfidence;
  /** priority.value (0..100) */
  priority: number;
  /** позиція у звіті за §6.5 (1 = перша) */
  rank: number;
  families: readonly Family[];
  /** шляхи сторінок знахідки */
  pages: readonly string[];
}

const TIER_FAMILY: Readonly<Record<string, Family>> = {
  "ET-DET": "F-DET", "ET-SUP": "F-SUP", "ET-BRW": "F-BRW", "ET-SYN-M": "F-SYN", "ET-SYN-1": "F-SYN", "ET-INF": "F-INF", "ET-INC": "F-INC",
};
export const familyOfTier = (tier: string | null): Family | null => (tier ? TIER_FAMILY[tier] ?? null : null);

/** «Не-LLM» родини: наявність будь-якої з них означає, що знахідка не суто LLM (E2(б), E3a специфічність) */
export const NON_LLM_FAMILIES: readonly Family[] = ["F-DET", "F-SUP", "F-BRW"];
export const hasNonLlmFamily = (f: Pick<VFinding, "families">): boolean => f.families.some((x) => NON_LLM_FAMILIES.includes(x));
/** LLM-знахідка = жодного F-DET/F-SUP/F-BRW доказу (SCORING_SPEC §8.2, §8.3) */
export const isLlmOnly = (f: Pick<VFinding, "families">): boolean => !hasNonLlmFamily(f);

const CONF_RANK: Record<VConfidence, number> = { VERIFIED: 3, STRONG_HYPOTHESIS: 2, HYPOTHESIS: 1 };
export const confRank = (c: VConfidence): number => CONF_RANK[c];

// ------------------------------------------------------------------------------------------------ E1 (§8.1)
export interface E1Defect {
  id: number;
  name: string;
  categories: readonly string[];
  /** порожній = будь-яка група */
  pageGroups: readonly string[];
  /** порожній = будь-який claim_kind; префікс `axe:` порівнюється точно */
  claimKinds: readonly string[];
  deterministic: boolean;
}
/**
 * Таблиця SCORING_SPEC §8.1. Стовпець claimKinds — УТОЧНЕННЯ (SCORING_SPEC §12.1): без нього #7 (mobile_usability) міг
 * би зарахуватися як #5 (mobile_usability на product). Уточнення лише звужує збіг → не робить гейт легшим.
 */
export const E1_TABLE: readonly E1Defect[] = [
  { id: 1, name: "headline", categories: ["value_proposition", "visual_hierarchy"], pageGroups: ["/"], claimKinds: [], deterministic: false },
  { id: 2, name: "shipping", categories: ["shipping", "missing_information"], pageGroups: ["product"], claimKinds: [], deterministic: true },
  { id: 3, name: "jargon", categories: ["terminology", "product_selection"], pageGroups: ["product", "category"], claimKinds: [], deterministic: false },
  { id: 4, name: "similar_products", categories: ["comparison", "product_selection"], pageGroups: ["category", "product"], claimKinds: [], deterministic: false },
  { id: 5, name: "cta_below_fold", categories: ["cta", "visual_hierarchy", "mobile_usability"], pageGroups: ["/", "product"], claimKinds: ["below_fold"], deterministic: true },
  { id: 6, name: "mobile_label", categories: ["accessibility"], pageGroups: [], claimKinds: ["axe:button-name", "axe:link-name", "axe:label"], deterministic: true },
  { id: 7, name: "overflow", categories: ["mobile_usability"], pageGroups: [], claimKinds: ["horizontal_overflow"], deterministic: true },
  { id: 8, name: "slow_image", categories: ["performance"], pageGroups: [], claimKinds: ["oversized_image"], deterministic: true },
  { id: 9, name: "alt", categories: ["accessibility"], pageGroups: [], claimKinds: ["axe:image-alt"], deterministic: true },
  { id: 10, name: "late_price", categories: ["pricing"], pageGroups: ["category", "product"], claimKinds: [], deterministic: true },
];

/** `*` — наскрізна група axe (finding_page_group): збігається з будь-якою вимогою pageGroups */
export function e1Matches(d: E1Defect, f: VFinding): boolean {
  if (!d.categories.includes(f.category)) return false;
  if (d.pageGroups.length > 0 && f.page_group !== "*" && !d.pageGroups.includes(f.page_group)) return false;
  if (d.claimKinds.length > 0 && !d.claimKinds.includes(f.claim_kind)) return false;
  return true;
}

export interface E1Result {
  detected: Array<{ id: number; name: string; deterministic: boolean; detected: boolean; by: string[] }>;
  /** «детерміновані x/7»: збіг І confidence = VERIFIED */
  det: { x: number; of: number };
  /** «LLM-лише y/3»: збіг І знахідка має F-SYN/F-INF доказ. Осмислено лише для абляційного прогону. */
  llm: { y: number; of: number };
  total: number;
  /** знахідки, які не збіглися з жодним із 10 дефектів (інформативно; на першому проході не гейт) */
  unexpected: string[];
}

/** E1 на знімку звіту. `E1_det` рахується завжди; `E1_llm` — за тим самим знімком (передавай абляційний). */
export function e1(findings: readonly VFinding[]): E1Result {
  const detected = E1_TABLE.map((d) => {
    const hits = findings.filter((f) => e1Matches(d, f));
    const ok = d.deterministic
      ? hits.some((f) => f.confidence === "VERIFIED" && f.families.includes("F-DET"))
      : hits.some((f) => f.families.includes("F-SYN") || f.families.includes("F-INF"));
    return { id: d.id, name: d.name, deterministic: d.deterministic, detected: ok, by: hits.map((f) => f.finding_key) };
  });
  const det = detected.filter((d) => d.deterministic);
  const llm = detected.filter((d) => !d.deterministic);
  const matched = new Set(detected.flatMap((d) => d.by));
  return {
    detected,
    det: { x: det.filter((d) => d.detected).length, of: det.length },
    llm: { y: llm.filter((d) => d.detected).length, of: llm.length },
    total: detected.filter((d) => d.detected).length,
    unexpected: findings.map((f) => f.finding_key).filter((k) => !matched.has(k)),
  };
}

/** Гейт E1 (SCORING_SPEC §8.1, основна фікстура): Σ detected ≥ 8 і всі 7 детермінованих. E1_llm — показник, не гейт. */
export const E1_GATE = { min_total: 8, det_of: 7 } as const;
export function e1Gate(r: E1Result): boolean {
  return r.total >= E1_GATE.min_total && r.det.x === E1_GATE.det_of;
}

// ------------------------------------------------------------------------------------------------ E1-rank (критерій S4 №2, DEV-76)
/**
 * Гейт рангу: кожен із 7 детермінованих дефектів має VERIFIED F-DET-знахідку з рангом ≤ 10 у ПОВНОМУ звіті (з гіпотезами).
 * Поріг «топ-10» — із SPRINT_PLAN S4 кр.2 (зафіксовано до S4), не з результату. Недетектований дефект = ранг null = FAIL.
 */
export const E1_RANK_GATE = { top: 10 } as const;
export interface E1RankResult {
  ranks: Array<{ id: number; name: string; rank: number | null; finding_key: string | null }>;
  in_top: number;
  of: number;
  pass: boolean;
  /** скільки знахідок у звіті (≤ 10 → гейт тривіальний за побудовою, це видно в рядку) */
  findings: number;
  /** скільки гіпотез (STRONG/HYPOTHESIS) у звіті */
  hypotheses: number;
}
export function e1RankGate(findings: readonly VFinding[], top: number = E1_RANK_GATE.top): E1RankResult {
  const ranks = E1_TABLE.filter((d) => d.deterministic).map((d) => {
    const hits = findings.filter((f) => e1Matches(d, f) && f.confidence === "VERIFIED" && f.families.includes("F-DET")).sort((a, b) => a.rank - b.rank);
    const best = hits[0];
    return { id: d.id, name: d.name, rank: best ? best.rank : null, finding_key: best ? best.finding_key : null };
  });
  const in_top = ranks.filter((r) => r.rank !== null && r.rank <= top).length;
  return { ranks, in_top, of: ranks.length, pass: in_top === ranks.length, findings: findings.length, hypotheses: findings.filter((f) => f.confidence !== "VERIFIED").length };
}

/** Перерахунок рангу за порядком scoring-v1 (priority desc, впевненість, finding_key) — лише для контролю, що гейт рангу вміє впасти */
export function rerankV1(findings: readonly VFinding[]): VFinding[] {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...findings]
    .sort((a, b) => b.priority - a.priority || confRank(b.confidence) - confRank(a.confidence) || a.rank - b.rank || cmp(a.finding_key, b.finding_key))
    .map((f, i) => ({ ...f, rank: i + 1 }));
}

// ------------------------------------------------------------------------------------------------ E2 (§8.2)
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Rank-biased overlap, екстраполяція Webber et al. 2010 (RBO_EXT), p = 0.8, на топ-k, k = min(10, max(|S|,|T|)).
 * Ідентичні списки → 1; списки без спільних елементів → 0; порожні обидва → 1. Показник інформативний (G0-8).
 */
export function rbo(s: readonly string[], t: readonly string[], p = 0.8, kMax = 10): number {
  const k = Math.min(kMax, Math.max(s.length, t.length));
  if (k === 0) return 1;
  let overlap = 0;
  const seenS = new Set<string>();
  const seenT = new Set<string>();
  let sum = 0;
  let xk = 0;
  for (let d = 1; d <= k; d++) {
    const a = s[d - 1];
    const b = t[d - 1];
    if (a !== undefined) seenS.add(a);
    if (b !== undefined) seenT.add(b);
    overlap = 0;
    for (const x of seenS) if (seenT.has(x)) overlap++;
    sum += (overlap / d) * Math.pow(p, d);
    xk = overlap;
  }
  return (xk / k) * Math.pow(p, k) + ((1 - p) / p) * sum;
}

/** Пороги E2 (SCORING_SPEC §8.2) */
export const E2_THRESHOLDS = { jcat_mean: 0.6, jpg_mean: 0.6, jcat_min: 0.43, jpg_min: 0.43, k3_min: 3, llm_jcat_mean_target: 0.4 } as const;

export interface E2Metrics {
  runs: number;
  jcat: number[];
  jpg: number[];
  jcat_mean: number;
  jcat_min: number;
  jpg_mean: number;
  jpg_min: number;
  k3: string[];
  rbo10: number[];
  rbo10_mean: number;
  /** розмір підмножини (для E2(б): 0 = LLM-знахідок немає → J тривіально 1, це НЕ доказ стабільності) */
  set_sizes: number[];
}
const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);
const min = (xs: readonly number[]): number => (xs.length ? Math.min(...xs) : 1);

/** Метрики E2 на 3 (або n) прогонах; `runs[i]` — знахідки звіту i у порядку §6.5 (за `rank`) */
export function e2Metrics(runs: ReadonlyArray<readonly VFinding[]>): E2Metrics {
  const ordered = runs.map((r) => [...r].sort((a, b) => a.rank - b.rank));
  const top5 = ordered.map((r) => r.slice(0, 5));
  const cat = top5.map((r) => new Set(r.map((f) => f.category)));
  const pg = top5.map((r) => new Set(r.map((f) => f.page_group)));
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) pairs.push([i, j]);
  const jcat = pairs.map(([i, j]) => jaccard(cat[i] as Set<string>, cat[j] as Set<string>));
  const jpg = pairs.map(([i, j]) => jaccard(pg[i] as Set<string>, pg[j] as Set<string>));
  const top3 = ordered.map((r) => new Set(r.slice(0, 3).map((f) => f.finding_key)));
  const count = new Map<string, number>();
  for (const s of top3) for (const k of s) count.set(k, (count.get(k) ?? 0) + 1);
  const k3 = [...count].filter(([, c]) => c >= 2).map(([k]) => k).sort();
  const keys10 = ordered.map((r) => r.slice(0, 10).map((f) => f.finding_key));
  const rbo10 = pairs.map(([i, j]) => rbo(keys10[i] as string[], keys10[j] as string[]));
  return {
    runs: runs.length, jcat, jpg, jcat_mean: mean(jcat), jcat_min: min(jcat), jpg_mean: mean(jpg), jpg_min: min(jpg), k3, rbo10, rbo10_mean: mean(rbo10),
    set_sizes: ordered.map((r) => r.length),
  };
}

/** Валідність прогону E2: обхід кешу доводиться лічильником, а не прапорцем (SCORING_SPEC §8.2) */
export interface RunCacheCounters { cache_read_tokens: number; cache_reads: number; cache_mode: "use" | "bypass" }
export interface E2Validity { valid: boolean; reasons: string[] }
export function e2Validity(runs: readonly RunCacheCounters[]): E2Validity {
  const reasons: string[] = [];
  runs.forEach((r, i) => {
    if (r.cache_read_tokens > 0) reasons.push(`run ${i + 1}: cache_read_tokens=${r.cache_read_tokens} > 0`);
    if (r.cache_reads > 0) reasons.push(`run ${i + 1}: cache reads=${r.cache_reads} > 0`);
    if (r.cache_mode !== "bypass") reasons.push(`run ${i + 1}: cache_mode=${r.cache_mode}, очікується bypass`);
  });
  if (runs.length < 3) reasons.push(`потрібно ≥ 3 прогони, є ${runs.length}`);
  return { valid: reasons.length === 0, reasons };
}

export interface E2Gate { pass: boolean; failed: string[] }
/** Гейт E2(а) на повному звіті */
export function e2Gate(m: E2Metrics): E2Gate {
  const t = E2_THRESHOLDS;
  const failed: string[] = [];
  if (!(m.jcat_mean >= t.jcat_mean)) failed.push(`Jcat_mean ${m.jcat_mean.toFixed(3)} < ${t.jcat_mean}`);
  if (!(m.jpg_mean >= t.jpg_mean)) failed.push(`Jpg_mean ${m.jpg_mean.toFixed(3)} < ${t.jpg_mean}`);
  if (!(m.jcat_min >= t.jcat_min)) failed.push(`Jcat_min ${m.jcat_min.toFixed(3)} < ${t.jcat_min}`);
  if (!(m.jpg_min >= t.jpg_min)) failed.push(`Jpg_min ${m.jpg_min.toFixed(3)} < ${t.jpg_min}`);
  if (!(m.k3.length >= t.k3_min)) failed.push(`|K3| ${m.k3.length} < ${t.k3_min}`);
  return { pass: failed.length === 0, failed };
}

// ------------------------------------------------------------------------------------------------ E3a (§8.3, G0-9)
export const E3A_LIMITS = { forbidden_categories: ["terminology", "value_proposition"], max_llm_hypothesis_per_page: 2 } as const;
export interface E3aResult {
  pass: boolean;
  violations: string[];
  /** для звіту: скільки LLM-лише HYPOTHESIS на сторінку */
  hypothesis_per_page: Record<string, number>;
}
/**
 * Чиста сторінка. Гейт: (1) 0 знахідок STRONG/VERIFIED без F-DET; (2) 0 F-DET-знахідок (детектори §8.1 мовчать);
 * (3) 0 LLM-знахідок terminology/value_proposition будь-якого рівня; (4) ≤ 2 LLM-лише HYPOTHESIS на сторінку.
 */
export function e3a(findings: readonly VFinding[], pages: readonly string[]): E3aResult {
  const violations: string[] = [];
  for (const f of findings) {
    if ((f.confidence === "VERIFIED" || f.confidence === "STRONG_HYPOTHESIS") && !f.families.includes("F-DET")) violations.push(`${f.confidence} без F-DET: ${f.finding_key}`);
    if (f.families.includes("F-DET")) violations.push(`детермінована знахідка на чистій сторінці: ${f.finding_key}`);
    if (isLlmOnly(f) && (E3A_LIMITS.forbidden_categories as readonly string[]).includes(f.category)) violations.push(`LLM ${f.category} на чистій сторінці: ${f.finding_key}`);
  }
  const perPage: Record<string, number> = Object.fromEntries(pages.map((p) => [p, 0]));
  for (const f of findings) if (f.confidence === "HYPOTHESIS" && isLlmOnly(f)) for (const p of f.pages) perPage[p] = (perPage[p] ?? 0) + 1;
  for (const [p, n] of Object.entries(perPage)) if (n > E3A_LIMITS.max_llm_hypothesis_per_page) violations.push(`${n} LLM HYPOTHESIS на ${p} (> ${E3A_LIMITS.max_llm_hypothesis_per_page})`);
  return { pass: violations.length === 0, violations, hypothesis_per_page: perPage };
}

// ------------------------------------------------------------------------------------------------ E3c (§8.3, DEV-16)
export interface E3cDim { id: string; label: string; categories: readonly string[] }
export const E3C_DIMS: readonly E3cDim[] = [
  { id: "shipping_removed", label: "shipping removed", categories: ["shipping", "missing_information"] },
  { id: "cta_less_visible", label: "CTA less visible", categories: ["cta", "visual_hierarchy"] },
  { id: "vague_headline", label: "vague headline", categories: ["value_proposition"] },
  { id: "comparison_help_removed", label: "comparison help removed", categories: ["comparison", "product_selection"] },
  { id: "trust_hidden", label: "trust hidden", categories: ["trust"] },
];
export const E3C_THRESHOLDS = { delta_priority: 5, min_worse: 4 } as const;

export interface E3cDimResult {
  id: string;
  label: string;
  d_original: number;
  d_degraded: number;
  new_strong_or_verified: string[];
  worse: boolean;
  /** worse лише за F-DET/F-SUP/F-BRW знахідками */
  worse_code: boolean;
  /** worse лише за LLM-лише знахідками */
  worse_llm: boolean;
  source: "code" | "llm" | "mixed" | "none";
}
export interface E3cResult {
  dims: E3cDimResult[];
  worse: number;
  worse_code: number;
  /** worse-виміри, що НЕ підтверджені кодом (тобто залежать від LLM → ⏭️ live) */
  worse_llm_only: number;
  pass: boolean;
  /** інформативно: |ΔD| для категорій поза п'ятьма вимірами */
  other_delta: Record<string, number>;
}

const dSum = (fs: readonly VFinding[], cats: readonly string[]): number => fs.filter((f) => cats.includes(f.category)).reduce((a, f) => a + f.priority, 0);
function worseOn(orig: readonly VFinding[], degr: readonly VFinding[], cats: readonly string[]): { worse: boolean; d0: number; d1: number; fresh: string[] } {
  const d0 = dSum(orig, cats);
  const d1 = dSum(degr, cats);
  const origKeys = new Set(orig.map((f) => f.finding_key));
  const fresh = degr.filter((f) => cats.includes(f.category) && (f.confidence === "VERIFIED" || f.confidence === "STRONG_HYPOTHESIS") && !origKeys.has(f.finding_key)).map((f) => f.finding_key);
  return { worse: d1 >= d0 + E3C_THRESHOLDS.delta_priority || fresh.length > 0, d0, d1, fresh };
}

export function e3c(orig: readonly VFinding[], degr: readonly VFinding[]): E3cResult {
  const dims: E3cDimResult[] = E3C_DIMS.map((dim) => {
    const all = worseOn(orig, degr, dim.categories);
    const code = worseOn(orig.filter(hasNonLlmFamily), degr.filter(hasNonLlmFamily), dim.categories);
    const llm = worseOn(orig.filter(isLlmOnly), degr.filter(isLlmOnly), dim.categories);
    return {
      id: dim.id, label: dim.label, d_original: all.d0, d_degraded: all.d1, new_strong_or_verified: all.fresh, worse: all.worse, worse_code: code.worse, worse_llm: llm.worse,
      source: !all.worse ? "none" : code.worse ? "code" : llm.worse ? "llm" : "mixed",
    };
  });
  const inDims = new Set(E3C_DIMS.flatMap((d) => d.categories));
  const cats = new Set([...orig, ...degr].map((f) => f.category).filter((c) => !inDims.has(c)));
  const other_delta = Object.fromEntries([...cats].sort().map((c) => [c, Math.abs(dSum(degr, [c]) - dSum(orig, [c]))]));
  const worse = dims.filter((d) => d.worse).length;
  return {
    dims, worse, worse_code: dims.filter((d) => d.worse_code).length, worse_llm_only: dims.filter((d) => d.worse && !d.worse_code).length,
    pass: worse >= E3C_THRESHOLDS.min_worse, other_delta,
  };
}

// ------------------------------------------------------------------------------------------------ E4
export interface E4Input {
  max_audit_tokens: number;
  used_tokens: number;
  cache_read_tokens: number;
  llm_calls: number;
  /** лічильник звіту === лічильник клієнта */
  client_used_tokens: number;
  /** етап зупинено бюджетом (за станом етапу) */
  stage_budget_limited: boolean;
  /** банер «обмежено бюджетом» є у звіті */
  banner_budget_limited: boolean;
  planned_calls: number;
}
export interface E4Result { pass: boolean; failed: string[]; limited: boolean }
/** E4: використання ≤ ліміту; лічильник збігається; позначка є ⇔ етап зупинено (обидва напрями — щоб перевірка вміла впасти) */
export function e4(i: E4Input): E4Result {
  const failed: string[] = [];
  if (i.used_tokens > i.max_audit_tokens) failed.push(`used ${i.used_tokens} > MAX_AUDIT_TOKENS ${i.max_audit_tokens}`);
  if (i.used_tokens !== i.client_used_tokens) failed.push(`лічильник звіту ${i.used_tokens} ≠ лічильник клієнта ${i.client_used_tokens}`);
  if (i.stage_budget_limited !== i.banner_budget_limited) failed.push(`стан етапу budget_limited=${i.stage_budget_limited}, банер=${i.banner_budget_limited}`);
  if (i.stage_budget_limited && i.llm_calls >= i.planned_calls) failed.push("етап позначено обмеженим, але виконано всі заплановані виклики");
  if (!i.stage_budget_limited && i.llm_calls < i.planned_calls) failed.push(`виконано ${i.llm_calls} з ${i.planned_calls} викликів без позначки «обмежено бюджетом»`);
  return { pass: failed.length === 0, failed, limited: i.stage_budget_limited };
}
