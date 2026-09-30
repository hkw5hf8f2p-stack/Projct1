/**
 * Пріоритет (SCORING_SPEC §3–§6, C1, C2, DEV-4, DEV-60): таблично, з граничними випадками.
 * Розраховані приклади §6.4 відтворюються до цілого; інваріанти §6.2; асиметрія HYPOTHESIS vs VERIFIED.
 */
import { describe, expect, it } from "vitest";
import { aggregate, funnel, priority, severity, verifiedEquivalentCap, W, SEV_BASE, FUN_STAGE, PAGE_STAGE, type SessionObs } from "../src/index.js";
import { det, inf, sess, syn } from "./helpers.js";

describe("C1: детермінована знахідка без стелі 65", () => {
  it("severity = funnel = evidence = 1, lens/session N/A → 100/100", () => {
    const p = priority({ severity: 1, funnel_proximity: 1, evidence_strength: 1, lens_coverage: null, session_frequency: null }, "VERIFIED");
    expect(p.value).toBe(100);
    // стара формула §25 (фіксовані ваги, N/A = 0) дала б 65 — перевірка вміє розрізнити
    const old = Math.round(100 * (W.severity + W.funnel_proximity + W.evidence_strength));
    expect(old).toBe(65);
    expect(p.value).not.toBe(old);
  });
  it("наскрізно через aggregate: checkout у кошику + MOD-BLOCKER → severity 1, funnel 1 → 100", () => {
    const e = det({ category: "checkout", claim_kind: "general", path: "/cart", page_type: "cart", page_group: "/cart" });
    const s = sess({ session_id: "j1", lens_id: "L1", task_id: "t1", level: "journey", success: "false", pages_seen: ["/cart"], reported_keys: ["checkout|/cart|general"], last_friction_key: "checkout|/cart|general" });
    const [f] = aggregate({ evidence: [e], sessions: [s], pageTypes: {} }).findings;
    expect(f?.severity.value).toBe(1);
    expect(f?.funnel.value).toBe(1);
    expect(f?.confidence.level).toBe("VERIFIED");
    expect(f?.priority.value).toBe(100);
  });
});

