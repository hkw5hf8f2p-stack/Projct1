/**
 * Вибір лінз за різноманіттям (SCORING_SPEC §9, C5, G0-21). Повністю детермінований, інваріантний до порядку входу.
 * Що вирішує код: полюси, відстані, дедуплікація, вибір; LLM лише генерує кандидатів.
 */
import { LENS_VARIABLES, type BehavioralLens } from "@sitelens/schemas";
import { stableId } from "../canonical.js";

export type PoleId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";
type V = Record<(typeof LENS_VARIABLES)[number], number>;
const v = (l: BehavioralLens): V => l as unknown as V;
const pos = (x: number) => Math.max(0, x);

export interface Pole { id: PoleId; name: string; pred(l: BehavioralLens): boolean; extremity(l: BehavioralLens): number; distance(l: BehavioralLens): number }

/** §9.3 */
export const POLES: readonly Pole[] = [
  { id: "P1", name: "novice", pred: (l) => v(l).category_knowledge <= 0.3, extremity: (l) => 1 - v(l).category_knowledge, distance: (l) => pos(v(l).category_knowledge - 0.3) },
  { id: "P2", name: "expert", pred: (l) => v(l).category_knowledge >= 0.7, extremity: (l) => v(l).category_knowledge, distance: (l) => pos(0.7 - v(l).category_knowledge) },
  { id: "P3", name: "price-sensitive", pred: (l) => v(l).price_sensitivity >= 0.7, extremity: (l) => v(l).price_sensitivity, distance: (l) => pos(0.7 - v(l).price_sensitivity) },
  { id: "P4", name: "price-insensitive", pred: (l) => v(l).price_sensitivity <= 0.3, extremity: (l) => 1 - v(l).price_sensitivity, distance: (l) => pos(v(l).price_sensitivity - 0.3) },
  { id: "P5", name: "fast", pred: (l) => v(l).decision_speed >= 0.7 && v(l).detail_preference <= 0.5, extremity: (l) => (v(l).decision_speed + 1 - v(l).detail_preference) / 2, distance: (l) => pos(0.7 - v(l).decision_speed) + pos(v(l).detail_preference - 0.5) },
  { id: "P6", name: "research-heavy", pred: (l) => v(l).decision_speed <= 0.3 && v(l).detail_preference >= 0.6, extremity: (l) => (1 - v(l).decision_speed + v(l).detail_preference) / 2, distance: (l) => pos(v(l).decision_speed - 0.3) + pos(0.6 - v(l).detail_preference) },
  { id: "P7", name: "skeptical", pred: (l) => v(l).trust_requirement >= 0.7 || v(l).risk_aversion >= 0.7, extremity: (l) => Math.max(v(l).trust_requirement, v(l).risk_aversion), distance: (l) => Math.min(pos(0.7 - v(l).trust_requirement), pos(0.7 - v(l).risk_aversion)) },
];
export const poleById = (id: PoleId): Pole => POLES.find((p) => p.id === id) as Pole;

/** d(a,b) = ‖a−b‖₂ / √10 (§9.1); без min-max перемасштабування */
export function lensDistance(a: BehavioralLens, b: BehavioralLens): number {
  let s = 0;
  for (const k of LENS_VARIABLES) s += (v(a)[k] - v(b)[k]) ** 2;
  return Math.sqrt(s) / Math.sqrt(LENS_VARIABLES.length);
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "is", "it", "my", "i", "with", "that", "this", "be", "as", "at", "by",
  "і", "й", "та", "або", "до", "з", "із", "у", "в", "на", "що", "це", "для", "по", "від", "як", "чи", "я", "мій", "моя", "моє"]);
