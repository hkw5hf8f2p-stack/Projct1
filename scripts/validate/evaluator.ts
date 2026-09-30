/**
 * Оцінювач для `pnpm validate` (S4). ПРОВАЙДЕР — SCRIPTED FAKE (`toy-evaluator-v1`), НЕ модель: детерміновані правила над
 * текстом сторінки, які повертають відповідь у схемі `snapshot-evaluator-v1`. Він доводить ПЛУМБІНГ валідації (запит →
 * схема → semantic-перевірки → цитата звіряється зі сторінкою → агрегація → звіт → метрики E1–E4), а не якість моделі.
 * Усе, що залежить від відповіді ЖИВОЇ моделі, у звіті позначається ⏭️ live (OQ-1), ніколи ✅.
 *
 * Режими (сценарії негативних контролів критерію S4 №8):
 *   honest             — правила нижче (коректний fake-набір)
 *   invent_terminology — honest + вигадує `terminology` на КОЖНІЙ сторінці з реальною цитатою (сценарій а)
 *   unstable           — honest + у кожному прогоні додає власний «шум» (інша категорія/сторінка) з високою впевненістю (сценарій б)
 *   silent             — завжди `no_issue` (LLM-лише = 0/3, сценарій г)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BehavioralLens } from "../../packages/schemas/src/index.js";
import {
  DirStore, LlmClient, ReplayCache, SessionProvider, TokenBudget, MemoryStore, evaluateSnapshot, estimateTextTokens, type LlmProvider, type LlmRequest, type PageInput, type ProviderResult,
  type SnapshotSessionOut, type StageResult,
  ReplayMissError,
} from "../../packages/llm/src/index.js";

export type EvaluatorKind = "honest" | "invent_terminology" | "unstable" | "silent";
export interface EvaluatorSpec {
  kind: EvaluatorKind;
  /** номер прогону (для `unstable`) */
  run?: number;
}

// ------------------------------------------------------------------------------------------------ лінзи й задачі
const mkLens = (id: string, name: string, knowledge: number, price: number, speed: number, detail: number, goal: string) =>
  BehavioralLens.parse({
    id, audit_run_id: "run_validate", name, description: "Поведінкова лінза для перевірки", category_knowledge: knowledge, price_sensitivity: price, trust_requirement: 0.6,
    decision_speed: speed, detail_preference: detail, visual_sensitivity: 0.5, comparison_tendency: 0.5, risk_aversion: 0.6, convenience_priority: 0.5, social_proof_need: 0.5,
    primary_goal: goal, likely_questions: [], likely_objections: [],
  });
export const VALIDATE_LENSES = [
  mkLens("lens_novice", "Новачок", 0.1, 0.5, 0.4, 0.5, "Зрозуміти, що це за магазин і що обрати"),
  mkLens("lens_price", "Уважний до ціни", 0.5, 0.9, 0.4, 0.6, "Знати повну ціну до кошика"),
  mkLens("lens_fast", "Швидкий", 0.5, 0.3, 0.9, 0.2, "Швидко знайти й купити"),
  mkLens("lens_expert", "Досвідчений", 0.9, 0.4, 0.5, 0.9, "Порівняти характеристики моделей"),
] as const;
/** які лінзи «помічають» правило (лише щоб покриття лінз було різним, а не завжди 4 з 4) */
const LENS_SEES: Record<string, readonly string[]> = {
  value_proposition: ["lens_novice", "lens_fast", "lens_price"],
  terminology: ["lens_novice", "lens_price", "lens_fast"],
  comparison: ["lens_novice", "lens_price", "lens_expert"],
  trust: ["lens_novice", "lens_price"],
};
export const TASKS = {
  homepage: { id: "t_understand", name: "Зрозуміти, що пропонує сайт", goal: "За першим екраном зрозуміти, що продається", task_type: "understand_offering" },
  category: { id: "t_choose", name: "Обрати товар", goal: "Обрати відповідний товар у каталозі", task_type: "choose_product" },
  product: { id: "t_buy", name: "Вирішити щодо купівлі", goal: "Вирішити, чи додавати товар у кошик", task_type: "add_to_cart" },
} as const;
type TaskedType = keyof typeof TASKS;

