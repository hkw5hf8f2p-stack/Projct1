/** DEV-93: швидкий аудит — параметри існуючих етапів (лінзи k=6/min=6, матриця ~12, журнали ≤ 2). Повний режим — без змін (контролі). */
import { describe, expect, it } from "vitest";
import { TASK_TYPES, type BehavioralLens, type Task } from "@sitelens/schemas";
import { FULL_MATRIX, POLES, QUICK_MATRIX, buildMatrix, coveredPoles, dedupe, selectFixedJournals, selectLenses, validateMatrix } from "../src/index.js";
import { candidateToLens, LensCandidate } from "../src/schemas.js";
import { shopLensCandidates, shopTasksResponse } from "../src/testing/synthetic-shop.js";
import { poleSeededLenses, rng } from "./helpers.js";

const shopCands = (): BehavioralLens[] => shopLensCandidates().map((c) => candidateToLens(LensCandidate.parse(c), "run").lens);
const shopTasks = (): Task[] => shopTasksResponse().tasks.map((t) => ({ ...t, recommended_start_page: "http://x/" }) as Task);
const task = (id: string, type: string, primary = false): Task => ({ task_id: id, name: id, goal: id, success_conditions: ["x"], failure_conditions: [], recommended_start_page: "http://x/", max_actions: 8, task_type: type as Task["task_type"], is_primary_goal: primary });
const randomTasks = (seed: number): Task[] => {
  const r = rng(seed);
  const n = 4 + Math.floor(r() * 4);
  return [...TASK_TYPES].sort(() => r() - 0.5).slice(0, n).map((t, i) => task(`t${i + 1}`, t, i === 0));
};

describe("quick: лінзи (k=6, min=6)", () => {
  it("shop: 6–7 лінз, усі доступні полюси покрито; повний режим і далі ≥ 8", () => {
    const q = selectLenses(shopCands(), 6, 6);
    expect(q.selected.length).toBeGreaterThanOrEqual(6);
    expect(q.selected.length).toBeLessThanOrEqual(7); // полюси добираються першими: k=6 при 7 полюсах може дати 7, якщо жодна лінза не покриває два
    const avail = POLES.filter((p) => dedupe(shopCands()).kept.some((l) => p.pred(l))).map((p) => p.id);
    expect(coveredPoles(q.selected).sort()).toEqual(avail.sort());
    // контроль: без min (повний аудит) k=6 піднімається до 8 (C5 без змін)
    expect(selectLenses(shopCands(), 6).selected.length).toBe(8);
  });

  it("300 наборів із представниками полюсів: 7/7 полюсів покрито при 6 ≤ |L| ≤ 7; відсутній полюс — pole_unmet (видно), не мовчки", () => {
    const bad: string[] = [];
    for (let s = 1; s <= 300; s++) {
      const c = poleSeededLenses(s);
      const r = selectLenses(c, 6, 6);
      const kept = dedupe(c).kept;
      const avail = POLES.filter((p) => kept.some((l) => p.pred(l))).map((p) => p.id);
      const cov = coveredPoles(r.selected);
      if (r.selected.length < 6 || r.selected.length > 7) bad.push(`s${s}: |L|=${r.selected.length}`);
      for (const p of avail) if (!cov.includes(p)) bad.push(`s${s}: полюс ${p} втрачено`);
      for (const p of POLES.map((x) => x.id)) if (!avail.includes(p) && !r.flags.includes(`pole_unmet:${p}`)) bad.push(`s${s}: ${p} відсутній без pole_unmet`);
    }
    expect(bad).toEqual([]);
  });

  it("контроль: набір без полюса P3 → pole_unmet:P3 у швидкому режимі теж", () => {
    const noP3 = shopCands().filter((l) => !POLES.find((p) => p.id === "P3")!.pred(l));
    const r = selectLenses(noP3, 6, 6);
    expect(r.unmet_poles).toContain("P3");
    expect(r.flags).toContain("pole_unmet:P3");
  });
});

describe("quick: матриця (~12 сесій) і журнали (≤ 2)", () => {
  it("shop: 6 лінз × 6 задач → 6–14 (ціль 12) сесій, кожна лінза покрита, порушень 0; повний профіль на тих самих лінзах дає ≥ 24", () => {
    const L = selectLenses(shopCands(), 6, 6).selected, T = shopTasks();
    const q = buildMatrix(L, T, QUICK_MATRIX);
    expect(q.violations).toEqual([]);
    expect(q.entries.length).toBeGreaterThanOrEqual(QUICK_MATRIX.min);
    expect(q.entries.length).toBeLessThanOrEqual(QUICK_MATRIX.max);
    expect(q.entries.length).toBe(12);
    expect(L.every((l) => q.entries.some((e) => e.lens_id === l.id))).toBe(true);
    expect(q.entries.filter((e) => e.device === "mobile").length / q.entries.length).toBeGreaterThanOrEqual(0.4);
    expect(buildMatrix(L, T, FULL_MATRIX).entries.length).toBeGreaterThanOrEqual(24);
    expect(buildMatrix(L, T).entries).toEqual(buildMatrix(L, T, FULL_MATRIX).entries); // типовий = повний
  });

  it("300 випадкових комбінацій: розмір у [6, 14], кожна лінза має задачу, порушень 0", () => {
    const bad: string[] = [];
    const sizes: Record<number, number> = {};
    for (let s = 1; s <= 300; s++) {
      const L = selectLenses(poleSeededLenses(s), 6, 6).selected;
      const m = buildMatrix(L, randomTasks(s), QUICK_MATRIX);
      sizes[m.entries.length] = (sizes[m.entries.length] ?? 0) + 1;
      if (m.violations.length) bad.push(`s${s}: ${m.violations.slice(0, 2).join("; ")}`);
    }
    expect(bad).toEqual([]);
    expect(Object.keys(sizes).map(Number).every((n) => n >= 6 && n <= 14)).toBe(true);
  });

  it("валідатор уміє впасти: матриця без сесій однієї лінзи → lens_without_task; вихід за розмір → size", () => {
    const L = selectLenses(shopCands(), 6, 6).selected, T = shopTasks();
    const m = buildMatrix(L, T, QUICK_MATRIX);
    const cut = m.entries.filter((e) => e.lens_id !== L[0]!.id);
    expect(validateMatrix({ entries: cut, flags: m.flags }, L, T, QUICK_MATRIX).some((v) => v.startsWith("lens_without_task"))).toBe(true);
    expect(validateMatrix({ entries: m.entries.slice(0, 3), flags: m.flags }, L, T, QUICK_MATRIX).some((v) => v.startsWith("size:"))).toBe(true);
  });

  it("журнали: maxJournals=2 → 2 перші слоти (ті самі, що в повному наборі) + прапорець; типово — без змін", () => {
    const L = selectLenses(shopCands(), 12).selected, T = shopTasks();
    const full = selectFixedJournals(L, T);
    const quick = selectFixedJournals(L, T, 2);
    expect(quick.journals).toHaveLength(2);
    expect(quick.journals).toEqual(full.journals.slice(0, 2));
    expect(quick.flags).toContain("journals_capped:2");
    expect(full.flags.some((f) => f.startsWith("journals_capped"))).toBe(false);
    expect(full.journals.length).toBeGreaterThan(2);
    expect(selectFixedJournals(L, T, 0).journals).toEqual([]);
  });
});
