/**
 * SYNTHETIC відповіді для промптів S4 (snapshot-evaluator-v1, browser-agent-v1, finding-aggregator-v1, recommendation-v1) на фікстурі shop-clean.
 * Пише інженер, НЕ модель (R-2): доводить плумбінг запис → replay → схеми → semantic-перевірки, а не якість моделі (⏭️ live pass, OQ-1).
 */
import { BehavioralLens } from "@sitelens/schemas";
import type { PageInput } from "../page-input.js";
import { agentTurn } from "../stages/agent-turn.js";
import { writeFindingTexts, type FindingGroupIn } from "../stages/finding-texts.js";
import { evaluateSnapshot, type TaskBrief } from "../stages/snapshot-eval.js";
import type { StageContext } from "../stages/types.js";
import { ScriptedFakeProvider, type ScriptEntry } from "../providers/scripted-fake.js";
import type { LogicalKey } from "../types.js";

export const S4_NAMESPACE = "s4-sim-synthetic-v1";
export const S4_IDENTITY = { provider: "replay", model: "synthetic-fixture-v1" } as const;

const mkLens = (id: string, price: number) => BehavioralLens.parse({
  id, audit_run_id: "run_s4_synthetic", name: id === "lens_care" ? "Обережний" : "Швидкий", description: "Поведінкова лінза для перевірки", category_knowledge: 0.4, price_sensitivity: price, trust_requirement: 0.7,
  decision_speed: 0.4, detail_preference: 0.6, visual_sensitivity: 0.5, comparison_tendency: 0.5, risk_aversion: 0.7, convenience_priority: 0.5, social_proof_need: 0.5,
  primary_goal: "Знати повну ціну з доставкою", likely_questions: [], likely_objections: [],
});
export const S4_LENSES = [mkLens("lens_care", 0.8), mkLens("lens_fast", 0.3)] as const;
export const S4_TASK: TaskBrief = { id: "t_delivery", name: "Дізнатися умови доставки", goal: "Знайти умови й вартість доставки до додавання в кошик", task_type: "delivery" };
export const S4_GROUP = (quote: string): FindingGroupIn => ({ finding_key: "shipping|product|cost_unknown", category: "shipping", page_group: "product", claim_kind: "cost_unknown", pages: ["/product/glass-kettle"], facts: [], quotes: [quote] });

export const productPage = (pages: readonly PageInput[]): PageInput => pages.find((p) => p.page_type === "product") as PageInput;
/** дослівна цитата зі сторінки товару без цифр (для доказу friction) */
export const quoteOf = (p: PageInput): string => (p.visible_text.split("\n").map((s) => s.trim()).find((s) => s.length >= 20 && !/\d/.test(s)) as string);

const tile = (p: PageInput) => ({ id: "t0", y_css: 0, height_css: 1000, image: p.image ?? { type: "image" as const, media_type: "image/png" as const, sha256: "0".repeat(64), label: "first viewport" } });

export function s4Script(pages: readonly PageInput[]): Array<[LogicalKey, ScriptEntry]> {
  const p = productPage(pages);
  const k = (prompt_id: string, lens_id: string | undefined, step: number, extra: Partial<LogicalKey> = {}): LogicalKey => ({ prompt_id, page_url: p.url, ...(lens_id ? { lens_id, task_id: S4_TASK.id } : {}), step, ...extra });
  const snap = (over: Record<string, unknown>) => ({ verdict: "no_issue", noticed: ["Ціна й кнопка купівлі видимі."], understood: ["Продається скляний чайник."], unclear: [], likely_next_action: "Відкрити сторінку доставки.", frictions: [], positive_signals: ["Ціна поруч із кнопкою."], uncertainties: [], success: "true", final_summary: "Сторінка підходить для задачі.", ...over });
  const step = (o: Record<string, unknown>, result: unknown = null) => ({ step: { action: "click", target: 'link:"Доставка й оплата"', reason_summary: "Потрібні умови доставки.", task_progress: "Шукаю умови доставки.", friction_detected: [], confidence: 0.6, ...o }, result });
  return [
    [k("snapshot-evaluator-v1", "lens_care", 0), { response: snap({}) }],
    [k("snapshot-evaluator-v1", "lens_fast", 0), { response: snap({ verdict: "issues_found", success: "partial", frictions: [{ category: "shipping", claim_kind: "cost_unknown", severity: "medium", evidence: `"${quoteOf(p)}"`, tile_id: "t0" }], unclear: ["Вартість доставки не зрозуміла."] }) }],
    [k("browser-agent-v1", "lens_care", 0), { response: step({}) }],
    [k("browser-agent-v1", "lens_care", 1), { response: step({ action: "stop_success", target: "", reason_summary: "Умови доставки знайдено.", task_progress: "Задачу виконано." }, { success: "true", frictions: [], positive_signals: ["Умови доставки на окремій сторінці."], uncertainties: [], final_summary: "Умови доставки знайдено за один перехід." }) }],
    [{ prompt_id: "finding-aggregator-v1", task_id: "finding:shipping|product|cost_unknown", step: 0 }, { response: { verdict: "supported", title: "Вартість доставки не видно біля ціни", problem: "На сторінці товару немає вартості доставки; про це повідомили {lens_coverage}.", why_it_matters: "Без вартості доставки складно оцінити повну ціну до кошика." } }],
    [{ prompt_id: "recommendation-v1", task_id: "finding:shipping|product|cost_unknown", step: 1 }, { response: { verdict: "supported", recommended_change: "Покажіть вартість або умови доставки біля ціни на сторінці товару.", how_to_validate: "Порівняйте переходи до кошика до й після зміни; ефект наперед не прогнозуйте." } }],
  ];
}
export const s4FakeProvider = (pages: readonly PageInput[]): ScriptedFakeProvider => ScriptedFakeProvider.from(s4Script(pages));

/** один і той самий прогін для запису фікстур і для replay */
export async function runS4Sim(ctx: StageContext, pages: readonly PageInput[]) {
  const p = productPage(pages);
  const base = { page: p, task: S4_TASK, a11y_outline: "main\n  heading 'Скляний чайник'\n  link 'Доставка й оплата'\n  button 'Додати в кошик'" };
  const snapshots = [];
  for (const lens of S4_LENSES) snapshots.push(await evaluateSnapshot(ctx, { ...base, lens, tiles: [tile(p)], tiles_total: 1 }));
  const t0 = await agentTurn(ctx, { ...base, lens: S4_LENSES[0], history: [], remaining: 8, step: 0 });
  const t1 = await agentTurn(ctx, { ...base, lens: S4_LENSES[0], history: [{ action: "click", target: 'link:"Доставка й оплата"', reason_summary: "Потрібні умови доставки." }], remaining: 7, step: 1 });
  const texts = await writeFindingTexts(ctx, [S4_GROUP(quoteOf(p))]);
  return { snapshots, agent: [t0, t1], texts };
}