/** сторінки, що оцінюються: головна, каталог, ≤ 2 товари (детермінований порядок за url) */
export function pagesToEvaluate(pages: readonly PageInput[]): PageInput[] {
  const by = (t: string) => pages.filter((p) => p.page_type === t).sort((a, b) => (a.url < b.url ? -1 : 1));
  return [...by("homepage").slice(0, 1), ...by("category").slice(0, 1), ...by("product").slice(0, 2)];
}
export const plannedCalls = (pages: readonly PageInput[]): number => pagesToEvaluate(pages).length * VALIDATE_LENSES.length;

// ------------------------------------------------------------------------------------------------ правила
const lines = (p: PageInput): string[] => p.visible_text.split("\n").map((s) => s.trim()).filter(Boolean);
const STEM = (w: string): string => w.toLowerCase().slice(0, 5);
const words = (s: string): string[] => s.match(/[\p{L}]{4,}/gu) ?? [];
const COMMERCE_STEMS = new Set(["катал", "товар", "магаз", "shop", "catal", "store"]);
const ABBR = /(?<![\p{L}\p{Nd}])[A-Z]{3,5}(?![\p{L}\p{Nd}])/u;
const PRICE = /\p{Nd}[\p{Nd}\s\u00a0]*(грн|₴|uah|usd|\$|€)/iu;

interface Friction { category: "value_proposition" | "terminology" | "comparison" | "trust"; evidence: string; note: string }

function frictionsFor(page: PageInput, all: readonly PageInput[], lensId: string): Friction[] {
  const out: Friction[] = [];
  const sees = (cat: string): boolean => (LENS_SEES[cat] ?? []).includes(lensId);
  const L = lines(page);
  const h1 = page.headings[0];
  // R-VP: заголовок головної не містить жодного слова з лексики магазину/категорії
  if (page.page_type === "homepage" && h1 && sees("value_proposition")) {
    const siteStems = new Set<string>(COMMERCE_STEMS);
    for (const p of all) if (p.page_type !== "homepage" && p.headings[0]) for (const w of words(p.headings[0])) siteStems.add(STEM(w));
    if (!words(h1).some((w) => siteStems.has(STEM(w)))) out.push({ category: "value_proposition", evidence: `"${h1}"`, note: "Заголовок не називає, що продається." });
  }
  // R-TERM: непояснене скорочення з великих літер (HFX, SLT)
  if ((page.page_type === "category" || page.page_type === "product") && sees("terminology")) {
    const line = L.find((s) => ABBR.test(s) && s.length <= 200 && !s.includes('"'));
    if (line) out.push({ category: "terminology", evidence: `"${line}"`, note: "Скорочення в назві не пояснено." });
  }
  // R-CMP: у каталозі однакові описи різних моделей (цитата) або нема цін, щоб порівняти (відсутність)
  if (page.page_type === "category" && sees("comparison")) {
    const seen = new Map<string, number>();
    for (const s of L) if (s.length >= 20) seen.set(s, (seen.get(s) ?? 0) + 1);
    const dup = [...seen].find(([, n]) => n >= 2);
    if (dup) out.push({ category: "comparison", evidence: `"${dup[0]}"`, note: "Описи різних моделей однакові." });
    else if (!PRICE.test(page.visible_text)) out.push({ category: "comparison", evidence: "NOT_FOUND: ціни або відмінності моделей у списку каталогу", note: "У списку нема чим порівняти товари." });
  }
  // R-TRUST: головна/товар без посилання «Про нас» і без згадки гарантії
  if ((page.page_type === "homepage" || page.page_type === "product") && sees("trust")) {
    const hasAbout = page.link_texts.some((t) => /про нас|about|контакт/iu.test(t));
    const hasWarranty = /гаранті|warranty/iu.test(page.visible_text);
    if (!hasAbout && !hasWarranty) out.push({ category: "trust", evidence: "NOT_FOUND: інформація про магазин чи гарантію", note: "Не видно, хто продає і на яких умовах." });
  }
  return out;
}