describe("§6.4 розраховані приклади", () => {
  it("приклад 1: axe image-alt на товарі → 82", () => {
    const [f] = aggregate({ evidence: [det({ category: "accessibility", claim_kind: "axe:image-alt", path: "/product/a", type: "axe", source_class: "BENCHMARKED", measurement: { impact: "critical", component_signature: "main/img" } })], pageTypes: {} }).findings;
    expect([f?.severity.value, f?.funnel.value, f?.priority.value]).toEqual([0.75, 0.8, 82]);
  });
  it("приклад 2: доставка схована + блокер у журналі → 90", () => {
    const key = "shipping|product|not_on_product_page";
    const ss: SessionObs[] = [sess({ session_id: "j1", lens_id: "L1", task_id: "t1", level: "journey", success: "false", pages_seen: ["/product/a"], reported_keys: [key], last_friction_key: key })];
    const [f] = aggregate({ evidence: [det({ category: "shipping", claim_kind: "not_on_product_page", path: "/product/a", assertion: "absence" })], sessions: ss, pageTypes: {} }).findings;
    expect([f?.severity.value, f?.funnel.value, f?.priority.value, f?.confidence.level]).toEqual([0.85, 0.9, 90, "VERIFIED"]);
  });
  it("приклад 3: жаргон, лише синтетика (14 сесій / 9 лінз / 2 задачі; 6 / 5) → 59, STRONG", () => {
    const key = "terminology|product|general";
    const seen: SessionObs[] = [];
    const evs: ReturnType<typeof syn>[] = [];
    // 14 сесій, 9 лінз, 2 задачі бачили товар; повідомили 6 сесій 5 лінз в обох задачах
    const plan: Array<[string, string, boolean]> = [
      ["L1", "t1", true], ["L2", "t1", true], ["L3", "t2", true], ["L4", "t2", true], ["L5", "t1", true], ["L5", "t2", true],
      ["L6", "t1", false], ["L7", "t2", false], ["L8", "t1", false], ["L9", "t2", false], ["L1", "t2", false], ["L2", "t2", false], ["L3", "t1", false], ["L4", "t1", false],
    ];
    plan.forEach(([lens, task, rep], i) => {
      seen.push(sess({ session_id: `s${i}`, lens_id: lens, task_id: task, pages_seen: ["/product/a"], reported_keys: rep ? [key] : [] }));
      if (rep) evs.push(syn({ category: "terminology", claim_kind: "general", path: "/product/a", page_type: "product", session: `s${i}`, lens, task }));
    });
    const [f] = aggregate({ evidence: evs, sessions: seen, pageTypes: { "/product/a": "product" } }).findings;
    expect(f?.coverage.lens).toEqual({ n: 5, m: 9 });
    expect(f?.coverage.session).toEqual({ n: 6, m: 14 });
    expect([f?.severity.value, f?.strength.value, f?.priority.value, f?.confidence.level]).toEqual([0.5, 0.7, 59, "STRONG_HYPOTHESIS"]);
  });
  it("приклад 4 (граничний): 34.5 → 35 завдяки EPS; HYPOTHESIS", () => {
    const seen = Array.from({ length: 10 }, (_, i) => sess({ session_id: `s${i}`, lens_id: `L${i}`, task_id: "t1", pages_seen: ["/"] }));
    const [f] = aggregate({ evidence: [inf({ category: "value_proposition", claim_kind: "general", path: "/", page_type: "homepage", page_group: "/" })], sessions: seen, pageTypes: {} }).findings;
    expect([f?.severity.value, f?.funnel.value, f?.priority.uncapped, f?.priority.value, f?.confidence.level]).toEqual([0.8, 0.3, 35, 35, "HYPOTHESIS"]);
    // без EPS: Math.floor(34.49999… + 0.5) = 34 — кейс реально граничний
    expect(0.3 * 0.8 + 0.2 * 0.3 + 0.15 * 0.3).toBeCloseTo(0.345, 12);
  });
});

describe("асиметрія HYPOTHESIS vs VERIFIED (критерій S4 п.3, DEV-60)", () => {
  const V = det({ category: "cta", claim_kind: "below_fold", path: "/product/a" });
  // 12 лінз в ОДНОМУ контексті (1 задача, snapshot) — широке покриття, але HYPOTHESIS
  const key = "cta|product|ambiguous_label";
  const ss = Array.from({ length: 12 }, (_, i) => sess({ session_id: `h${i}`, lens_id: `L${i}`, task_id: "t1", pages_seen: ["/product/a"], reported_keys: [key] }));
  const H = ss.map((s) => syn({ category: "cta", claim_kind: "ambiguous_label", path: "/product/a", page_type: "product", session: s.session_id, lens: s.lens_id, task: "t1" }));
  const r = aggregate({ evidence: [V, ...H], sessions: ss, pageTypes: {} });
  const v = r.findings.find((f) => f.claim_kind === "below_fold");
  const h = r.findings.find((f) => f.claim_kind === "ambiguous_label");
  it("без кепу гіпотеза обігнала б перевірений факт (контрприклад, що кеп потрібен)", () => {
    expect(h?.confidence.level).toBe("HYPOTHESIS");
    expect(h?.severity.value).toBe(v?.severity.value);
    expect(h?.priority.uncapped).toBeGreaterThan(v?.priority.value as number);
  });
  it("з кепом: HYPOTHESIS ≤ VERIFIED-еквівалента і ранжується нижче", () => {
    expect(h?.priority.cap?.value).toBe(verifiedEquivalentCap(h?.severity.value as number, h?.funnel.value as number));
    expect(h?.priority.value).toBeLessThanOrEqual(v?.priority.value as number);
    expect((v?.rank as number) < (h?.rank as number)).toBe(true);
  });
  it("STRONG кепу не має (рівновага §6.4 збережена)", () => {
    const s2 = ss.map((s, i) => ({ ...s, task_id: i % 2 ? "t1" : "t2" }));
    const H2 = s2.map((s) => syn({ category: "cta", claim_kind: "ambiguous_label", path: "/product/a", page_type: "product", session: s.session_id, lens: s.lens_id, task: s.task_id }));
    const f = aggregate({ evidence: H2, sessions: s2, pageTypes: {} }).findings[0];
    expect(f?.confidence.level).toBe("STRONG_HYPOTHESIS");
    expect(f?.priority.cap).toBeNull();
  });
});

