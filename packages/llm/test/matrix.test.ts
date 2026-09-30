import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_TYPES, type BehavioralLens, type Task } from "@sitelens/schemas";
import { MATRIX_MAX, MATRIX_MIN, buildMatrix, isImportantTask, poleById, selectAdaptiveJournals, selectFixedJournals, selectLenses, validateMatrix, relevance, toScenarios } from "../src/index.js";
import { candidateToLens, LensCandidate } from "../src/schemas.js";
import { shopLensCandidates, shopTasksResponse } from "../src/testing/synthetic-shop.js";
import { ARTIFACT_DIR, poleSeededLenses, rng } from "./helpers.js";

const task = (id: string, type: string, primary = false): Task => ({ task_id: id, name: id, goal: id, success_conditions: ["x"], failure_conditions: [], recommended_start_page: "http://x/", max_actions: 8, task_type: type as Task["task_type"], is_primary_goal: primary });
const randomTasks = (seed: number): Task[] => {
  const r = rng(seed);
  const n = 4 + Math.floor(r() * 4);
  const types = [...TASK_TYPES].sort(() => r() - 0.5).slice(0, n);
  return types.map((t, i) => task(`t${i + 1}`, t, i === 0 ? true : false));
};
const shopLenses = (): BehavioralLens[] => selectLenses(shopLensCandidates().map((c) => candidateToLens(LensCandidate.parse(c), "run").lens), 12).selected;
const shopTasks = (): Task[] => shopTasksResponse().tasks.map((t) => ({ ...t, recommended_start_page: "http://x/" }) as Task);