/** «шум» режимів invent_terminology / unstable: реальна цитата зі сторінки, категорія не з правил */
function noiseFor(spec: EvaluatorSpec, page: PageInput, lensId: string): Friction[] {
  const quote = (lines(page).find((s) => s.length >= 12 && s.length <= 120 && !s.includes('"')) ?? page.title) as string;
  if (spec.kind === "invent_terminology") return [{ category: "terminology", evidence: `"${quote}"`, note: "Незрозумілий термін." }];
  if (spec.kind === "unstable") {
    // кожен прогін «вигадує» інший набір категорій на інших сторінках; усі лінзи одностайні → STRONG. Модель у різних прогонах розходиться.
    const r = spec.run ?? 0;
    const cats = ["cta", "shipping", "pricing", "navigation", "checkout", "content_overload"] as const;
    const pick = cats[(r * 2 + (page.page_type === "product" ? 1 : 0)) % cats.length] as Friction["category"] | (typeof cats)[number];
    const want = r % 3;
    if ((page.page_type === "homepage" && want === 0) || (page.page_type === "category" && want === 1) || (page.page_type === "product" && want === 2))
      return [{ category: pick as Friction["category"], evidence: `"${quote}"`, note: `Проблема, помічена лише в прогоні ${r + 1}.` }];
  }
  void lensId;
  return [];
}

function respond(spec: EvaluatorSpec, page: PageInput, all: readonly PageInput[], lensId: string): unknown {
  const base = { noticed: ["Головний вміст сторінки видно."], understood: ["Зрозуміло, який це тип сторінки."], unclear: [] as string[], likely_next_action: "Перейти далі за посиланням.", positive_signals: [] as string[], uncertainties: [] as string[] };
  const RULE_ORDER = ["value_proposition", "terminology", "comparison", "trust"];
  // unstable: модель у кожному прогоні «бачить» інший піднабір правил (за номером прогону) + власний шум → різні LLM-знахідки
  const honestFr = frictionsFor(page, all, lensId).filter((f) => spec.kind !== "unstable" || RULE_ORDER.indexOf(f.category) % 3 === (spec.run ?? 0) % 3);
  const fr = spec.kind === "silent" ? [] : [...honestFr, ...noiseFor(spec, page, lensId)];
  if (fr.length === 0) return { ...base, verdict: "no_issue", frictions: [], success: "true", final_summary: "Сторінка достатня для цієї задачі." };
  return {
    ...base,
    verdict: "issues_found",
    unclear: fr.map((f) => f.note).slice(0, 6),
    frictions: fr.slice(0, 6).map((f) => ({ category: f.category, claim_kind: "general", severity: "medium", evidence: f.evidence, tile_id: "t0" })),
    success: "partial",
    final_summary: "Є перешкоди для задачі.",
  };
}

/** Провайдер-fake: відповідь за правилами; лічить токени й повідомляє в `onCall` (глобальний ліміт MAX_VALIDATE_TOKENS) */
export class ToyEvaluatorProvider implements LlmProvider {
  readonly name = "fake" as const;
  readonly model = "toy-evaluator-v1";
  calls = 0;
  constructor(private readonly pages: readonly PageInput[], private readonly spec: EvaluatorSpec, private readonly onCall?: (tokens: number) => void, private readonly beforeCall?: (estimate: number) => void) {}
  async complete(req: LlmRequest): Promise<ProviderResult> {
    const url = req.logical_key.page_url;
    const page = this.pages.find((p) => p.url === url);
    if (!page) throw new ReplayMissError(`toy evaluator: сторінку ${String(url)} не знайдено`, String(url));
    const textIn = req.system + req.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    const inTok = estimateTextTokens(textIn) + req.content.filter((p) => p.type === "image").length * 1200;
    this.beforeCall?.(inTok + req.sampling.max_tokens);
    const json = respond(this.spec, page, this.pages, String(req.logical_key.lens_id));
    const outTok = estimateTextTokens(JSON.stringify(json));
    this.calls++;
    this.onCall?.(inTok + outTok);
    return { json, input_tokens: inTok, output_tokens: outTok, provider: "fake", model: this.model, latency_ms: 0, synthetic: true };
  }
}

