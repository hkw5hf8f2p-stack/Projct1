/**
 * C3 — таблиця випадків SCORING_SPEC §2 (+ DEV-17/19, правило суперечності). Критерій: 100 % збігів.
 * Кожен рядок перевіряє і рівень, і правило, і силу доказу; окремий тест доводить, що перевірка вміє впасти.
 */
import { describe, expect, it } from "vitest";
import { confidence, evidenceStrength, aggregate } from "../src/index.js";
import { brw, det, inc, inf, sup, syn } from "./helpers.js";

type Row = { name: string; evs: () => ReturnType<typeof det>[]; claim?: string; counter?: () => ReturnType<typeof det>[]; level: string; rule: string; strength: number | null };

const P = "/product/a";
const PQ = { category: "shipping" as const, claim_kind: "not_on_product_page", path: P };
const S = (i: number, lens: string, task: string, level: "snapshot" | "journey" = "snapshot") => syn({ ...PQ, session: `s${i}`, lens, task, level });

const ROWS: Row[] = [
  { name: "лише axe image-alt", evs: () => [det({ category: "accessibility", claim_kind: "axe:image-alt", path: P, type: "axe", source_class: "BENCHMARKED", measurement: { impact: "critical" } })], level: "VERIFIED", rule: "C3-VERIFIED-DET", strength: 1 },
  { name: "SYN 5 сесій, 5 лінз, 1 задача, лише snapshot", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t1"), S(3, "L3", "t1"), S(4, "L4", "t1"), S(5, "L5", "t1")], level: "HYPOTHESIS", rule: "C3-HYP-DEFAULT", strength: 0.7 },
  { name: "SYN 3 лінзи, 2 задачі", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t2"), S(3, "L3", "t1")], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-B", strength: 0.7 },
  { name: "SYN 2 лінзи + INF (обидві LLM-похідні)", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t2"), inf(PQ)], level: "HYPOTHESIS", rule: "C3-HYP-DEFAULT", strength: 0.7 },
  { name: "SYN 1 лінза + ET-SUP", evs: () => [S(1, "L1", "t1"), sup(PQ)], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-A", strength: 0.4 },
  { name: "ET-BRW у 2 журналах без replay + SYN", evs: () => [brw({ ...PQ, session: "j1", reproduced: false }), brw({ ...PQ, session: "j2", reproduced: false }), S(1, "L1", "t1", "journey")], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-A", strength: 0.9 },
  { name: "ET-BRW із replay", evs: () => [brw({ ...PQ, session: "j1", reproduced: true })], level: "VERIFIED", rule: "C3-VERIFIED-BRW-REPLAY", strength: 0.9 },
  { name: "STRONG, але детектор повернув негатив", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t2"), S(3, "L3", "t1")], counter: () => [det({ ...PQ, claim_kind: "not_on_product_page", detector_id: "shipping_depth" })], level: "HYPOTHESIS", rule: "C3-HYP-CONTRADICTION", strength: 0.7 },
  { name: "відсутність ціни, повне захоплення (DEV-17)", evs: () => [det({ category: "pricing", claim_kind: "not_in_first_viewport", path: P, assertion: "absence", type: "screenshot" })], level: "VERIFIED", rule: "C3-VERIFIED-DET", strength: 1 },
  { name: "те саме, 1 заблокований запит (ET-INC)", evs: () => [inc({ category: "pricing", claim_kind: "not_in_first_viewport", path: P, blocked: 1 })], level: "HYPOTHESIS", rule: "C3-HYP-INC-CAP", strength: 0.3 },
  {
    name: "те саме + SYN 3 лінзи / 2 контексти (кап DEV-17/19)",
    evs: () => [inc({ category: "pricing", claim_kind: "not_in_first_viewport", path: P }), syn({ category: "pricing", claim_kind: "not_in_first_viewport", path: P, session: "s1", lens: "L1", task: "t1" }), syn({ category: "pricing", claim_kind: "not_in_first_viewport", path: P, session: "s2", lens: "L2", task: "t2" }), syn({ category: "pricing", claim_kind: "not_in_first_viewport", path: P, session: "s3", lens: "L3", task: "t1" })],
    level: "HYPOTHESIS", rule: "C3-HYP-INC-CAP", strength: 0.7,
  },
  // ---- додаткові межі
  { name: "позиційний below_fold при відкритому банері (DEV-19)", evs: () => [inc({ category: "cta", claim_kind: "below_fold", path: P, banner_open: true })], level: "HYPOTHESIS", rule: "C3-HYP-INC-CAP", strength: 0.3 },
  { name: "SYN 3 лінзи, 1 задача, snapshot + journey", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t1", "journey"), S(3, "L3", "t1")], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-B", strength: 0.7 },
  { name: "SYN 2 лінзи, 2 задачі (лінз < 3)", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t2")], level: "HYPOTHESIS", rule: "C3-HYP-DEFAULT", strength: 0.7 },
  { name: "SYN 3 сесії однієї лінзи в 2 задачах", evs: () => [S(1, "L1", "t1"), S(2, "L1", "t2"), S(3, "L1", "t1")], level: "HYPOTHESIS", rule: "C3-HYP-DEFAULT", strength: 0.7 },
  { name: "лише INF", evs: () => [inf(PQ)], level: "HYPOTHESIS", rule: "C3-HYP-DEFAULT", strength: 0.3 },
  { name: "INF + ET-SUP", evs: () => [inf(PQ), sup(PQ)], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-A", strength: 0.3 },
  { name: "ET-BRW у 2 журналах без replay, без SYN (одна родина)", evs: () => [brw({ ...PQ, session: "j1", reproduced: false }), brw({ ...PQ, session: "j2", reproduced: false })], level: "HYPOTHESIS", rule: "C3-HYP-DEFAULT", strength: 0.9 },
  { name: "DET + SYN — VERIFIED (SYN не знижує)", evs: () => [det(PQ), S(1, "L1", "t1")], level: "VERIFIED", rule: "C3-VERIFIED-DET", strength: 1 },
  { name: "DET + INC — VERIFIED (F-DET переважає)", evs: () => [det(PQ), inc(PQ)], level: "VERIFIED", rule: "C3-VERIFIED-DET", strength: 1 },
  { name: "сприйняття: суперечність не кепує (виняток §2)", evs: () => [S(1, "L1", "t1"), S(2, "L2", "t2"), S(3, "L3", "t1")], claim: "noticed_but_unclear", counter: () => [det(PQ)], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-B", strength: 0.7 },
  { name: "ET-BRW 1 журнал без replay (ET-SUP) + SYN 1", evs: () => [brw({ ...PQ, session: "j1", reproduced: false }), S(1, "L1", "t1", "journey")], level: "STRONG_HYPOTHESIS", rule: "C3-STRONG-A", strength: 0.4 },
];

describe("C3: таблиця випадків впевненості (SCORING_SPEC §2)", () => {
  const results = ROWS.map((r) => {
    const evs = r.evs();
    const c = confidence(evs, { claim_kind: r.claim ?? evs[0]?.claim_kind ?? "general", counter: r.counter?.() ?? [] });
    const s = evidenceStrength(evs);
    return { name: r.name, ok: c.level === r.level && c.rule === r.rule && (s?.value ?? null) === r.strength, got: `${c.level}/${c.rule}/${s?.value}`, want: `${r.level}/${r.rule}/${r.strength}` };
  });
  it.each(results)("$name", (r) => expect(r.got).toBe(r.want));
  it(`збіг ${ROWS.length}/${ROWS.length} = 100 %`, () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(22);
    expect(results.filter((r) => r.ok).length).toBe(ROWS.length);
  });
  it("перевірка вміє впасти: навмисно хибне очікування дає розбіжність", () => {
    const evs = [S(1, "L1", "t1"), S(2, "L2", "t2"), S(3, "L3", "t1")];
    expect(confidence(evs, { claim_kind: "not_on_product_page" }).level).not.toBe("HYPOTHESIS");
    // той самий набір без третьої лінзи — уже HYPOTHESIS: правило «≥3 лінзи» реально розрізняє
    expect(confidence(evs.slice(0, 2), { claim_kind: "not_on_product_page" }).level).toBe("HYPOTHESIS");
  });
  it("знахідка лише з ET-SUP не існує (§1.2): withheld sup_only", () => {
    const r = aggregate({ evidence: [sup(PQ)], pageTypes: {} });
    expect(r.findings).toHaveLength(0);
    expect(r.withheld).toEqual([expect.objectContaining({ reason: "sup_only" })]);
  });
});
