/**
 * Чисті функції валідації E1–E4 (SCORING_SPEC §8/§12): таблиці випадків, межові значення, і кожен гейт показано на PASS та FAIL.
 */
import { describe, expect, it } from "vitest";
import {
  E1_TABLE, e1, e1Gate, e1Matches, e2Gate, e2Metrics, e2Validity, e3a, e3c, e4, jaccard, rbo, isLlmOnly, familyOfTier,
  type Family, type VConfidence, type VFinding,
} from "../src/index.js";

let n = 0;
const F = (category: string, page_group: string, o: Partial<VFinding> & { claim_kind?: string } = {}): VFinding => ({
  finding_key: o.finding_key ?? `${category}|${page_group}|${o.claim_kind ?? "general"}`, category, page_group, claim_kind: o.claim_kind ?? "general",
  confidence: o.confidence ?? "HYPOTHESIS", priority: o.priority ?? 50, rank: o.rank ?? ++n, families: o.families ?? ["F-SYN"], pages: o.pages ?? ["/"],
});
const DET = (category: string, page_group: string, claim_kind: string, o: Partial<VFinding> = {}): VFinding =>
  F(category, page_group, { claim_kind, confidence: "VERIFIED", families: ["F-DET"], priority: 90, ...o });

/** 7 детермінованих знахідок фікстури shop (ключі як у sprint-1a-fix) */
const SHOP_DET: VFinding[] = [
  DET("shipping", "product", "deep_link_only"), DET("cta", "product", "below_fold"), DET("accessibility", "*", "axe:button-name"),
  DET("mobile_usability", "product", "horizontal_overflow"), DET("performance", "/", "oversized_image"), DET("accessibility", "product", "axe:image-alt"),
  DET("pricing", "product", "not_in_first_viewport"),
];