describe("§6.2 інваріанти і межі", () => {
  it("VERIFIED: додавання SYNTHETIC-доказу не змінює priority (інв. 4)", () => {
    const d = det({ category: "pricing", claim_kind: "not_in_first_viewport", path: "/product/a", assertion: "absence" });
    const s = syn({ category: "pricing", claim_kind: "not_in_first_viewport", path: "/product/a", session: "s1", lens: "L1", task: "t1" });
    const ss = [sess({ session_id: "s1", lens_id: "L1", task_id: "t1", pages_seen: ["/product/a"], reported_keys: ["pricing|product|not_in_first_viewport"] }), sess({ session_id: "s2", lens_id: "L2", task_id: "t1", pages_seen: ["/product/a"] })];
    const a = aggregate({ evidence: [d], pageTypes: {} }).findings[0];
    const b = aggregate({ evidence: [d, s], sessions: ss, pageTypes: {} }).findings[0];
    expect(b?.priority.value).toBe(a?.priority.value);
    expect(b?.priority.components.find((c) => c.name === "lens_coverage")?.applicable).toBe(false);
  });
  it("монотонність: зростання будь-якого застосовного компонента не зменшує priority (інв. 3)", () => {
    const base = { severity: 0.5, funnel_proximity: 0.5, evidence_strength: 0.4, lens_coverage: 0.3, session_frequency: 0.3 };
    const p0 = priority(base, "STRONG_HYPOTHESIS").value;
    for (const k of Object.keys(base) as Array<keyof typeof base>) {
      for (const lvl of ["STRONG_HYPOTHESIS", "HYPOTHESIS"] as const) {
        expect(priority({ ...base, [k]: 0.9 }, lvl).value).toBeGreaterThanOrEqual(priority(base, lvl).value);
      }
    }
    expect(p0).toBeGreaterThan(0);
  });
  it("немає сесій (S_exp = ∅): гіпотеза не отримує бонусу перерозподілу — покриття = 0", () => {
    const f = aggregate({ evidence: [inf({ category: "trust", claim_kind: "general", path: "/", page_type: "homepage", page_group: "/" })], pageTypes: {} }).findings[0];
    expect(f?.priority.components.map((c) => [c.name, c.applicable, c.value])).toEqual([
      ["severity", true, 0.75], ["funnel_proximity", true, 0.3], ["lens_coverage", true, 0], ["session_frequency", true, 0], ["evidence_strength", true, 0.3],
    ]);
    expect(f?.priority.value).toBe(Math.floor(100 * (0.3 * 0.75 + 0.2 * 0.3 + 0.15 * 0.3) + 0.5 + 1e-9));
  });
  it("усі N/A, що дозволені (VERIFIED): Σ ваг = 0.65 ≥ 0.65; менше — помилка", () => {
    expect(() => priority({ severity: 0, funnel_proximity: 0, evidence_strength: 0, lens_coverage: null, session_frequency: null }, "VERIFIED")).not.toThrow();
    expect(priority({ severity: 0, funnel_proximity: 0, evidence_strength: 0, lens_coverage: null, session_frequency: null }, "VERIFIED").value).toBe(0);
    expect(() => priority({ severity: 1, funnel_proximity: 1, evidence_strength: 1, lens_coverage: 0.5, session_frequency: null }, "HYPOTHESIS")).toThrow();
    expect(() => priority({ severity: 1.2, funnel_proximity: 1, evidence_strength: 1, lens_coverage: null, session_frequency: null }, "VERIFIED")).toThrow();
  });
  it("нічия: однаковий priority/впевненість/сила → порядок за finding_key (code points)", () => {
    const a = det({ category: "cta", claim_kind: "below_fold", path: "/product/a" });
    const b = det({ category: "cta", claim_kind: "competing_ctas", path: "/product/a" });
    const r = aggregate({ evidence: [b, a], pageTypes: {} }).findings;
    expect(r[0]?.priority.value).toBe(r[1]?.priority.value);
    expect(r.map((f) => f.finding_key)).toEqual(["cta|product|below_fold", "cta|product|competing_ctas"]);
  });
});