describe("матриця сценаріїв (SCORING_SPEC §10.2, G0-20)", () => {
  it("фікстура shop: 12 лінз × 6 задач → 30 сесій, покриття без порушень", () => {
    const L = shopLenses(), T = shopTasks();
    expect(L).toHaveLength(12);
    const m = buildMatrix(L, T);
    expect(m.violations).toEqual([]);
    expect(m.entries.length).toBe(30);
    expect(m.entries.length).toBeGreaterThanOrEqual(MATRIX_MIN);
    expect(m.entries.length).toBeLessThanOrEqual(MATRIX_MAX);
    expect(L.every((l) => m.entries.some((e) => e.lens_id === l.id))).toBe(true);
    for (const t of T.filter(isImportantTask)) {
      const ls = m.entries.filter((e) => e.task_id === t.task_id).map((e) => L.find((l) => l.id === e.lens_id)!);
      expect(ls.length).toBeGreaterThanOrEqual(m.flags.includes("matrix_overflow") ? 3 : 4);
      expect(ls.some((l) => poleById("P1").pred(l))).toBe(true);
      expect(ls.some((l) => poleById("P2").pred(l))).toBe(true);
    }
    const mobile = m.entries.filter((e) => e.device === "mobile").length / m.entries.length;
    expect(mobile).toBeGreaterThanOrEqual(0.4);
  });

  it("детермінізм: перестановка лінз і задач дає ту саму матрицю", () => {
    const L = shopLenses(), T = shopTasks();
    const a = buildMatrix(L, T).entries, b = buildMatrix([...L].reverse(), [...T].reverse()).entries;
    const key = (e: { lens_id: string; task_id: string; device: string }) => `${e.lens_id}|${e.task_id}|${e.device}`;
    expect(a.map(key).sort()).toEqual(b.map(key).sort());
  });

  const results = { combos: 0, no_violations: 0, sizes: {} as Record<number, number>, overflow_flag: 0, important_min_lenses: 99, violations: [] as string[] };
  it("300 випадкових комбінацій (лінзи з полюсами × 4–7 задач): порушень 0", () => {
    for (let s = 1; s <= 300; s++) {
      const L = selectLenses(poleSeededLenses(s), 8 + (s % 13)).selected;
      const T = randomTasks(s);
      const m = buildMatrix(L, T);
      results.combos++;
      results.sizes[m.entries.length] = (results.sizes[m.entries.length] ?? 0) + 1;
      if (m.flags.includes("matrix_overflow")) results.overflow_flag++;
      if (m.violations.length === 0) results.no_violations++; else results.violations.push(`s${s} (|L|=${L.length}): ${m.violations.slice(0, 3).join("; ")}`);
      for (const t of T.filter(isImportantTask)) results.important_min_lenses = Math.min(results.important_min_lenses, m.entries.filter((e) => e.task_id === t.task_id).length);
    }
    expect(results.violations).toEqual([]);
    expect(results.no_violations).toBe(300);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(path.join(ARTIFACT_DIR, "matrix-random-300.json"), JSON.stringify({ ...results, note: "SYNTHETIC: випадкові лінзи/задачі, доводить код матриці §10.2" }, null, 2) + "\n");
  });

  it("гілка matrix_overflow: 10 важливих задач (поза межею 4–7 схеми, лише щоб примусити гілку) → прапорець, ≥ 3 лінз на задачу, розмір ≤ 40", () => {
    // при 4–7 задачах і ≤ 20 лінзах гілка недосяжна (перевірено 600 комбінаціями, max = 40): тому позитивний випадок штучний
    const L = selectLenses(poleSeededLenses(11), 12).selected;
    const T = Array.from({ length: 10 }, (_, i) => task(`t${i + 1}`, TASK_TYPES[i % 5 === 0 ? 0 : (i % 6) + 1]!, true));
    const m = buildMatrix(L, T);
    expect(m.flags).toContain("matrix_overflow");
    expect(m.entries.length).toBeLessThanOrEqual(MATRIX_MAX);
    for (const t of T) expect(m.entries.filter((e) => e.task_id === t.task_id).length).toBeGreaterThanOrEqual(3);
    // без прапорця ті самі дані ≥ 4 вимагали б > 40: validateMatrix без прапорця дає порушення
    expect(validateMatrix({ entries: m.entries, flags: [] }, L, T).some((x) => x.startsWith("important_task_lenses"))).toBe(true);
  });

  it("предикат покриття вміє впасти: пошкоджена матриця дає перелік порушень", () => {
    const L = shopLenses(), T = shopTasks();
    const m = buildMatrix(L, T);
    const imp = T.find(isImportantTask)!;
    const broken = { flags: m.flags, entries: m.entries.filter((e) => !(e.task_id === imp.task_id)) };
    const v = validateMatrix(broken, L, T);
    expect(v.some((x) => x.startsWith("important_task_lenses"))).toBe(true);
    expect(validateMatrix({ flags: [], entries: m.entries.slice(0, 10) }, L, T).some((x) => x.startsWith("size:"))).toBe(true);
    const noExpert = { flags: [], entries: m.entries.filter((e) => !poleById("P2").pred(L.find((l) => l.id === e.lens_id)!)) };
    expect(validateMatrix(noExpert, L, T).some((x) => x.startsWith("important_task_pole") || x.startsWith("lens_without_task"))).toBe(true);
    expect(validateMatrix({ flags: [], entries: [...m.entries, m.entries[0]!] }, L, T).some((x) => x.startsWith("duplicate"))).toBe(true);
    expect(validateMatrix({ flags: [], entries: m.entries.map((e) => ({ ...e, device: "desktop" as const })) }, L, T).some((x) => x.includes("mobile"))).toBe(true);
  });

  it("релевантність: у [0,1], ваги §10.1 (контроль на відомих значеннях)", () => {
    const [l] = shopLenses();
    for (const t of TASK_TYPES) { const r = relevance(l!, t); expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThanOrEqual(1); }
    const probe = { ...l!, category_knowledge: 0, visual_sensitivity: 1, decision_speed: 1, convenience_priority: 1 } as BehavioralLens;
    expect(relevance(probe, "understand_offering")).toBeCloseTo(1, 9);
    const zero = { ...l!, price_sensitivity: 0, risk_aversion: 0, detail_preference: 0, comparison_tendency: 0 } as BehavioralLens;
    expect(relevance(zero, "total_price")).toBeCloseTo(0, 9);
  });

  it("сценарії мають стабільні id й selected=true", () => {
    const L = shopLenses(), T = shopTasks();
    const m = buildMatrix(L, T);
    const a = toScenarios("run_1", m.entries), b = toScenarios("run_1", m.entries);
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
    expect(toScenarios("run_2", m.entries)[0]!.id).not.toBe(a[0]!.id);
  });
});