// ------------------------------------------------------------------------------------------------ прогін сесій
export interface EvalRunOptions {
  pages: readonly PageInput[];
  spec: EvaluatorSpec;
  /** MAX_AUDIT_TOKENS цього аудиту (E4) */
  max_audit_tokens: number;
  cache_mode: "use" | "bypass";
  /** спільний кеш; у `bypass` він має лишитись непорушеним (лічильники доводять обхід) */
  store?: MemoryStore;
  onCall?: (tokens: number) => void;
  beforeCall?: (estimate: number) => void;
  language?: "uk" | "en";
  /** replay: без провайдера, лише кеш (доводить обв'язку запис→відтворення; несумісний з bypass — ConfigError) */
  mode?: "live" | "replay";
  /**
   * S7 без API (DEV-82): замість fake-оцінювача — транспорт `session`. `export`/`import` = SessionProvider (запит → requests/, відповідь → та сама
   * обробка, що й API, запис у кеш E5); `replay` = лише кеш сесії, промах — гучна ReplayMissError. bypass тут не діє: E2 = окремий namespace на прогін.
   */
  session?: { root: string; model: string; namespace: string; scenario: string; phase: "session" | "replay"; /** відтворення за логічним ключем (див. LogicalKeyReplayProvider) */ by_logical_key?: boolean };
}
export interface EvalRun {
  sessions: SnapshotSessionOut[];
  planned_calls: number;
  budget_limited: boolean;
  rejected_stage_results: Array<{ page: string; lens: string; status: string; reason?: string }>;
  client: LlmClient;
  cache: ReplayCache;
  /** скільки викликів чекають відповіді сесійної моделі (`awaiting_session_model`) */
  awaiting: number;
  /** id запитів, записаних у requests/ цим прогоном */
  written_requests: string[];
}

export type SessionSpec = NonNullable<EvalRunOptions["session"]>;

/**
 * Відтворення записаних відповідей сесійної моделі за ЛОГІЧНИМ ключем (prompt_id, сторінка, лінза, задача, крок, attempt), а не за хешем запиту E5.
 * Навіщо (DEV-88): прогін A записано ДО виправлення промпта (A11Y-плейсхолдер), тож його ключі E5 не збігаються з поточними запитами — replay за хешем дав би промах.
 * Відповіді ті самі (байт у байт із кешу), але проходять ТУ САМУ обробку, що й в API (LlmClient: JSON → Zod → semantic/guard → repair) поточним кодом.
 * Це НЕ доказ, що модель відповіла б так само на виправлений промпт: лише перерахунок ПОТОЧНИМ кодом (guard, integrate, метрики) відповідей A.
 */
export class LogicalKeyReplayProvider implements LlmProvider {
  readonly name = "replay" as const;
  private readonly byKey = new Map<string, { entry: Record<string, unknown>; model: string }>();
  constructor(root: string, readonly model: string, namespace: string) {
    const dir = path.join(root, "cache", namespace);
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const e = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { model?: string; provider?: string; request_summary?: { logical_key?: Record<string, unknown> } };
      const lk = e.request_summary?.logical_key;
      if (e.provider !== "session" || e.model !== model || !lk) continue;
      this.byKey.set(JSON.stringify([lk["prompt_id"], lk["page_url"], lk["lens_id"], lk["task_id"], lk["step"] ?? 0, lk["attempt"] ?? 0]), { entry: e as Record<string, unknown>, model: e.model });
    }
  }
  get size(): number { return this.byKey.size; }
  async complete(req: LlmRequest): Promise<ProviderResult> {
    const k = req.logical_key;
    const hit = this.byKey.get(JSON.stringify([k.prompt_id, k.page_url, k.lens_id, k.task_id, k.step ?? 0, k.attempt ?? 0]));
    if (!hit) throw new ReplayMissError(`replay за логічним ключем: немає відповіді для ${k.prompt_id} ${String(k.page_url)} ${String(k.lens_id)} attempt=${k.attempt ?? 0}`, JSON.stringify(k));
    const e = hit.entry as { response: unknown; raw_text?: string; input_tokens: number; output_tokens: number };
    return { json: e.response, ...(e.raw_text !== undefined ? { raw_text: e.raw_text } : {}), input_tokens: e.input_tokens, output_tokens: e.output_tokens, provider: "session", model: hit.model, latency_ms: 0, tokens_estimated: true };
  }
}
/** Клієнт транспорту session: phase=session → SessionProvider (запис запитів, обробка відповідей як API, запис у кеш); phase=replay → лише читання кешу */
export function sessionClient(se: SessionSpec, language: "uk" | "en", maxTokens: number): { client: LlmClient; cache: ReplayCache; provider: SessionProvider | null } {
  const cache = new ReplayCache(new DirStore(path.join(se.root, "cache"), se.phase === "replay"), se.namespace);
  if (se.by_logical_key) {
    const provider = new LogicalKeyReplayProvider(se.root, se.model, se.namespace);
    return { client: new LlmClient({ mode: "fake", provider, budget: new TokenBudget(maxTokens), cache_identity: { provider: "session", model: se.model } }), cache, provider: null };
  }
  if (se.phase === "replay") {
    return { client: new LlmClient({ mode: "replay", cache, cache_mode: "use", budget: new TokenBudget(maxTokens), cache_identity: { provider: "session", model: se.model } }), cache, provider: null };
  }
  const provider = new SessionProvider({ root: se.root, model: se.model, namespace: se.namespace, scenario: se.scenario, language });
  return { client: new LlmClient({ mode: "live", provider, cache, cache_mode: "use", budget: new TokenBudget(maxTokens), record_rejected: true }), cache, provider };
}