describe("§3 severity і §4 воронка — таблиці", () => {
  it.each([
    ["axe critical на товарі", { category: "accessibility", m: { impact: "critical" }, type: "axe", pt: ["product"] }, 0.75, "axe_impact"],
    ["axe minor на блозі/іншому", { category: "accessibility", m: { impact: "minor" }, type: "axe", pt: ["other"] }, 0.1, "axe_impact"],
    ["axe serious на about", { category: "accessibility", m: { impact: "serious" }, type: "axe", pt: ["about"] }, 0.6, "axe_impact"],
    ["Lighthouse LCP 4.5 s на головній", { category: "performance", m: { lcp_ms: 4500 }, type: "lighthouse", pt: ["homepage"] }, 0.7, "lighthouse"],
    ["Lighthouse TBT 300 ms", { category: "performance", m: { tbt_ms: 300 }, type: "lighthouse", pt: ["homepage"] }, 0.5, "lighthouse"],
    ["Lighthouse лише opportunities", { category: "performance", m: { opportunities_only: true }, type: "lighthouse", pt: ["other"] }, 0.2, "lighthouse"],
    ["oversized_image 1.7 MB на головній (max(0.55, 0.45))", { category: "performance", m: { body_bytes: 1_700_000 }, type: "dom", det: "oversized_image", pt: ["homepage"] }, 0.6, "category"],
    ["Lighthouse opportunities + oversized_image → підлога 0.45", { category: "performance", m: { opportunities_only: true, body_bytes: 600_000 }, type: "lighthouse", det: "oversized_image", pt: ["other"] }, 0.35, "network"],
    ["terminology на товарі", { category: "terminology", m: {}, type: "dom", pt: ["product"] }, 0.5, "category"],
    ["other на невідомій сторінці", { category: "other", m: {}, type: "dom", pt: ["unknown"] }, 0.2, "category"],
  ])("%s", (_n, c, want, src) => {
    const e = { id: "ev_000000000000", type: c.type, source_class: "OBSERVED", page_url: "http://x.test/", self_confirming: true, measurement: c.m, detector_id: (c as { det?: string }).det, claim_kind: (c as { det?: string }).det } as never;
    const r = severity({ key: "k", category: c.category as never, evidence: [e], pageTypes: c.pt as never });
    expect(r.value).toBe(want);
    expect(r.base_source).toBe(src);
  });
  it("таблиці покривають усі категорії і типи сторінок", () => {
    expect(Object.keys(SEV_BASE)).toHaveLength(17);
    expect(Object.keys(PAGE_STAGE)).toHaveLength(10);
    expect(Object.keys(FUN_STAGE)).toHaveLength(7);
  });
  it.each([
    ["pricing на категорії → канонічний етап", "pricing", ["category"], "price_shipping_confidence", "category"],
    ["accessibility на головній і товарі → максимум сторінок", "accessibility", ["homepage", "product"], "evaluate_product", "page_type"],
    ["accessibility наскрізна з info_shipping → price_shipping_confidence (DEV-59)", "accessibility", ["homepage", "product", "info_shipping"], "price_shipping_confidence", "page_type"],
    ["cta на checkout → cart (DEV-59)", "cta", ["checkout"], "cart", "page_type"],
    ["navigation на unknown → understand_offering", "navigation", ["unknown"], "understand_offering", "page_type"],
  ])("%s", (_n, cat, pts, stage, src) => {
    const r = funnel(cat as never, pts as never);
    expect([r.stage, r.stage_source]).toEqual([stage, src]);
  });
});
