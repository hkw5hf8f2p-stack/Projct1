/**
 * Динамічний scripted fake провайдер для наскрізного тесту S4: відповідає на будь-який (lens × task × сторінка) за promt_id (профіль/задачі/лінзи — відповіді
 * `synthetic-shop` для сайту fixtures/shop; snapshot-оцінка — за лінзою). Пише інженер, не модель: доводить ПЛУМБІНГ worker (етапи → БД → сценарії → звіт),
 * не якість моделі (⏭️ живий пас, OQ-1). Друга лінія: `hostileLensId` повертає вигадану цитату (має бути відкинута кодом, §23).
 */
import { LlmClient, TokenBudget, estimateTextTokens, type LlmProvider, type LlmRequest, type ProviderResult } from "@sitelens/llm";
import { shopLensesResponse, shopProfileResponse, shopTasksResponse } from "../../../../packages/llm/src/testing/synthetic-shop.js";
import type { Runtime } from "../../src/runtime.js";

export const HOSTILE_QUOTE = "Безкоштовна доставка по всій Україні за одну годину";

export class DynamicFake implements LlmProvider {
  readonly name = "fake" as const;
  readonly model = "scripted-fake";
  readonly received: string[] = [];
  /**
   * richFrictions (DEV-98): friction як у живої моделі — цитата + коментар і `NOT_FOUND: …` з числом (маскується кодом), а не лише голою цитатою.
   * finding-aggregator-v1 / recommendation-v1 відповідають завжди (текст без цифр, лише плейсхолдер {page_count}).
   */
  constructor(private readonly o: { frictionLensIds: readonly string[]; hostileLensId?: string; richFrictions?: boolean }) {}

  private quote(req: LlmRequest): string | null {
    const text = req.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    const after = text.split("visible_text:\n")[1] ?? "";
    return after.split("\n").map((s) => s.trim()).find((s) => s.length >= 20 && s.length <= 120 && !/[\d"«»<>{}]/.test(s)) ?? null;
  }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    this.received.push(`${req.prompt_id}|${req.logical_key.lens_id ?? ""}|${req.logical_key.task_id ?? ""}`);
    let json: unknown;
    switch (req.prompt_id) {
      case "site-profile-v1": json = shopProfileResponse(); break;
      case "task-generator-v1": json = shopTasksResponse(); break;
      case "lens-generator-v1": json = shopLensesResponse(); break;
      case "snapshot-evaluator-v1": {
        const lens = req.logical_key.lens_id ?? "";
        const base = { noticed: ["Заголовок і призначення сторінки видно."], understood: ["Зрозуміло, що це магазин речей для дому."], unclear: [], likely_next_action: "Перейти до сторінки товару.", positive_signals: ["Зрозумілий головний заголовок."], uncertainties: [] };
        const q = this.quote(req);
        if (lens === this.o.hostileLensId) {
          json = { ...base, verdict: "issues_found", success: "partial", final_summary: "Знайдено проблему з доставкою.", frictions: [{ category: "shipping", claim_kind: "cost_unknown", severity: "medium", evidence: `"${HOSTILE_QUOTE}"`, tile_id: "t0" }] };
        } else if (this.o.frictionLensIds.includes(lens) && q && this.o.richFrictions) {
          json = { ...base, verdict: "issues_found", success: "partial", final_summary: "Умови доставки складно знайти.", frictions: [
            { category: "shipping", claim_kind: "cost_unknown", severity: "medium", evidence: `"${q}" — біля цього тексту не видно, скільки коштує доставка.`, tile_id: "t0" },
            { category: "missing_information", claim_kind: "general", severity: "medium", evidence: "NOT_FOUND: строк доставки для замовлення від 2 одиниць і умови повернення протягом 14 днів", tile_id: "t0" },
          ] };
        } else if (this.o.frictionLensIds.includes(lens) && q) {
          json = { ...base, verdict: "issues_found", success: "partial", final_summary: "Умови доставки складно знайти.", frictions: [{ category: "shipping", claim_kind: "cost_unknown", severity: "medium", evidence: `"${q}"`, tile_id: "t0" }] };
        } else json = { ...base, verdict: "no_issue", success: "true", final_summary: "Сторінка підходить для задачі.", frictions: [] };
        break;
      }
      case "finding-aggregator-v1": {
        const text = req.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
        const cat = /"category":\s*"([a-z_]+)"/.exec(text)?.[1] ?? "other";
        const T: Record<string, string> = { shipping: "Синтетичні лінзи не бачать вартості доставки біля ціни", missing_information: "Синтетичним лінзам бракує строків доставки й умов повернення" };
        json = { verdict: "supported", title: T[cat] ?? "Синтетичні лінзи вагалися на цьому кроці", problem: "Синтетичні лінзи не знайшли потрібних умов на сторінках групи; сторінок: {page_count}.", why_it_matters: "Без цих умов складно вирішити, чи купувати зараз." };
        break;
      }
      case "recommendation-v1": json = { verdict: "supported", recommended_change: "Покажіть умови доставки й повернення поруч із ціною та кнопкою покупки.", how_to_validate: "Порівняйте переходи до кошика до й після зміни; ефект наперед не прогнозуйте." }; break;
      default: throw new Error(`DynamicFake: невідомий промпт ${req.prompt_id}`);
    }
    return { json, input_tokens: estimateTextTokens(req.system + JSON.stringify(req.content.filter((p) => p.type === "text"))), output_tokens: estimateTextTokens(JSON.stringify(json)), provider: "fake", model: this.model, latency_ms: 0, synthetic: true };
  }
}

/** підключити fake до worker-runtime (rt.llm) */
export function useFakeLlm(rt: Runtime, fake: DynamicFake, max = 1_650_000): void {
  rt.llm = async (audit, o) => {
    // той самий розрахунок залишку, що й у справжньому rt.llm (резерв під паралельні задачі, DEV-92)
    const remaining = await rt.budgetRemaining(audit, max, o);
    return { client: new LlmClient({ mode: "fake", provider: fake, budget: new TokenBudget(remaining) }), provider: "replay", model: fake.model };
  };
}
