import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BehavioralLens } from "@sitelens/schemas";
import { POLES, clampK, coveredPoles, dedupe, lensDistance, selectFarthestOnly, selectLenses, type PoleId } from "../src/index.js";
import { ARTIFACT_DIR, randomLenses, poleSeededLenses, rng } from "./helpers.js";

describe("C5: покриття обов'язкових полюсів (1000 випадкових наборів)", () => {
  const N = 1000;
  const sets = Array.from({ length: N }, (_, i) => randomLenses(i + 1, 18));
  const stats: Record<string, unknown> & { total: number; poles_available_all: number; covered_all_when_available: number; unmet_flagged_when_unavailable: number; unavailable_sets: number; farthest_only_missing: number; size_ok: number; order_invariant_checked: number; order_invariant_ok: number; per_pole_unavailable: Record<string, number> } = { total: N, poles_available_all: 0, covered_all_when_available: 0, unmet_flagged_when_unavailable: 0, unavailable_sets: 0, farthest_only_missing: 0, size_ok: 0, seeded_sets_with_all_poles_available: 0, seeded_sets_covered: 0, order_invariant_checked: 0, order_invariant_ok: 0, per_pole_unavailable: {} };

  it("КОЖЕН полюс, який є серед кандидатів, покрито вибіркою; якщо кандидата немає — прапорець pole_unmet (100 %)", () => {
    const failures: string[] = [];
    sets.forEach((cands, i) => {
      const k = i % 5 === 0 ? undefined : 8 + (i % 13);
      const { kept } = dedupe(cands);
      const avail = POLES.filter((p) => kept.some((l) => p.pred(l))).map((p) => p.id);
      const res = selectLenses(cands, k);
      const cov = coveredPoles(res.selected);
      const missing = POLES.map((p) => p.id).filter((p) => !avail.includes(p));
      for (const m of missing) stats.per_pole_unavailable[m] = (stats.per_pole_unavailable[m] ?? 0) + 1;
      if (missing.length === 0) {
        stats.poles_available_all++;
        if (POLES.every((p) => cov.includes(p.id))) stats.covered_all_when_available++; else failures.push(`set ${i + 1}: покрито ${cov.join(",")}`);
      } else {
        stats.unavailable_sets++;
        const flagged = missing.every((m) => res.flags.includes(`pole_unmet:${m}`) && res.unmet_poles.includes(m as PoleId));
        if (flagged) stats.unmet_flagged_when_unavailable++; else failures.push(`set ${i + 1}: полюс відсутній без прапорця`);
      }
      const want = clampK(k);
      if (res.selected.length === Math.min(want, kept.length) && res.selected.length >= 8 && res.selected.length <= 20 && new Set(res.selected.map((l) => l.id)).size === res.selected.length) stats.size_ok++;
      else failures.push(`set ${i + 1}: розмір ${res.selected.length} (k=${want})`);
    });
    expect(failures).toEqual([]);
    expect(stats.covered_all_when_available).toBe(stats.poles_available_all);
    expect(stats.size_ok).toBe(N);
    // тест має сенс лише якщо обидві гілки реально зустрілись
    expect(stats.poles_available_all).toBeGreaterThan(500);
  });

  it("1000 наборів, у яких генератор дав представника КОЖНОГО полюса: покрито 7/7 у 1000/1000 (100 %)", () => {
    let full = 0, covered = 0;
    const misses: number[] = [];
    for (let i = 1; i <= 1000; i++) {
      const cands = poleSeededLenses(i);
      const { kept } = dedupe(cands);
      if (!POLES.every((p) => kept.some((l) => p.pred(l)))) continue; // дедуплікація з'їла єдиного представника — окремий випадок, лічимо
      full++;
      const res = selectLenses(cands, i % 3 === 0 ? undefined : 8 + (i % 13));
      if (POLES.every((p) => coveredPoles(res.selected).includes(p.id)) && res.unmet_poles.length === 0) covered++; else misses.push(i);
    }
    stats.seeded_sets_with_all_poles_available = full;
    stats.seeded_sets_covered = covered;
    expect(misses).toEqual([]);
    expect(full).toBeGreaterThan(900);
    expect(covered).toBe(full);
  });

  it("контроль: чистий farthest-point БЕЗ кроку полюсів НЕ покриває полюси в частині тих самих наборів (потреба C5; предикат уміє впасти)", () => {
    for (const cands of sets) {
      const { kept } = dedupe(cands);
      const avail = POLES.filter((p) => kept.some((l) => p.pred(l)));
      if (avail.length < POLES.length) continue;
      const cov = coveredPoles(selectFarthestOnly(cands));
      if (!POLES.every((p) => cov.includes(p.id))) stats.farthest_only_missing++;
    }
    expect(stats.farthest_only_missing).toBeGreaterThan(0);
  });

  it("інваріантність до порядку кандидатів (перестановка → та сама вибірка id)", () => {
    for (let i = 0; i < 200; i++) {
      const cands = sets[i]!;
      const r = rng(i + 77);
      const shuffled = [...cands].sort(() => r() - 0.5);
      const a = selectLenses(cands, 12).selected.map((l) => l.id).sort();
      const b = selectLenses(shuffled, 12).selected.map((l) => l.id).sort();
      stats.order_invariant_checked++;
      if (JSON.stringify(a) === JSON.stringify(b)) stats.order_invariant_ok++;
    }
    expect(stats.order_invariant_ok).toBe(stats.order_invariant_checked);
  });

  it("дедуплікація: майже ідентична лінза з тією ж метою відкидається; далека — ні", () => {
    const [a] = randomLenses(5, 1);
    const twin = BehavioralLens.parse({ ...a, id: "twin", category_knowledge: Math.min(1, a!.category_knowledge + 0.02) });
    const far = BehavioralLens.parse({ ...a, id: "far", category_knowledge: 1 - a!.category_knowledge, price_sensitivity: 1 - a!.price_sensitivity, trust_requirement: 1 - a!.trust_requirement, decision_speed: 1 - a!.decision_speed, detail_preference: 1 - a!.detail_preference });
    expect(lensDistance(a!, twin)).toBeLessThan(0.15);
    const d = dedupe([a!, twin, far]);
    expect(d.kept).toHaveLength(2);
    expect(d.dropped).toHaveLength(1);
    expect(d.kept.map((l) => l.id)).toContain("far");
  });

  it("межі кількості: min 8 / max 20 / за замовчуванням 12 (C5)", () => {
    const c = randomLenses(4242, 25);
    expect(selectLenses(c, 3).selected.length).toBe(8);
    expect(selectLenses(c, 99).selected.length).toBe(20);
    expect(selectLenses(c).selected.length).toBe(12);
    expect(selectLenses(c, NaN).selected.length).toBe(12);
    expect(clampK(7.9)).toBe(8);
    // менше кандидатів, ніж потрібно → прапорець, а не мовчазне доповнення
    expect(selectLenses(randomLenses(9, 6), 12).flags).toContain("insufficient_candidates");
  });

  it("записує розподіл у артефакт sprint-3", () => {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(path.join(ARTIFACT_DIR, "c5-coverage-1000.json"), JSON.stringify({ seed_range: "1..1000", candidates_per_set: 18, ...stats, note: "SYNTHETIC випадкові набори, не вихід моделі; доводить код відбору (C5), не якість генерації" }, null, 2) + "\n");
    expect(stats.total).toBe(1000);
  });
});

