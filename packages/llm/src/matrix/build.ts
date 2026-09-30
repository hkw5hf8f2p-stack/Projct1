/**
 * Матриця сценаріїв (SCORING_SPEC §10.2) і вибір журналів (§10.3, SPEC §19). Чисті детерміновані функції.
 * Релевантність r(lens, task) рахує код за task_type; LLM лише класифікує задачу (§10.1).
 */
import { LENS_VARIABLES, type BehavioralLens, type Scenario, type Task } from "@sitelens/schemas";
import { stableId } from "../canonical.js";
import { POLES, lensStableId, poleById, type PoleId } from "../lenses/select.js";

type VarKey = (typeof LENS_VARIABLES)[number];
/** [змінна, інвертувати?, вага] */
const W: Record<string, Array<[VarKey, boolean, number]>> = {
  understand_offering: [["category_knowledge", true, 0.4], ["visual_sensitivity", false, 0.2], ["decision_speed", false, 0.2], ["convenience_priority", false, 0.2]],
  suitability: [["category_knowledge", true, 0.35], ["detail_preference", false, 0.25], ["risk_aversion", false, 0.2], ["trust_requirement", false, 0.2]],
  choose_between: [["comparison_tendency", false, 0.4], ["detail_preference", false, 0.25], ["category_knowledge", true, 0.2], ["price_sensitivity", false, 0.15]],
  total_price: [["price_sensitivity", false, 0.45], ["risk_aversion", false, 0.2], ["detail_preference", false, 0.2], ["comparison_tendency", false, 0.15]],
  delivery: [["convenience_priority", false, 0.35], ["risk_aversion", false, 0.25], ["price_sensitivity", false, 0.2], ["decision_speed", false, 0.2]],
  credibility: [["trust_requirement", false, 0.4], ["social_proof_need", false, 0.3], ["risk_aversion", false, 0.3]],
  add_to_cart: [["decision_speed", false, 0.35], ["convenience_priority", false, 0.3], ["category_knowledge", false, 0.2], ["risk_aversion", true, 0.15]],
  other: LENS_VARIABLES.map((k) => [k, false, 0.1] as [VarKey, boolean, number]),
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function relevance(lens: BehavioralLens, taskType: string): number {
  const row = W[taskType] ?? W.other!;
  const l = lens as unknown as Record<VarKey, number>;
  return clamp01(row.reduce((a, [k, inv, w]) => a + w * (inv ? 1 - l[k] : l[k]), 0));
}

const IMPORTANT_TYPES = new Set(["understand_offering", "choose_between", "total_price", "delivery", "add_to_cart"]);
export const isImportantTask = (t: Task): boolean => IMPORTANT_TYPES.has(t.task_type) || t.is_primary_goal === true;

export type Device = "mobile" | "desktop";
export interface MatrixEntry { lens_id: string; task_id: string; level: "snapshot"; relevance: number; device: Device }
export interface MatrixResult { entries: MatrixEntry[]; flags: string[]; violations: string[]; important_task_ids: string[]; n_target: number }

export const MATRIX_MIN = 24, MATRIX_MAX = 40;
const round = (x: number) => Math.round(x * 1e9) / 1e9;

export function buildMatrix(lenses: readonly BehavioralLens[], tasks: readonly Task[]): MatrixResult {
  const sid = new Map(lenses.map((l) => [l.id, lensStableId(l)]));
  const lensById = new Map(lenses.map((l) => [l.id, l]));
  const R = new Map<string, number>();
  for (const l of lenses) for (const t of tasks) R.set(`${l.id}|${t.task_id}`, relevance(l, t.task_type));
  const r = (l: string, t: string) => R.get(`${l}|${t}`) as number;
  const important = tasks.filter(isImportantTask);
  const impIds = important.map((t) => t.task_id);
  const N = Math.min(MATRIX_MAX, Math.max(MATRIX_MIN, Math.round(2.5 * lenses.length)));

  // tie-break: (r desc, stableId(lens) asc, task_id asc)
  const cmp = (a: [string, string], b: [string, string]) => {
    const d = r(b[0], b[1]) - r(a[0], a[1]);
    if (Math.abs(d) > 1e-12) return d;
    const s = (sid.get(a[0]) as string).localeCompare(sid.get(b[0]) as string);
    return s !== 0 ? s : a[1].localeCompare(b[1]);
  };

  const attempt = (perImportant: number, dropOtherMin: boolean) => {
    const M: Array<[string, string]> = [];
    const has = new Set<string>();
    const add = (p: [string, string]) => { M.push(p); has.add(`${p[0]}|${p[1]}`); };
    const lensesOf = (t: string) => M.filter((p) => p[1] === t).map((p) => p[0]);
    const bestPair = (pool: Array<[string, string]>) => pool.filter((p) => !has.has(`${p[0]}|${p[1]}`)).sort(cmp)[0];
    // 1. кожна лінза ≥ 1 задача
    for (const l of [...lenses].sort((a, b) => (sid.get(a.id) as string).localeCompare(sid.get(b.id) as string))) {
      const p = bestPair(tasks.map((t) => [l.id, t.task_id] as [string, string]));
      if (p) add(p);
    }
    // 2. важливі ≥ perImportant лінз, інші ≥ 2
    for (const t of tasks) {
      const need = impIds.includes(t.task_id) ? perImportant : dropOtherMin ? 0 : 2;
      while (lensesOf(t.task_id).length < need) {
        const p = bestPair(lenses.map((l) => [l.id, t.task_id] as [string, string]));
        if (!p) break;
        add(p);
      }
    }
    // 3. P1 і P2 на кожній важливій; P3..P6 у ≥ 2 сесіях
    for (const t of important) for (const id of ["P1", "P2"] as PoleId[]) {
      const pole = poleById(id);
      if (lensesOf(t.task_id).some((l) => pole.pred(lensById.get(l) as BehavioralLens))) continue;
      const p = bestPair(lenses.filter((l) => pole.pred(l)).map((l) => [l.id, t.task_id] as [string, string]));
      if (p) add(p);
    }
    for (const id of ["P3", "P4", "P5", "P6"] as PoleId[]) {
      const pole = poleById(id);
      const holders = lenses.filter((l) => pole.pred(l));
      const count = () => M.filter((p) => pole.pred(lensById.get(p[0]) as BehavioralLens)).length;
      while (holders.length > 0 && count() < 2) {
        const p = bestPair(holders.flatMap((l) => tasks.map((t) => [l.id, t.task_id] as [string, string])));
        if (!p) break;
        add(p);
      }
    }
    return { M, add, has, bestPair };
  };

  const flags: string[] = [];
  let st = attempt(4, false);
  if (st.M.length > MATRIX_MAX) { flags.push("matrix_overflow"); st = attempt(3, false); }
  if (st.M.length > MATRIX_MAX) st = attempt(3, true);
  // 4. добір до N за r
  const all = lenses.flatMap((l) => tasks.map((t) => [l.id, t.task_id] as [string, string]));
  while (st.M.length < N) { const p = st.bestPair(all); if (!p) break; st.add(p); }

  // пристрої: у межах задачі за спаданням r чергуються mobile, desktop (§10.2)
  const device = new Map<string, Device>();
  for (const t of tasks) {
    const own = st.M.filter((p) => p[1] === t.task_id).sort(cmp);
    own.forEach((p, i) => device.set(`${p[0]}|${p[1]}`, i % 2 === 0 ? "mobile" : "desktop"));
  }
  const entries: MatrixEntry[] = [...st.M].sort(cmp).map(([l, t]) => ({ lens_id: l, task_id: t, level: "snapshot", relevance: round(r(l, t)), device: device.get(`${l}|${t}`) as Device }));
  const res: MatrixResult = { entries, flags, violations: [], important_task_ids: impIds, n_target: N };
  res.violations = validateMatrix(res, lenses, tasks);
  return res;
}

/** Перевірка покриття: порожній список = OK (§10.2). Порушення не ховаються — їх повертає функція. */
export function validateMatrix(m: Pick<MatrixResult, "entries" | "flags">, lenses: readonly BehavioralLens[], tasks: readonly Task[]): string[] {
  const out: string[] = [];
  const E = m.entries;
  const lensById = new Map(lenses.map((l) => [l.id, l]));
  if (E.length < MATRIX_MIN || E.length > MATRIX_MAX) out.push(`size:${E.length} поза ${MATRIX_MIN}–${MATRIX_MAX}`);
  const seen = new Set<string>();
  for (const e of E) { const k = `${e.lens_id}|${e.task_id}`; if (seen.has(k)) out.push(`duplicate:${k}`); seen.add(k); }
  for (const l of lenses) if (!E.some((e) => e.lens_id === l.id)) out.push(`lens_without_task:${l.id}`);
  const minLenses = m.flags.includes("matrix_overflow") ? 3 : 4;
  for (const t of tasks.filter(isImportantTask)) {
    const ls = E.filter((e) => e.task_id === t.task_id).map((e) => lensById.get(e.lens_id) as BehavioralLens);
    if (ls.length < minLenses) out.push(`important_task_lenses:${t.task_id}:${ls.length}<${minLenses}`);
    for (const id of ["P1", "P2"] as PoleId[]) {
      const pole = poleById(id);
      if (lenses.some((l) => pole.pred(l)) && !ls.some((l) => pole.pred(l))) out.push(`important_task_pole:${t.task_id}:${id}`);
    }
    if (!E.some((e) => e.task_id === t.task_id && e.device === "mobile")) out.push(`important_task_no_mobile:${t.task_id}`);
  }
  for (const id of ["P3", "P4", "P5", "P6"] as PoleId[]) {
    const pole = poleById(id);
    if (lenses.some((l) => pole.pred(l)) && E.filter((e) => pole.pred(lensById.get(e.lens_id) as BehavioralLens)).length < 2) out.push(`pole_sessions:${id}<2`);
  }
  if (E.length > 0 && E.filter((e) => e.device === "mobile").length / E.length < 0.4) out.push("mobile_share<40%");
  return out;
}

export function toScenarios(auditRunId: string, m: readonly Pick<MatrixEntry, "lens_id" | "task_id" | "relevance" | "device">[], level: "snapshot" | "journey" = "snapshot"): Scenario[] {
  return m.map((e) => ({ id: `sc_${stableId({ a: auditRunId, l: e.lens_id, t: e.task_id, d: e.device, level }).slice(0, 12)}`, audit_run_id: auditRunId, lens_id: e.lens_id, task_id: e.task_id, level, relevance: e.relevance, selected: true }));
}

// ------------------------------------------------------------------ §10.3 журнали
export interface JournalPick extends Omit<MatrixEntry, "level"> { level: "journey"; slot: number | "adaptive"; flags: string[] }

export function selectFixedJournals(lenses: readonly BehavioralLens[], tasks: readonly Task[]): { journals: JournalPick[]; flags: string[] } {
  const sid = new Map(lenses.map((l) => [l.id, lensStableId(l)]));
  const taskById = new Map(tasks.map((t) => [t.task_id, t]));
  const used = new Set<string>();
  const flags: string[] = [];
  const journals: JournalPick[] = [];
  const imp = (t: Task) => isImportantTask(t);
  const pairs = lenses.flatMap((l) => tasks.map((t) => ({ l, t, r: relevance(l, t.task_type) })));
  const order = (a: { l: BehavioralLens; t: Task; r: number }, b: typeof a) => (b.r - a.r) || (sid.get(a.l.id) as string).localeCompare(sid.get(b.l.id) as string) || a.t.task_id.localeCompare(b.t.task_id);
  const slot = (n: number, device: Device, pred: (p: (typeof pairs)[number]) => boolean, pole?: PoleId, exclude?: (p: (typeof pairs)[number]) => boolean, score?: (p: (typeof pairs)[number]) => number) => {
    const free = (p: (typeof pairs)[number]) => !used.has(`${p.l.id}|${p.t.task_id}|${device}`) && !(exclude?.(p));
    let pool = pairs.filter((p) => pred(p) && free(p));
    const f: string[] = [];
    if (pool.length === 0) {
      f.push(`slot_relaxed:${n}`);
      pool = pairs.filter(free);
      const pl = pole ? poleById(pole) : null;
      pool.sort((a, b) => (pl ? pl.distance(a.l) - pl.distance(b.l) : 0) || order(a, b));
    } else pool.sort((a, b) => (score ? score(b) - score(a) : 0) || order(a, b));
    const p = pool[0];
    if (!p) { flags.push(`slot_empty:${n}`); return null; }
    used.add(`${p.l.id}|${p.t.task_id}|${device}`);
    flags.push(...f);
    journals.push({ lens_id: p.l.id, task_id: p.t.task_id, level: "journey", relevance: Math.round(p.r * 1e9) / 1e9, device, slot: n, flags: f });
    return p;
  };
  const main = (p: (typeof pairs)[number]) => p.t.task_type === "add_to_cart" || p.t.is_primary_goal === true;
  const s1 = slot(1, "desktop", main);
  slot(2, "mobile", (p) => poleById("P1").pred(p.l) && imp(p.t), "P1");
  slot(3, "desktop", (p) => poleById("P2").pred(p.l) && imp(p.t), "P2");
  const s4 = slot(4, "desktop", (p) => poleById("P3").pred(p.l) && (p.t.task_type === "total_price" || p.t.task_type === "delivery"), "P3");
  slot(5, "desktop", (p) => poleById("P7").pred(p.l) && (p.t.task_type === "credibility" || imp(p.t)), "P7", undefined, (p) => (p.t.task_type === "credibility" ? 1 : 0)); // §10.3: credibility або будь-яка важлива; credibility — пріоритетно
  if (s1) slot(6, "mobile", (p) => p.t.task_id === s1.t.task_id && p.l.id !== s1.l.id); else flags.push("slot_empty:6");
  slot(7, "desktop", (p) => p.t.task_type === "choose_between", undefined, undefined, (p) => (p.l as unknown as { comparison_tendency: number }).comparison_tendency);
  slot(8, "mobile", (p) => (p.t.task_type === "delivery" || p.t.task_type === "total_price") && (!s4 || p.l.id !== s4.l.id));
  void taskById; void POLES;
  return { journals, flags };
}

export interface AdaptiveCandidate { key: string; prelim_priority: number; /** task_id-и, що торкаються сторінки кандидата; порожньо → усі */ task_ids?: string[] }

/** Адаптивні журнали (§10.3): за prelim_priority desc, stableId asc, доки < max і бюджет ≥ 1.2 · est. */
export function selectAdaptiveJournals(o: {
  candidates: readonly AdaptiveCandidate[]; lenses: readonly BehavioralLens[]; tasks: readonly Task[]; fixed: readonly JournalPick[];
  budget_remaining: number; est_journey_tokens?: number; max?: number;
}): JournalPick[] {
  const est = o.est_journey_tokens ?? 80_000;
  const max = o.max ?? 8;
  const used = new Set(o.fixed.map((j) => `${j.lens_id}|${j.task_id}|${j.device}`));
  const out: JournalPick[] = [];
  let budget = o.budget_remaining;
  const ranked = [...o.candidates].sort((a, b) => (b.prelim_priority - a.prelim_priority) || stableId(a.key).localeCompare(stableId(b.key)));
  for (const c of ranked) {
    if (out.length >= max || budget < 1.2 * est) break;
    const tasks = o.tasks.filter((t) => !c.task_ids || c.task_ids.length === 0 || c.task_ids.includes(t.task_id));
    let best: { l: BehavioralLens; t: Task; r: number; d: Device } | null = null;
    for (const l of o.lenses) for (const t of tasks) for (const d of ["desktop", "mobile"] as Device[]) {
      if (used.has(`${l.id}|${t.task_id}|${d}`)) continue;
      const r = relevance(l, t.task_type);
      if (!best || r > best.r + 1e-12) best = { l, t, r, d };
    }
    if (!best) continue;
    used.add(`${best.l.id}|${best.t.task_id}|${best.d}`);
    budget -= est;
    out.push({ lens_id: best.l.id, task_id: best.t.task_id, level: "journey", relevance: Math.round(best.r * 1e9) / 1e9, device: best.d, slot: "adaptive", flags: [] });
  }
  return out;
}