describe("jaccard / rbo", () => {
  it.each([
    [[], [], 1],
    [["a"], [], 0],
    [["a", "b"], ["a", "b"], 1],
    [["a", "b", "c"], ["b", "c", "d"], 0.5],
    [["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "x"], 4 / 6],
  ])("J(%j,%j)=%d", (a, b, want) => expect(jaccard(new Set(a), new Set(b))).toBeCloseTo(want as number, 10));
  it("RBO: ідентичні = 1, неперетинні = 0, обидва порожні = 1, обмін місцями двох перших < 1 і > 0", () => {
    const l = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    expect(rbo(l, l)).toBeCloseTo(1, 10);
    expect(rbo(l, l.map((x) => x + "'"))).toBe(0);
    expect(rbo([], [])).toBe(1);
    expect(rbo(l.slice(0, 4), l.slice(0, 4))).toBeCloseTo(1, 10);
    const swapped = ["b", "a", ...l.slice(2)];
    expect(rbo(l, swapped)).toBeLessThan(1);
    expect(rbo(l, swapped)).toBeGreaterThan(0.8);
  });
  it("RBO ранжований: розбіжність угорі коштує більше, ніж унизу", () => {
    const l = ["a", "b", "c", "d", "e", "f"];
    expect(rbo(l, ["x", ...l.slice(1)])).toBeLessThan(rbo(l, [...l.slice(0, 5), "x"]));
  });
});

describe("E1: збіг з таблицею §8.1 + claim_kind-уточнення", () => {
  it("на повному наборі: детерміновані 7/7, LLM 0/3, разом 7 → гейт (≥ 8) НЕ проходить без LLM-дефектів", () => {
    const r = e1(SHOP_DET);
    expect(r.det).toEqual({ x: 7, of: 7 });
    expect(r.llm).toEqual({ y: 0, of: 3 });
    expect(r.total).toBe(7);
    expect(e1Gate(r)).toBe(false);
  });
  it("+ два LLM-дефекти → 9 і гейт проходить; LLM-лише = 2/3", () => {
    const r = e1([...SHOP_DET, F("value_proposition", "/"), F("terminology", "category", { families: ["F-INF"] })]);
    expect(r.llm.y).toBe(2);
    expect(r.total).toBe(9);
    expect(e1Gate(r)).toBe(true);
  });
  it("детермінований дефект не зараховується, якщо не VERIFIED (HYPOTHESIS) або без F-DET", () => {
    const soft = SHOP_DET.map((f) => (f.category === "shipping" ? { ...f, confidence: "HYPOTHESIS" as VConfidence, families: ["F-INC" as Family] } : f));
    expect(e1(soft).det.x).toBe(6);
  });
  it("уточнення: overflow (mobile_usability|product) НЕ зараховується як #5 CTA", () => {
    const d5 = E1_TABLE.find((d) => d.id === 5)!;
    expect(e1Matches(d5, DET("mobile_usability", "product", "horizontal_overflow"))).toBe(false);
    expect(e1Matches(d5, DET("cta", "product", "below_fold"))).toBe(true);
    const r = e1([DET("mobile_usability", "product", "horizontal_overflow")]);
    expect(r.detected.find((d) => d.id === 5)?.detected).toBe(false);
    expect(r.detected.find((d) => d.id === 7)?.detected).toBe(true);
  });
  it("наскрізна група axe `*` збігається з будь-якою вимогою; неправильна група не збігається", () => {
    expect(e1Matches(E1_TABLE.find((d) => d.id === 2)!, DET("shipping", "*", "deep_link_only"))).toBe(true);
    expect(e1Matches(E1_TABLE.find((d) => d.id === 2)!, DET("shipping", "category", "deep_link_only"))).toBe(false);
  });
  it("LLM-знахідка, що збіглась лише за детермінованою родиною, не рахується в E1_llm", () => {
    expect(e1([DET("value_proposition", "/", "general")]).llm.y).toBe(0);
  });
  it("непередбачені знахідки перелічуються", () => {
    expect(e1([F("trust", "/")]).unexpected).toEqual(["trust|/|general"]);
  });
});

describe("E2: метрики й гейт (пороги §8.2)", () => {
  const top = (cats: string[], pg = "product"): VFinding[] => cats.map((c, i) => F(c, pg, { rank: i + 1, finding_key: `${c}|${pg}|k` }));
  const same = ["shipping", "cta", "pricing", "performance", "accessibility"];
  it("3 ідентичні прогони → J=1, RBO=1, K3=3 → PASS", () => {
    const m = e2Metrics([top(same), top(same), top(same)]);
    expect(m).toMatchObject({ jcat_mean: 1, jcat_min: 1, jpg_mean: 1, jpg_min: 1, rbo10_mean: expect.closeTo(1, 10) });
    expect(m.k3).toHaveLength(3);
    expect(e2Gate(m)).toEqual({ pass: true, failed: [] });
  });
  it("три різні топи → FAIL за всіма J і K3", () => {
    const a = top(["shipping", "cta", "pricing", "performance", "accessibility"], "product");
    const b = top(["trust", "navigation", "checkout", "other", "content_overload"], "/");
    const c = top(["comparison", "terminology", "value_proposition", "product_selection", "missing_information"], "category");
    const m = e2Metrics([a, b, c]);
    expect(m.jcat_mean).toBe(0);
    expect(m.k3).toEqual([]);
    const g = e2Gate(m);
    expect(g.pass).toBe(false);
    expect(g.failed.length).toBe(5);
  });
  it("межа Jcat_min: 3 спільні з 5 (J=3/7≈0.4286) < 0.43 → FAIL; 4 спільні (4/6) → PASS за min", () => {
    const base = top(same);
    const three = top(["shipping", "cta", "pricing", "x1", "x2"]);
    const four = top(["shipping", "cta", "pricing", "performance", "x2"]);
    expect(e2Gate(e2Metrics([base, base, three])).failed.some((s) => s.startsWith("Jcat_min"))).toBe(true);
    expect(e2Gate(e2Metrics([base, base, four])).pass).toBe(true);
  });
  it("K3: топ-3 відтворюється лише в 1 з 3 прогонів → ключ не в K3", () => {
    const a = top(same);
    const b = top(["trust", "navigation", "checkout", "performance", "accessibility"]);
    const c = top(["comparison", "terminology", "value_proposition", "performance", "accessibility"]);
    expect(e2Metrics([a, b, c]).k3).toEqual([]);
  });
  it("порядок за rank, а не за порядком масиву", () => {
    const a = top(same);
    expect(e2Metrics([[...a].reverse(), a, a]).jcat_mean).toBe(1);
  });
  it("E2(б): порожня підмножина → set_sizes = 0 (викликач має позначити «немає LLM-знахідок», не «стабільно»)", () => {
    expect(e2Metrics([[], [], []]).set_sizes).toEqual([0, 0, 0]);
    expect(e2Metrics([[], [], []]).jcat_mean).toBe(1);
  });
  it("валідність: cache_read_tokens>0, читання кешу, cache_mode=use і < 3 прогонів → недійсний; коректний → дійсний", () => {
    const ok = { cache_read_tokens: 0, cache_reads: 0, cache_mode: "bypass" as const };
    expect(e2Validity([ok, ok, ok])).toEqual({ valid: true, reasons: [] });
    expect(e2Validity([ok, { ...ok, cache_read_tokens: 10 }, ok]).valid).toBe(false);
    expect(e2Validity([ok, { ...ok, cache_reads: 1 }, ok]).valid).toBe(false);
    expect(e2Validity([ok, { ...ok, cache_mode: "use" }, ok]).valid).toBe(false);
    expect(e2Validity([ok, ok]).valid).toBe(false);
  });
});

describe("E3a: чиста сторінка", () => {
  const pages = ["/", "/catalog", "/product/x"];
  it("порожній звіт → PASS", () => expect(e3a([], pages).pass).toBe(true));
  it.each([
    ["LLM terminology (будь-який рівень)", F("terminology", "category", { pages: ["/catalog"] })],
    ["LLM value_proposition", F("value_proposition", "/", { pages: ["/"] })],
    ["STRONG без F-DET", F("comparison", "category", { confidence: "STRONG_HYPOTHESIS", pages: ["/catalog"] })],
    ["VERIFIED без F-DET (F-BRW не F-DET)", F("cta", "product", { confidence: "VERIFIED", families: ["F-BRW"], pages: ["/product/x"] })],
    ["детермінована знахідка", DET("performance", "/", "oversized_image", { pages: ["/"] })],
  ])("FAIL: %s", (_n, f) => expect(e3a([f], pages).pass).toBe(false));
  it("≤ 2 LLM HYPOTHESIS на сторінку → PASS; 3 → FAIL; SUP-опертий HYPOTHESIS не рахується", () => {
    const h = (c: string) => F(c, "/", { pages: ["/"] });
    expect(e3a([h("trust"), h("navigation")], pages).pass).toBe(true);
    const three = e3a([h("trust"), h("navigation"), h("checkout")], pages);
    expect(three.pass).toBe(false);
    expect(three.hypothesis_per_page["/"]).toBe(3);
    expect(e3a([h("trust"), h("navigation"), F("checkout", "/", { pages: ["/"], families: ["F-SUP", "F-INF"] })], pages).pass).toBe(true);
  });
});

describe("E3c: деградація (worse: ΔD ≥ 5 або нова STRONG/VERIFIED)", () => {
  const orig = [F("trust", "/", { priority: 30, finding_key: "trust|/|general" })];
  it("нічого не змінилось → 0/5, FAIL", () => {
    const r = e3c(orig, orig);
    expect(r.worse).toBe(0);
    expect(r.pass).toBe(false);
  });
  it("ΔD рівно 5 → worse; 4.99 → ні", () => {
    const at = (p: number) => e3c([], [F("value_proposition", "/", { priority: p })]).dims.find((d) => d.id === "vague_headline")!.worse;
    expect(at(5)).toBe(true);
    expect(at(4.99)).toBe(false);
  });
  it("нова VERIFIED знахідка з малим priority теж worse (друга гілка предиката)", () => {
    const r = e3c([], [DET("shipping", "product", "deep_link_only", { priority: 2 })]);
    expect(r.dims[0]).toMatchObject({ id: "shipping_removed", worse: true, worse_code: true, source: "code" });
  });
  it("4 з 5, атрибуція: код (shipping, cta) окремо від LLM (headline, comparison)", () => {
    const degr = [
      DET("shipping", "product", "deep_link_only"), DET("cta", "product", "below_fold"),
      F("value_proposition", "/", { priority: 40 }), F("comparison", "category", { priority: 40 }),
    ];
    const r = e3c([], degr);
    expect(r.worse).toBe(4);
    expect(r.pass).toBe(true);
    expect(r.worse_code).toBe(2);
    expect(r.worse_llm_only).toBe(2);
    expect(r.dims.map((d) => d.source)).toEqual(["code", "code", "llm", "llm", "none"]);
  });
  it("3 з 5 → FAIL (поріг 4)", () => {
    const r = e3c([], [DET("shipping", "product", "deep_link_only"), DET("cta", "product", "below_fold"), F("trust", "/", { priority: 40 })]);
    expect(r.worse).toBe(3);
    expect(r.pass).toBe(false);
  });
  it("зміни поза п'ятьма вимірами — лише |ΔD| (інформативно)", () => {
    const r = e3c([F("pricing", "product", { priority: 10 })], [F("pricing", "product", { priority: 30 })]);
    expect(r.other_delta).toEqual({ pricing: 20 });
    expect(r.worse).toBe(0);
  });
});

describe("E4: бюджет", () => {
  const base = { max_audit_tokens: 100_000, used_tokens: 60_000, cache_read_tokens: 0, llm_calls: 16, client_used_tokens: 60_000, stage_budget_limited: false, banner_budget_limited: false, planned_calls: 16 };
  it("без обмеження: усі виклики, без банера → PASS", () => expect(e4(base)).toEqual({ pass: true, failed: [], limited: false }));
  it("обмежено: менше викликів, є і стан, і банер → PASS з limited", () => {
    expect(e4({ ...base, llm_calls: 5, stage_budget_limited: true, banner_budget_limited: true })).toEqual({ pass: true, failed: [], limited: true });
  });
  it.each([
    ["перевищення ліміту", { used_tokens: 100_001, client_used_tokens: 100_001 }],
    ["лічильник розходиться", { client_used_tokens: 59_999 }],
    ["зупинено без банера", { llm_calls: 5, stage_budget_limited: true }],
    ["банер без зупинки", { banner_budget_limited: true }],
    ["менше викликів без позначки", { llm_calls: 5 }],
    ["позначка, але всі виклики виконано", { stage_budget_limited: true, banner_budget_limited: true }],
  ])("FAIL: %s", (_n, o) => expect(e4({ ...base, ...o }).pass).toBe(false));
});

describe("родини", () => {
  it("tier → family; LLM-лише = без F-DET/F-SUP/F-BRW", () => {
    expect(["ET-DET", "ET-SUP", "ET-BRW", "ET-SYN-M", "ET-SYN-1", "ET-INF", "ET-INC"].map(familyOfTier)).toEqual(["F-DET", "F-SUP", "F-BRW", "F-SYN", "F-SYN", "F-INF", "F-INC"]);
    expect(familyOfTier(null)).toBeNull();
    expect(isLlmOnly({ families: ["F-SYN", "F-INF", "F-INC"] })).toBe(true);
    expect(isLlmOnly({ families: ["F-SYN", "F-SUP"] })).toBe(false);
  });
});
