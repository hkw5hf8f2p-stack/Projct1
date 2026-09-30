/** S4 LLM-потік: схеми відповідей, семантичний локатор §11, тайли D4, тексти знахідок без чисел (replay/fake = плумбінг, не якість моделі). */
import { describe, expect, it } from "vitest";
import { BehavioralLens } from "@sitelens/schemas";
import {
  AgentTurnLlm, FindingTextLlm, LlmClient, MAX_TILES_PER_CALL, RecommendationLlm, ScriptedFakeProvider, SnapshotEvalLlm, TokenBudget, evaluateSnapshot, findingAggregatorV1, parseSemanticTarget,
  recommendationV1, snapshotEvaluatorV1, validateAgentTurn, validateTextFields, writeFindingTexts, type FindingGroupIn, type LlmProvider, type LlmRequest, type PageInput, type ProviderResult,
} from "../src/index.js";

const page: PageInput = { id: "p", url: "http://127.0.0.1:1/p", page_type: "product", title: "T", meta_description: "", headings: [], visible_text: "Скляний чайник\nДоставка від 70 грн", link_texts: [], image: null };
const lens = BehavioralLens.parse({
  id: "l1", audit_run_id: "a", name: "Н", description: "Опис", category_knowledge: 0.3, price_sensitivity: 0.7, trust_requirement: 0.8, decision_speed: 0.3,
  detail_preference: 0.7, visual_sensitivity: 0.5, comparison_tendency: 0.6, risk_aversion: 0.8, convenience_priority: 0.5, social_proof_need: 0.5, primary_goal: "Мета", likely_questions: [], likely_objections: [],
});
const task = { id: "t", name: "N", goal: "G", task_type: "delivery" };
const img = (i: number) => ({ type: "image" as const, media_type: "image/jpeg" as const, sha256: String(i).repeat(64).slice(0, 64) });
class Cap implements LlmProvider {
  readonly name = "fake" as const; readonly model = "cap"; reqs: LlmRequest[] = [];
  constructor(private readonly responses: unknown[]) {}
  async complete(req: LlmRequest): Promise<ProviderResult> { this.reqs.push(req); const json = this.responses[Math.min(this.reqs.length - 1, this.responses.length - 1)]; return { json, input_tokens: 5, output_tokens: 5, provider: "fake", model: "cap", latency_ms: 0 }; }
}
const cl = (p: LlmProvider) => new LlmClient({ mode: "fake", provider: p, budget: new TokenBudget(9_000_000) });

describe("семантичний локатор (§11): жодних координат від LLM", () => {
  it("приймає role:\"name\"", () => {
    expect(parseSemanticTarget('button:"Add to cart"')).toEqual({ role: "button", name: "Add to cart" });
    expect(parseSemanticTarget('link:"Доставка й оплата"')).toEqual({ role: "link", name: "Доставка й оплата" });
  });
  it.each(["x=100,y=200", "100, 250", "12px", "#buy", ".btn > a", "//a[1]", "a:nth-child(2)", "http://x/y", 'button:Buy', 'div:"x"', "", 'button:""', "coordinates 10 20"])("відхиляє: %s", (t) => { expect(parseSemanticTarget(t)).toBeNull(); });
});

describe("схеми: строгі, без optional; вихід із зайвим полем не проходить", () => {
  it("JSON-схеми промптів additionalProperties:false і не містять optional-ключів", () => {
    for (const p of [snapshotEvaluatorV1, findingAggregatorV1, recommendationV1]) expect(JSON.stringify(p.json_schema)).toContain('"additionalProperties":false');
    const s = SnapshotEvalLlm.safeParse({ verdict: "no_issue", noticed: [], understood: [], unclear: [], likely_next_action: "x", frictions: [], positive_signals: [], uncertainties: [], success: "true", final_summary: "s", severity_score: 0.9 });
    expect(s.success).toBe(false);
    expect(AgentTurnLlm.safeParse({ step: { action: "click", target: "", reason_summary: "x".repeat(201), task_progress: "t", friction_detected: [], confidence: 0.5 }, result: null }).success).toBe(false);
    expect(FindingTextLlm.safeParse({ verdict: "supported", title: "t", problem: "p", why_it_matters: "w" }).success).toBe(true);
    expect(RecommendationLlm.safeParse({ verdict: "supported", recommended_change: "c" }).success).toBe(false);
  });
});