describe("інваріантність до audit_run_id (S4: критерій 6, E2)", () => {
  // кандидати shop мають точні збіги ключів (значення з кроком 0.05–0.1), тож тай-брейк за stableId реально спрацьовує
  it("той самий набір кандидатів під різними audit_run_id → ті самі лінзи (id і порядок) і та сама матриця (lens|task|device)", async () => {
    const { shopLensCandidates } = await import("../src/testing/synthetic-shop.js");
    const { candidateToLens } = await import("../src/schemas.js");
    const { buildMatrix } = await import("../src/index.js");
    const { shopTasksResponse } = await import("../src/testing/synthetic-shop.js");
    const { Task } = await import("@sitelens/schemas");
    const tasks = shopTasksResponse().tasks.map((t) => Task.parse({ ...t, recommended_start_page: "https://x.test/" }));
    const mk = (audit: string) => shopLensCandidates().map((c) => candidateToLens(c as never, audit).lens);
    const sels = ["run_a", "aud_0123456789abcdef", "aud_fedcba9876543210", "zzz"].map((a) => selectLenses(mk(a)).selected.map((l) => l.id));
    for (const s of sels.slice(1)) expect(s).toEqual(sels[0]);
    const mats = ["run_a", "aud_0123456789abcdef", "zzz"].map((a) => buildMatrix(selectLenses(mk(a)).selected, tasks).entries.map((e) => `${e.lens_id}|${e.task_id}|${e.device}`));
    for (const m of mats.slice(1)) expect(m).toEqual(mats[0]);
  });
});