describe("журнали §10.3: 8 фіксованих + до 8 адаптивних", () => {
  it("shop: 8 слотів, трійки (lens,task,device) не повторюються, слот 1 = primary desktop, слот 2 = P1 mobile, слот 3 = P2 desktop", () => {
    const L = shopLenses(), T = shopTasks();
    const j = selectFixedJournals(L, T);
    expect(j.journals).toHaveLength(8);
    expect(new Set(j.journals.map((x) => `${x.lens_id}|${x.task_id}|${x.device}`)).size).toBe(8);
    const by = (n: number) => j.journals.find((x) => x.slot === n)!;
    expect(by(1).device).toBe("desktop");
    expect(T.find((t) => t.task_id === by(1).task_id)!.task_type).toBe("add_to_cart");
    expect(by(2).device).toBe("mobile");
    expect(poleById("P1").pred(L.find((l) => l.id === by(2).lens_id)!)).toBe(true);
    expect(poleById("P2").pred(L.find((l) => l.id === by(3).lens_id)!)).toBe(true);
    expect(by(6).task_id).toBe(by(1).task_id);
    expect(by(6).lens_id).not.toBe(by(1).lens_id);
    expect(by(8).lens_id).not.toBe(by(4).lens_id);
    expect(j.flags.filter((f) => f.startsWith("slot_empty"))).toEqual([]);
  });
  it("слот без пари → slot_relaxed (не мовчки): без P1-лінз слот 2 позначено", () => {
    const L = shopLenses().filter((l) => !poleById("P1").pred(l));
    const j = selectFixedJournals(L, shopTasks());
    expect(j.flags).toContain("slot_relaxed:2");
    expect(j.journals.find((x) => x.slot === 2)).toBeTruthy();
  });
  it("адаптивні: ≤ 8, за prelim_priority desc, зупинка коли бюджет < 1.2·est", () => {
    const L = shopLenses(), T = shopTasks();
    const fixed = selectFixedJournals(L, T).journals;
    const cands = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, prelim_priority: 50 + i }));
    const a = selectAdaptiveJournals({ candidates: cands, lenses: L, tasks: T, fixed, budget_remaining: 10_000_000 });
    expect(a).toHaveLength(8);
    const used = new Set([...fixed, ...a].map((x) => `${x.lens_id}|${x.task_id}|${x.device}`));
    expect(used.size).toBe(16);
    const few = selectAdaptiveJournals({ candidates: cands, lenses: L, tasks: T, fixed, budget_remaining: 250_000, est_journey_tokens: 80_000 });
    expect(few).toHaveLength(2); // 250k → 1.2·80k=96k: після двох лишається 90k < 96k
    expect(selectAdaptiveJournals({ candidates: cands, lenses: L, tasks: T, fixed, budget_remaining: 50_000 })).toHaveLength(0);
  });
});

describe("слот 5 (skeptical): credibility або будь-яка важлива (§10.3)", () => {
  it("є credibility-задача → слот 5 бере її; немає → береться важлива задача БЕЗ slot_relaxed", () => {
    const L = shopLenses();
    const T = shopTasks();
    const s5 = selectFixedJournals(L, T).journals.find((j) => j.slot === 5)!;
    expect(T.find((t) => t.task_id === s5.task_id)!.task_type).toBe("credibility");
    const noCred = T.filter((t) => t.task_type !== "credibility");
    const j = selectFixedJournals(L, noCred);
    const s5b = j.journals.find((x) => x.slot === 5)!;
    expect(isImportantTask(noCred.find((t) => t.task_id === s5b.task_id)!)).toBe(true);
    expect(j.flags).not.toContain("slot_relaxed:5");
  });
});