describe("validateAgentTurn: семантика кроку", () => {
  const step = (o: Record<string, unknown> = {}) => AgentTurnLlm.parse({ step: { action: "click", target: 'link:"Delivery"', reason_summary: "Need delivery terms.", task_progress: "Searching.", friction_detected: [], confidence: 0.5, ...o }, result: null });
  const result = { success: "true", frictions: [], positive_signals: [], uncertainties: [], final_summary: "Done." };
  it("коректний click / scroll / back проходять; stop_* потребує result і навпаки", () => {
    expect(validateAgentTurn(step(), page, 5)).toEqual([]);
    expect(validateAgentTurn(step({ action: "scroll", target: "down" }), page, 5)).toEqual([]);
    expect(validateAgentTurn(step({ action: "back", target: "" }), page, 5)).toEqual([]);
    expect(validateAgentTurn(AgentTurnLlm.parse({ ...step({ action: "stop_success", target: "" }), result }), page, 5)).toEqual([]);
    expect(validateAgentTurn(step({ action: "stop_success", target: "" }), page, 5).some((i) => i.startsWith("missing_result"))).toBe(true);
    expect(validateAgentTurn(AgentTurnLlm.parse({ ...step(), result }), page, 5).some((i) => i.startsWith("unexpected_result"))).toBe(true);
  });
  it("scroll із довільним target, back із target, дії вичерпано без stop → відхилення", () => {
    expect(validateAgentTurn(step({ action: "scroll", target: "500" }), page, 5).some((i) => i.startsWith("bad_target"))).toBe(true);
    expect(validateAgentTurn(step({ action: "back", target: 'link:"x"' }), page, 5).some((i) => i.startsWith("bad_target"))).toBe(true);
    expect(validateAgentTurn(step(), page, 0).some((i) => i.startsWith("no_actions_left"))).toBe(true);
  });
  it("прогноз у reason_summary → guard (без числа)", () => {
    expect(validateAgentTurn(step({ reason_summary: "Sales will significantly increase." }), page, 5).length).toBeGreaterThan(0);
  });
});

describe("D4: тайли — перший екран + обмежена кількість, не full-page; усічення сигналізується", () => {
  const ok = { verdict: "no_issue", noticed: ["a"], understood: ["b"], unclear: [], likely_next_action: "c", frictions: [], positive_signals: [], uncertainties: [], success: "true", final_summary: "d" };
  it(`понад ${MAX_TILES_PER_CALL} тайлів → у запит лише ${MAX_TILES_PER_CALL} зображень + фрагмент про усічення; сесія позначена tiles_truncated`, async () => {
    const cap = new Cap([ok]);
    const tiles = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, y_css: i * 850, height_css: 1000, image: img(i) }));
    const r = await evaluateSnapshot({ audit_run_id: "a", language: "uk", client: cl(cap) }, { page, lens, task, tiles, tiles_total: 8, a11y_outline: "main" });
    expect(r.status).toBe("done");
    const req = cap.reqs[0]!;
    expect(req.content.filter((p) => p.type === "image")).toHaveLength(MAX_TILES_PER_CALL);
    expect(req.content.some((p) => p.type === "text" && /token budget/.test(p.text))).toBe(true);
    expect(r.flags).toContain("tiles_truncated");
    expect(r.output!.session.uncertainties).toContain("tiles_truncated");
  });
  it("без усічення фрагмент про бюджет не додається", async () => {
    const cap = new Cap([ok]);
    await evaluateSnapshot({ audit_run_id: "a", language: "uk", client: cl(cap) }, { page, lens, task, tiles: [{ id: "t0", y_css: 0, height_css: 1000, image: img(1) }], tiles_total: 1, a11y_outline: "main" });
    expect(cap.reqs[0]!.content.some((p) => p.type === "text" && /token budget/.test(p.text))).toBe(false);
  });
});

