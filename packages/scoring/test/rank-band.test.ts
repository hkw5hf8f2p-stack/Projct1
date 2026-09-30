/**
 * R-14 / критерій S4 №2 / DEV-76 (scoring-v2): смуга ранжування — VERIFIED над гіпотезами незалежно від severity.
 * Кожне твердження показано і на позитиві (нове правило), і на контролі (порядок scoring-v1 → той самий вхід провалює).
 * Правило без параметрів; тести не прив'язані до №8 фікстури: крайні точки простору (найслабший можливий VERIFIED проти
 * найсильнішої можливої гіпотези) + рядки e1-full як регресія.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate, compareFindings, compareFindingsV1, e1RankGate, rerankV1, RANK_BAND, SCORING_VERSION,
  type ScoredFinding, type SessionObs, type VConfidence, type VFinding,
} from "../src/index.js";
import { det, permutations, sess, syn } from "./helpers.js";

/** найслабший можливий VERIFIED: axe minor (0.2) на peripheral-сторінці (−0.1) → sev 0.1; етап understand_offering 0.45 */
function weakestVerified() {
  return det({ category: "accessibility", claim_kind: "axe:image-alt", path: "/misc", page_type: "other", page_group: "other", type: "axe", source_class: "BENCHMARKED", measurement: { impact: "minor", component_signature: "main/img" } });
}
/** найсильніша можлива гіпотеза: checkout у кошику, 12/12 лінз у 2 контекстах (STRONG), блокер → sev 1, fun 1, ev 0.7 */
function strongestHypothesis(): { evs: ReturnType<typeof syn>[]; ss: SessionObs[] } {
  const key = "checkout|/cart|general";
  const ss = Array.from({ length: 12 }, (_, i) => sess({ session_id: `s${i}`, lens_id: `L${i}`, task_id: i % 2 ? "t1" : "t2", level: "journey", success: "false", pages_seen: ["/cart"], reported_keys: [key], last_friction_key: key }));
  const evs = ss.map((s) => syn({ category: "checkout", claim_kind: "general", path: "/cart", page_type: "cart", page_group: "/cart", session: s.session_id, lens: s.lens_id, task: s.task_id, level: "journey" }));
  return { evs, ss };
}

describe("смуга ранжування (DEV-76)", () => {
  it("версія скорингу підвищена: порядок звіту змінився → scoring-v2; числа формули — ті самі (scoring-v1/redistributed)", () => {
    expect(SCORING_VERSION).toBe("scoring-v2");
    expect(RANK_BAND).toEqual({ VERIFIED: 1, STRONG_HYPOTHESIS: 0, HYPOTHESIS: 0 });
  });

  const { evs, ss } = strongestHypothesis();
  const r = aggregate({ evidence: [weakestVerified(), ...evs], sessions: ss, pageTypes: {} });
  const v = r.findings.find((f) => f.confidence.level === "VERIFIED") as ScoredFinding;
  const h = r.findings.find((f) => f.confidence.level !== "VERIFIED") as ScoredFinding;

  it("крайні точки: найслабший VERIFIED (priority 42) над найсильнішою гіпотезою (priority > 90, STRONG) — ранг 1 vs 2", () => {
    expect([v.severity.value, v.funnel.value, v.priority.value]).toEqual([0.1, 0.45, 42]);
    expect(h.confidence.level).toBe("STRONG_HYPOTHESIS");
    expect(h.priority.value).toBeGreaterThan(90);
    expect(h.priority.value).toBeGreaterThan(v.priority.value);
    expect([v.rank, h.rank]).toEqual([1, 2]);
  });
  it("контроль: порядок scoring-v1 на тих самих знахідках ставить гіпотезу вище (правило справді щось змінює)", () => {
    expect(compareFindingsV1(h, v)).toBeLessThan(0);
    expect(compareFindings(h, v)).toBeGreaterThan(0);
  });
  it("числа не змінено: priority кожної знахідки однаковий за обох порядків (змінено лише rank)", () => {
    const again = aggregate({ evidence: [weakestVerified(), ...evs], sessions: ss, pageTypes: {} }).findings;
    expect(again.map((f) => f.priority.value).sort()).toEqual(r.findings.map((f) => f.priority.value).sort());
  });
  it("усередині смуги — як раніше: гіпотези між собою за priority, VERIFIED між собою за priority", () => {
    const a = det({ category: "pricing", claim_kind: "not_in_first_viewport", path: "/product/a", assertion: "absence" });
    const b = det({ category: "performance", claim_kind: "oversized_image", path: "/", page_type: "homepage", page_group: "/", measurement: { body_bytes: 1_700_000 } });
    const hs = Array.from({ length: 4 }, (_, i) => sess({ session_id: `x${i}`, lens_id: `L${i}`, task_id: "t1", pages_seen: ["/", "/product/a"], reported_keys: i < 3 ? ["value_proposition|/|general", "terminology|product|general"] : ["terminology|product|general"] }));
    const hv = hs.flatMap((s) => [
      ...(s.reported_keys.includes("value_proposition|/|general") ? [syn({ category: "value_proposition", claim_kind: "general", path: "/", page_type: "homepage", page_group: "/", session: s.session_id, lens: s.lens_id, task: "t1" })] : []),
      syn({ category: "terminology", claim_kind: "general", path: "/product/a", page_type: "product", session: s.session_id, lens: s.lens_id, task: "t1" }),
    ]);
    const out = aggregate({ evidence: [b, ...hv, a], sessions: hs, pageTypes: {} }).findings;
    const band = out.map((f) => RANK_BAND[f.confidence.level]);
    expect(band).toEqual([...band].sort((x, y) => y - x));
    for (let i = 1; i < out.length; i++) if (band[i] === band[i - 1]) expect(out[i - 1]!.priority.value).toBeGreaterThanOrEqual(out[i]!.priority.value);
    expect(out.slice(0, 2).map((f) => f.confidence.level)).toEqual(["VERIFIED", "VERIFIED"]);
  });
  it("детермінізм: 6 перестановок доказів → однакові ранги", () => {
    const all = [weakestVerified(), ...evs];
    const ref = JSON.stringify(aggregate({ evidence: all, sessions: ss, pageTypes: {} }).findings.map((f) => [f.finding_key, f.rank, f.priority.value]));
    for (const p of permutations(all)) expect(JSON.stringify(aggregate({ evidence: p, sessions: ss, pageTypes: {} }).findings.map((f) => [f.finding_key, f.rank, f.priority.value]))).toBe(ref);
  });
});

