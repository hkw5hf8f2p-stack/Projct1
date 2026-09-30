/**
 * ПРИКЛАД LLM-результатів для фікстурного звіту UI (S5) — написано вручну, НЕ вихід моделі й не replay-запис.
 * Мета: показати всі форми контракту (SYNTHETIC/INFERRED докази, STRONG і HYPOTHESIS знахідки, «N of M synthetic …»,
 * лінзи, pole_unmet, відхилений числовим правилом текст). Звіт з ним має provenance=example_fixture і банер.
 */
import { createHash } from "node:crypto";
import { Evidence } from "@sitelens/schemas";
import type { SessionObs } from "@sitelens/scoring";
import type { LlmResults, LlmText } from "../types.js";

const O = "http://127.0.0.1:4210";
const id = (s: string) => "ev_" + createHash("sha256").update("example|" + s).digest("hex").slice(0, 12);
const T = (text: string, source_class: LlmText["source_class"] = "SYNTHETIC", prompt_id = "report-writer-v1"): LlmText => ({ text, source_class, prompt_id, guard_status: "pending" });

type Syn = { s: string; lens: string; task: string; level: "snapshot" | "journey"; category: "terminology" | "comparison" | "shipping"; claim: string; path: string; pg: string; pt: "category" | "product" };
const SYN: Syn[] = [
  { s: "ses_s01", lens: "lens_novice", task: "t_choose", level: "snapshot", category: "terminology", claim: "general", path: "/catalog", pg: "category", pt: "category" },
  { s: "ses_s02", lens: "lens_price", task: "t_choose", level: "snapshot", category: "terminology", claim: "general", path: "/catalog", pg: "category", pt: "category" },
  { s: "ses_j01", lens: "lens_fast", task: "t_delivery", level: "journey", category: "terminology", claim: "general", path: "/catalog", pg: "category", pt: "category" },
  { s: "ses_s03", lens: "lens_novice", task: "t_choose", level: "snapshot", category: "comparison", claim: "general", path: "/catalog", pg: "category", pt: "category" },
  { s: "ses_s04", lens: "lens_expert", task: "t_choose", level: "snapshot", category: "comparison", claim: "general", path: "/catalog", pg: "category", pt: "category" },
  { s: "ses_j01", lens: "lens_fast", task: "t_delivery", level: "journey", category: "shipping", claim: "deep_link_only", path: "/product/aquapro-x200", pg: "product", pt: "product" },
  { s: "ses_j02", lens: "lens_price", task: "t_delivery", level: "journey", category: "shipping", claim: "deep_link_only", path: "/product/aquapro-x220", pg: "product", pt: "product" },
];

const synEvidence = SYN.map((x) =>
  Evidence.parse({
    id: id(`${x.s}|${x.category}|${x.path}`), type: x.level === "journey" ? "browser_session" : "repeated_agent_observation", source_class: "SYNTHETIC",
    page_url: O + x.path, page_path: x.path, page_type: x.pt, page_group: x.pg, category: x.category, claim_kind: x.claim,
    description: "agent observation", artifact_reference: `sessions/${x.s}.json`, selector_or_region: { selector: "main" }, self_confirming: false,
    session_id: x.s, lens_id: x.lens, task_id: x.task, level: x.level,
  }),
);
const infEvidence = Evidence.parse({
  id: id("inf|value_proposition|/"), type: "dom", source_class: "INFERRED", page_url: O + "/", page_path: "/", page_type: "homepage", page_group: "/",
  category: "value_proposition", claim_kind: "general", description: "model inference", artifact_reference: "pages/index/1440x1000/viewport.png", selector_or_region: { selector: "main > h1" }, self_confirming: false,
});

const seen = (s: string, lens: string, task: string, level: SessionObs["level"], pages: string[], keys: string[], success: SessionObs["success"] = "partial"): SessionObs =>
  ({ session_id: s, lens_id: lens, task_id: task, level, success, pages_seen: pages, reported_keys: keys, last_friction_key: keys[keys.length - 1] ?? null });
const K = { term: "terminology|category|general", cmp: "comparison|category|general", ship: "shipping|product|deep_link_only" };