describe("тексти знахідок: числа лише плейсхолдерами, «немає підтримки» — валідний результат", () => {
  const g = (k: string): FindingGroupIn => ({ finding_key: k, category: "shipping", page_group: "product", claim_kind: "cost_unknown", pages: ["/product/x"], facts: [], quotes: ["Доставка від 70 грн"] });
  it("validateTextFields: цифра, числівник, чужий плейсхолдер, прогноз → порушення; коректний текст із плейсхолдером — ні", () => {
    expect(validateTextFields({ a: "Вартість доставки не видно; про це повідомили {lens_coverage}." })).toEqual([]);
    expect(validateTextFields({ a: "Доставка схована на 5 екрані." }).some((i) => i.startsWith("structural_number"))).toBe(true);
    expect(validateTextFields({ a: "Delivery is hidden three clicks away." }).some((i) => i.startsWith("structural_number"))).toBe(true);
    expect(validateTextFields({ a: "See {secret_count} sessions." }).some((i) => i.startsWith("bad_placeholder"))).toBe(true);
    expect(validateTextFields({ a: "Продажі суттєво зростуть." }).length).toBeGreaterThan(0);
  });
  it("supported → 5 текстів; not_supported → групу пропущено (лишається шаблон коду); виклики: 2 на підтверджену, 1 на непідтверджену", async () => {
    const prov = ScriptedFakeProvider.from([
      [{ prompt_id: findingAggregatorV1.id, task_id: "finding:a", step: 0 }, { response: { verdict: "supported", title: "Доставка не видна", problem: "Вартість доставки не видно біля ціни; {lens_coverage} це помітили.", why_it_matters: "Без вартості доставки важко вирішити." } }],
      [{ prompt_id: recommendationV1.id, task_id: "finding:a", step: 1 }, { response: { verdict: "supported", recommended_change: "Покажіть вартість доставки біля ціни.", how_to_validate: "Порівняйте переходи до кошика до й після зміни." } }],
      [{ prompt_id: findingAggregatorV1.id, task_id: "finding:b", step: 0 }, { response: { verdict: "not_supported", title: "", problem: "", why_it_matters: "" } }],
    ]);
    const client = new LlmClient({ mode: "fake", provider: prov, budget: new TokenBudget(9_000_000) });
    const r = await writeFindingTexts({ audit_run_id: "a", language: "uk", client }, [g("b"), g("a")]);
    expect(r.status).toBe("done");
    expect(Object.keys(r.output!.texts)).toEqual(["a"]);
    expect(r.output!.not_supported).toEqual(["b"]);
    expect(client.records).toHaveLength(3);
    expect(r.output!.texts["a"]!.prompt_ids).toEqual(["finding-aggregator-v1", "recommendation-v1"]);
  });
  it("модель повертає цифру → repair → знову цифра → етап failed (нічого не збережено, не «виправлено» тихо)", async () => {
    const bad = { verdict: "supported", title: "Доставка", problem: "Схована на 5 екрані.", why_it_matters: "Важливо." };
    const prov = ScriptedFakeProvider.from([
      [{ prompt_id: findingAggregatorV1.id, task_id: "finding:a", step: 0 }, { response: bad }],
      [{ prompt_id: findingAggregatorV1.id, task_id: "finding:a", step: 0, attempt: 1 }, { response: bad }],
    ]);
    const r = await writeFindingTexts({ audit_run_id: "a", language: "uk", client: new LlmClient({ mode: "fake", provider: prov, budget: new TokenBudget(9_000_000) }) }, [g("a")]);
    expect(r.status).toBe("failed");
    expect(r.rejected.map((x) => x.rule)).toContain("structural_number");
  });
});