/** Уся LLM-частина одного аудиту: snapshot-сесії всіх (сторінка × лінза) через реальний `evaluateSnapshot` + `LlmClient` */
export async function runSnapshotSessions(o: EvalRunOptions): Promise<EvalRun> {
  let sessionProvider: SessionProvider | null = null;
  let cache: ReplayCache;
  let client: LlmClient;
  if (o.session) {
    ({ client, cache, provider: sessionProvider } = sessionClient(o.session, o.language ?? "uk", o.max_audit_tokens));
  } else {
    const provider = new ToyEvaluatorProvider(o.pages, o.spec, o.onCall, o.beforeCall);
    cache = new ReplayCache(o.store ?? new MemoryStore(), "validate-fake-v1");
    client = new LlmClient({
      mode: o.mode ?? "live", ...(o.mode === "replay" ? {} : { provider }), cache, cache_mode: o.cache_mode, budget: new TokenBudget(o.max_audit_tokens),
      cache_identity: { provider: "fake", model: provider.model },
    });
  }
  let awaiting = 0;
  const sessions: SnapshotSessionOut[] = [];
  const results: EvalRun["rejected_stage_results"] = [];
  const list = pagesToEvaluate(o.pages);
  let limited = false;
  outer: for (const page of list) {
    const task = TASKS[page.page_type as TaskedType];
    for (const lens of VALIDATE_LENSES) {
      const r: StageResult<{ session: SnapshotSessionOut }> = await evaluateSnapshot(
        { audit_run_id: "run_validate", client, language: o.language ?? "uk" },
        {
          page, lens, task, tiles: [{ id: "t0", y_css: 0, height_css: 1000, image: page.image ?? { type: "image", media_type: "image/png", sha256: "0".repeat(64), label: "first viewport" } }],
          tiles_total: 1, a11y_outline: `main\n  heading '${page.headings[0] ?? ""}'`,
        },
      );
      if (r.status === "budget_limited") {
        limited = true;
        results.push({ page: page.url, lens: lens.id, status: r.status, reason: r.reason });
        break outer; // етап зупинено: жодних подальших викликів (E4)
      }
      if (r.status === "awaiting_session_model") {
        awaiting++;
        results.push({ page: page.url, lens: lens.id, status: r.status, reason: r.reason });
        continue; // усі незалежні запити експортуються за один прохід
      }
      if (r.status !== "done" || !r.output) {
        results.push({ page: page.url, lens: lens.id, status: r.status, reason: r.reason });
        continue;
      }
      sessions.push(r.output.session);
    }
  }
  return { sessions, planned_calls: list.length * VALIDATE_LENSES.length, budget_limited: limited, rejected_stage_results: results, client, cache, awaiting, written_requests: sessionProvider?.written ?? [] };
}