// ------------------------------------------------------------------------------------------------ гейт рангу E1 (кр.2)
/**
 * Рядки `planning/qa/artifacts/sprint-4/validate/reports/e1-full.json`, згенерованого scoring-v1 (коміт 68fda61) —
 * finding_key, впевненість, priority, ранг у тому звіті. Регресія R-14: №8 slow_image (VERIFIED, 60) на 12-му місці з 12.
 */
const E1_FULL_V1: Array<[string, VConfidence, number, number]> = [
  ["pricing|category|not_in_first_viewport", "VERIFIED", 90, 1],
  ["pricing|product|not_in_first_viewport", "VERIFIED", 90, 2],
  ["cta|product|below_fold", "VERIFIED", 85, 3],
  ["accessibility|*|axe:button-name|header/button", "VERIFIED", 85, 4],
  ["shipping|product|deep_link_only", "VERIFIED", 85, 5],
  ["accessibility|product|axe:image-alt|main/img", "VERIFIED", 82, 6],
  ["mobile_usability|product|horizontal_overflow", "VERIFIED", 80, 7],
  ["comparison|category|general", "HYPOTHESIS", 69, 8],
  ["terminology|product|general", "HYPOTHESIS", 68, 9],
  ["value_proposition|/|general", "HYPOTHESIS", 67, 10],
  ["terminology|category|general", "HYPOTHESIS", 63, 11],
  ["performance|/|oversized_image", "VERIFIED", 60, 12],
];
const toV = ([k, c, p, rank]: [string, VConfidence, number, number]): VFinding => {
  const [category, page_group, claim_kind] = k.split("|") as [string, string, string];
  return { finding_key: k, category, page_group, claim_kind, confidence: c, priority: p, rank, families: c === "VERIFIED" ? ["F-DET"] : ["F-SYN"], pages: ["/"] };
};
/** порядок scoring-v2 над VFinding (смуга, потім priority; tie — попередній ранг) — дзеркало compareFindings */
const rerankV2 = (fs: readonly VFinding[]): VFinding[] =>
  [...fs].sort((a, b) => RANK_BAND[b.confidence] - RANK_BAND[a.confidence] || b.priority - a.priority || a.rank - b.rank).map((f, i) => ({ ...f, rank: i + 1 }));

describe("гейт рангу E1: 7/7 детермінованих у топ-10 (кр.2)", () => {
  const v1 = E1_FULL_V1.map(toV);
  it("e1-full scoring-v1: FAIL 6/7, №8 → 12 (гейт уміє впасти на справжньому артефакті)", () => {
    const g = e1RankGate(v1);
    expect(g.pass).toBe(false);
    expect([g.in_top, g.of]).toEqual([6, 7]);
    expect(g.ranks.find((x) => x.id === 8)?.rank).toBe(12);
    expect([g.findings, g.hypotheses]).toEqual([12, 4]);
  });
  it("rerankV1 відтворює порядок scoring-v1 байт-у-байт (контроль у validate чесний)", () => {
    expect(rerankV1(rerankV2(v1)).map((f) => [f.finding_key, f.rank])).toEqual(v1.map((f) => [f.finding_key, f.rank]));
  });
  it("ті самі знахідки в порядку scoring-v2: PASS 7/7, №8 → 8; усі гіпотези — ранги 9..12", () => {
    const g = e1RankGate(rerankV2(v1));
    expect(g.pass).toBe(true);
    expect(g.ranks.map((x) => x.rank)).toEqual([5, 3, 4, 7, 8, 6, 1]);
  });
  it("недетектований дефект → ранг null → FAIL навіть у топі; ≤ 10 знахідок видно (гейт тривіальний)", () => {
    const miss = rerankV2(v1.filter((f) => f.claim_kind !== "horizontal_overflow"));
    const g = e1RankGate(miss);
    expect(g.pass).toBe(false);
    expect(g.ranks.find((x) => x.id === 7)?.rank).toBeNull();
    expect(e1RankGate(rerankV2(v1.filter((f) => f.confidence === "VERIFIED"))).findings).toBeLessThanOrEqual(10);
  });
  it("межа: 10-те місце — у топі, 11-те — ні", () => {
    const pad = Array.from({ length: 3 }, (_, i) => toV([`trust|/|v${i}`, "VERIFIED", 95, 0]));
    const withPad = rerankV2([...v1, ...pad].map((f, i) => ({ ...f, rank: i + 1 })));
    const g = e1RankGate(withPad);
    expect(g.ranks.find((x) => x.id === 8)?.rank).toBe(11);
    expect(g.pass).toBe(false);
    const g10 = e1RankGate(rerankV2([...v1, ...pad.slice(0, 2)].map((f, i) => ({ ...f, rank: i + 1 }))));
    expect(g10.ranks.find((x) => x.id === 8)?.rank).toBe(10);
    expect(g10.pass).toBe(true);
  });
});