export function goalTokens(s: string): Set<string> {
  return new Set(s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t)).map((t) => t.slice(0, 5)));
}
export function goalSim(a: BehavioralLens, b: BehavioralLens): number {
  const A = goalTokens(a.primary_goal), B = goalTokens(b.primary_goal);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
export const isDuplicate = (a: BehavioralLens, b: BehavioralLens): boolean => lensDistance(a, b) < 0.15 && goalSim(a, b) >= 0.6;

/** §9.2: з групи дублікатів лишається лінза з меншим stableId (транзитивно, за компонентами зв'язності) */
export function dedupe(cands: readonly BehavioralLens[]): { kept: BehavioralLens[]; dropped: BehavioralLens[] } {
  const ids = cands.map((c) => ({ c, sid: stableId(c) })).sort((a, b) => (a.sid < b.sid ? -1 : 1));
  const kept: typeof ids = [];
  const dropped: BehavioralLens[] = [];
  for (const x of ids) {
    if (kept.some((k) => isDuplicate(k.c, x.c))) dropped.push(x.c); else kept.push(x);
  }
  return { kept: kept.map((k) => k.c), dropped };
}

export interface SelectionResult { selected: BehavioralLens[]; flags: string[]; dropped_duplicates: string[]; unmet_poles: PoleId[] }

export const clampK = (k: number | undefined, min = 8, max = 20, def = 12): number => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(k) ? (k as number) : def)));

/** §9.4. Полюси P1..P7 у фіксованому порядку, далі farthest-point. */
export function selectLenses(candidates: readonly BehavioralLens[], kRequested?: number): SelectionResult {
  const k = clampK(kRequested);
  const flags: string[] = [];
  const { kept: C, dropped } = dedupe(candidates);
  const sid = new Map(C.map((c) => [c.id, stableId(c)]));
  const S: BehavioralLens[] = [];
  const minDist = (c: BehavioralLens) => (S.length === 0 ? 1 : Math.min(...S.map((s) => lensDistance(c, s))));
  const unmet: PoleId[] = [];
  // лексикографічно: більший ключ краще; останній компонент — менший stableId
  const better = (a: number[], sa: string, b: number[], sb: string) => {
    for (let i = 0; i < a.length; i++) { const x = a[i] as number, y = b[i] as number; if (Math.abs(x - y) > 1e-12) return x > y; }
    return sa < sb;
  };
  const pick = (pool: BehavioralLens[], key: (c: BehavioralLens) => number[]) => {
    let best: BehavioralLens | null = null; let bk: number[] = [];
    for (const c of pool) {
      const kk = key(c);
      if (!best || better(kk, sid.get(c.id) as string, bk, sid.get(best.id) as string)) { best = c; bk = kk; }
    }
    return best as BehavioralLens;
  };
  for (const pole of POLES) {
    if (S.some((s) => pole.pred(s))) continue;
    const rest = C.filter((c) => !S.includes(c));
    if (rest.length === 0) break;
    let Q = rest.filter((c) => pole.pred(c));
    let c: BehavioralLens;
    if (Q.length === 0) {
      flags.push(`pole_unmet:${pole.id}`); unmet.push(pole.id);
      Q = rest;
      c = pick(Q, (x) => [-pole.distance(x)]);
    } else c = pick(Q, (x) => [pole.extremity(x), minDist(x)]);
    S.push(c);
  }
  while (S.length < k) {
    const rest = C.filter((c) => !S.includes(c));
    if (rest.length === 0) break;
    S.push(pick(rest, (x) => [minDist(x)]));
  }
  if (S.length < k) flags.push("insufficient_candidates");
  return { selected: S, flags, dropped_duplicates: dropped.map((d) => d.id), unmet_poles: unmet };
}

/** Контроль: чистий farthest-point без кроку полюсів (доводить потребу C5, §9 тест 6) */
export function selectFarthestOnly(candidates: readonly BehavioralLens[], kRequested?: number): BehavioralLens[] {
  const k = clampK(kRequested);
  const { kept: C } = dedupe(candidates);
  const S: BehavioralLens[] = [];
  const sid = (c: BehavioralLens) => stableId(c);
  while (S.length < k && S.length < C.length) {
    let best: BehavioralLens | null = null; let bd = -1;
    for (const c of C) {
      if (S.includes(c)) continue;
      const d = S.length === 0 ? 1 : Math.min(...S.map((s) => lensDistance(c, s)));
      if (!best || d > bd + 1e-12 || (Math.abs(d - bd) <= 1e-12 && sid(c) < sid(best))) { best = c; bd = d; }
    }
    S.push(best as BehavioralLens);
  }
  return S;
}

/** які полюси покриті набором */
export const coveredPoles = (set: readonly BehavioralLens[]): PoleId[] => POLES.filter((p) => set.some((l) => p.pred(l))).map((p) => p.id);