export const EXAMPLE_LLM: LlmResults = {
  mode: "replay",
  provider: "replay",
  model: "replay:example-fixture",
  prompt_versions: ["site-profile-v1", "snapshot-eval-v1", "journey-agent-v1", "report-writer-v1"],
  evidence: [...synEvidence, infEvidence],
  evidence_text: Object.fromEntries([
    [synEvidence[0]?.id, T("Позначення HFX у назві моделі ніде не пояснено; лінза не змогла зрозуміти, чим моделі відрізняються.")],
    [synEvidence[1]?.id, T("Скорочення SLT незрозуміле без технічних знань.")],
    [synEvidence[2]?.id, T("Агент повернувся до каталогу, бо не зрозумів позначень у назвах.")],
    [synEvidence[3]?.id, T("Картки AquaPro виглядають майже однаково; різницю між моделями не видно.")],
    [synEvidence[4]?.id, T("Порівняння можливе лише після відкриття кожної сторінки товару.")],
    [synEvidence[5]?.id, T("Агент шукав доставку на сторінці товару й перейшов у розділ допомоги.")],
    // ↓ навмисне порушення структурного правила (цифра) — текст буде відхилено, замість нього шаблон коду
    [synEvidence[6]?.id, T("Агент витратив 3 кроки, щоб знайти доставку.")],
    [infEvidence.id, T("Заголовок головної не називає категорії товарів.", "INFERRED")],
  ].filter(([k]) => k !== undefined) as Array<[string, LlmText]>),
  sessions: [
    seen("ses_s01", "lens_novice", "t_choose", "snapshot", ["/catalog"], [K.term, K.cmp]),
    seen("ses_s02", "lens_price", "t_choose", "snapshot", ["/catalog"], [K.term]),
    seen("ses_s03", "lens_novice", "t_choose", "snapshot", ["/catalog", "/product/aquapro-x200"], [K.cmp]),
    seen("ses_s04", "lens_expert", "t_choose", "snapshot", ["/catalog"], [K.cmp], "true"),
    seen("ses_s05", "lens_expert", "t_delivery", "snapshot", ["/product/aquapro-x200"], [], "true"),
    seen("ses_s06", "lens_price", "t_delivery", "snapshot", ["/", "/catalog"], [], "true"),
    seen("ses_j01", "lens_fast", "t_delivery", "journey", ["/", "/catalog", "/product/aquapro-x200", "/help", "/help/shipping"], [K.term, K.ship], "false"),
    seen("ses_j02", "lens_price", "t_delivery", "journey", ["/", "/product/aquapro-x220", "/help", "/help/shipping"], [K.ship], "partial"),
  ],
  finding_texts: {
    [K.term]: {
      title: T("Назви моделей містять незрозумілі скорочення"),
      problem: T("Позначення HFX і SLT у назвах ніде не пояснено; {lens_coverage} повідомили, що не можуть обрати модель."),
      why_it_matters: T("Новачок у категорії не може зіставити назву зі своєю потребою.", "INFERRED"),
      recommended_change: T("Додайте до кожної назви коротке пояснення позначення простими словами.", "INFERRED"),
      how_to_validate: T("A/B-тест каталогу з поясненнями; порівняйте переходи з каталогу на сторінку товару. Не прогнозуйте ефект до тесту.", "INFERRED"),
    },
    [K.cmp]: {
      // ↓ навмисне порушення (числівник «половина») — буде відхилено, замість нього шаблон коду
      title: T("Половина лінз не бачить різниці між моделями"),
      problem: T("Картки товарів у каталозі майже однакові; різницю видно лише на сторінках товарів."),
    },
    [K.ship]: {
      why_it_matters: T("У журналах лінзи шукали доставку перед рішенням про покупку: {session_frequency}.", "SYNTHETIC"),
    },
  },
  site_understanding: {
    what_it_sells: T("Фільтри й пом'якшувачі води для дому.", "INFERRED"),
    positioning: T("Побутові системи очищення води для кухні.", "INFERRED"),
    price_positioning: T("НЕВІДОМО: ціни в каталозі не показано.", "INFERRED"),
    core_value_proposition: T("Чиста вода вдома без складного встановлення.", "INFERRED"),
    primary_customer_journey: T("Головна, каталог, сторінка товару, кошик.", "INFERRED"),
    likely_objections: [T("Невідома вартість доставки.", "INFERRED"), T("Незрозуміло, яка модель підходить.", "INFERRED")],
  },
  primary_conversion_goal: T("Додати фільтр для води в кошик.", "INFERRED"),
  summary: T("Головні бар'єри — ціна й доставка поза першим екраном та незрозумілі позначення моделей.", "INFERRED"),
  lenses: [
    { id: "lens_novice", name: T("Новачок у категорії"), description: T("Не знає технічних позначень, обирає за зрозумілим описом користі."), poles: ["P1"] },
    { id: "lens_expert", name: T("Досвідчений покупець"), description: T("Порівнює характеристики й шукає таблицю відмінностей."), poles: ["P2"] },
    { id: "lens_price", name: T("Уважний до ціни"), description: T("Хоче знати повну вартість із доставкою до рішення."), poles: ["P3", "P7"] },
    { id: "lens_fast", name: T("Швидкий покупець"), description: T("Хоче купити за кілька кліків, без читання деталей."), poles: ["P4", "P5"] },
  ],
  pole_unmet: [{ pole: "P6", nearest_lens_id: "lens_expert" }],
  budget: { max_audit_tokens: 1_650_000, used_tokens: 182_400, billed_tokens: 0, cache_read_tokens: 0, llm_calls: 14, cost: null },
};
