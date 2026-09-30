import type { ZodType } from "zod";
import type { LlmCall } from "@sitelens/schemas";
import { REPAIR_TEMPLATE } from "../prompts/common.js";
import { cacheKey, type CacheEntry, type CacheIdentity, type ReplayCache } from "./cache.js";
import { sha256 } from "./canonical.js";
import { LlmDisabledError, OutputInvalidError, ReplayMissError, ConfigError, BudgetExceededError } from "./errors.js";
import type { TokenBudget } from "./budget.js";
import { nullLogger, redact, redactDeep, type Logger } from "./redact.js";
import { estimateInputTokens } from "./tokens.js";
import type { CacheMode, LlmProvider, LlmRequest, ProviderResult } from "./types.js";

/** live: реальний провайдер (+ запис у кеш); replay: лише кеш, промах = помилка; fake: scripted fake; none: LLM-етапи skipped */
export type ClientMode = "live" | "replay" | "fake" | "none";

export interface CallRecord {
  call_id: string;
  stage: string;
  prompt_id: string;
  provider: string;
  model: string;
  request_hash: string;
  source: "provider" | "cache" | "fake";
  synthetic: boolean;
  attempt: number;
  status: "ok" | "invalid";
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  temperature_dropped: boolean;
  response: unknown;
  tokens_estimated?: boolean;
}

export interface ClientOptions {
  mode: ClientMode;
  provider?: LlmProvider | null;
  cache?: ReplayCache | null;
  cache_mode?: CacheMode;
  budget: TokenBudget;
  /** ідентичність для ключа E5; для replay — «як записано», для запису фікстур scripted-скриптом */
  cache_identity?: CacheIdentity;
  logger?: Logger;
  now?: () => Date;
  /** значення ключів з env: вилучаються з усього, що зберігається (записи кешу, CallRecord), навіть якщо модель їх «відлунила» */
  secrets?: readonly string[];
  /** транспорт session: писати в кеш і ВІДХИЛЕНІ відповіді (rejected:true), щоб replay відтворив repair-гілку. Типово вимкнено (принцип G0-16: у кеш лише валідне) */
  record_rejected?: boolean;
}

/** Результат виклику: значення пройшло Zod (і семантичні правила), або кинуто OutputInvalidError. */
export interface CallResult<T> { value: T; calls: CallRecord[] }

/** Zod-порушення з мітками правил: extra_field / missing_field / schema (мітки читають етапи й ворожі тести) */
const zodIssues = (e: { issues: Array<{ code: string; path: (string | number)[]; message: string; received?: unknown; keys?: string[] }> }): string[] =>
  e.issues.slice(0, 12).map((i) => {
    const where = i.path.join(".") || "(root)";
    if (i.code === "unrecognized_keys") return `extra_field: ${where}: ${(i.keys ?? []).join(",")}`;
    if (i.code === "invalid_type" && i.received === "undefined") return `missing_field: ${where}`;
    return `schema: ${where}: ${i.message}`;
  });

export class LlmClient {
  readonly records: CallRecord[] = [];
  private seq = 0;
  readonly mode: ClientMode;
  readonly cache_mode: CacheMode;
  private readonly log: Logger;

  constructor(private readonly o: ClientOptions) {
    this.mode = o.mode;
    this.cache_mode = o.cache_mode ?? "use";
    this.log = o.logger ?? nullLogger;
    if (o.mode === "replay" && !o.cache) throw new ConfigError("replay: потрібен кеш");
    if (o.mode === "replay" && this.cache_mode === "bypass") throw new ConfigError("replay + cache_mode=bypass: нічого відтворювати");
    if ((o.mode === "live" || o.mode === "fake") && !o.provider) throw new ConfigError(`${o.mode}: потрібен провайдер`);
  }

  get budget(): TokenBudget { return this.o.budget; }
  get providerName(): string { return this.identity().provider; }
  get modelName(): string { return this.identity().model; }

  private identity(): CacheIdentity {
    if (this.o.cache_identity) return this.o.cache_identity;
    if (this.o.provider) return { provider: this.o.provider.name, model: this.o.provider.model };
    return { provider: "replay", model: "unspecified" };
  }

  /**
   * Один логічний виклик: (кеш | провайдер) → Zod → семантика → максимум один repair-повтор.
   * Після другої невдачі — OutputInvalidError (етап позначить failed/partial; нічого не «виправляється мовчки»).
   */
  async call<T>(req: LlmRequest, schema: ZodType<T>, semantic?: (v: T) => string[]): Promise<CallResult<T>> {
    if (this.mode === "none") throw new LlmDisabledError();
    const calls: CallRecord[] = [];
    let current = req;
    let issues: string[] = [];
    let lastRaw: unknown = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const withAttempt: LlmRequest = { ...current, logical_key: { ...req.logical_key, attempt } };
      const { result, rec, pending } = await this.once(withAttempt, attempt);
      calls.push(rec);
      lastRaw = result.json ?? result.raw_text ?? null;
      issues = [];
      if (result.json === null || result.json === undefined) {
        issues = ["invalid_json: response is not valid JSON / no structured output"];
      } else {
        const parsed = schema.safeParse(result.json);
        if (!parsed.success) issues = zodIssues(parsed.error);
        else {
          const sem = semantic ? semantic(parsed.data) : [];
          if (sem.length === 0) {
            // у кеш потрапляє лише ВАЛІДОВАНА відповідь: невалідна не «запікається» у replay і не виживає як фікстура
            if (pending && this.o.cache) this.o.cache.put(pending.key, pending);
            return { value: parsed.data, calls };
          }
          issues = sem;
        }
      }
      rec.status = "invalid";
      if (pending && this.o.cache && this.o.record_rejected) this.o.cache.put(pending.key, { ...pending, rejected: true, issues: issues.slice(0, 12) });
      this.log.warn("llm output rejected", { prompt_id: req.prompt_id, attempt, issues: issues.slice(0, 5) });
      if (attempt === 0) {
        // repair-повтор: той самий запит + перелік порушень (це інший вміст → інший ключ E5)
        current = { ...req, content: [...req.content, { type: "text", text: REPAIR_TEMPLATE.replace("{{ISSUES}}", `- ${issues.join("\n- ")}`) }] };
      }
    }
    throw new OutputInvalidError(`${req.prompt_id}: output invalid after repair retry`, issues, lastRaw);
  }

  private clean<T>(v: T): T { return this.o.secrets?.length ? redactDeep(v, this.o.secrets) : v; }

  private async once(req: LlmRequest, attempt: number): Promise<{ result: ProviderResult; rec: CallRecord; pending?: CacheEntry }> {
    const id = this.identity();
    const key = cacheKey(id, req);
    const budget = this.o.budget;
    const cache = this.o.cache ?? null;
    const useCache = cache !== null && this.mode !== "fake" && this.cache_mode === "use";
    const call_id = `call_${++this.seq}`;
    const base = { call_id, stage: req.stage, prompt_id: req.prompt_id, request_hash: key, attempt, status: "ok" as const };

    if (useCache) {
      const hit = cache.get(key);
      if (hit) {
        budget.assertCanAfford(hit.input_tokens + hit.output_tokens, `${req.prompt_id} (cache)`);
        const result: ProviderResult = { json: hit.response, raw_text: hit.raw_text, input_tokens: hit.input_tokens, output_tokens: hit.output_tokens, provider: hit.provider, model: hit.model, latency_ms: 0, synthetic: hit.synthetic };
        budget.record({ call_id, stage: req.stage, source: "cache", input_tokens: hit.input_tokens, output_tokens: hit.output_tokens });
        return { result, rec: this.push({ ...base, provider: hit.provider, model: hit.model, source: "cache", synthetic: hit.synthetic, input_tokens: hit.input_tokens, output_tokens: hit.output_tokens, latency_ms: 0, temperature_dropped: false, response: hit.response, ...(hit.tokens_estimated ? { tokens_estimated: true } : {}) }) };
      }
    }
    if (this.mode === "replay") {
      throw new ReplayMissError(`replay: промах кешу для ${req.prompt_id} (ключ ${key.slice(0, 12)}…, ns=${cache?.namespace}); живий провайдер НЕ викликається`, key);
    }
    const provider = this.o.provider as LlmProvider;
    budget.assertCanAfford(estimateInputTokens(req) + req.sampling.max_tokens, `${req.prompt_id} (оцінка входу + max_tokens)`);
    const result = await provider.complete(req);
    const source = this.mode === "fake" ? "fake" : "provider";
    // фактичні токени провайдера; перевищення після факту неможливе завдяки резерву max_tokens вище
    budget.record({ call_id, stage: req.stage, source, input_tokens: result.input_tokens, output_tokens: result.output_tokens });
    let pending: CacheEntry | undefined;
    if (cache && this.cache_mode === "use" && this.mode === "live") {
      pending = {
        key, provider: id.provider, model: id.model, prompt_id: req.prompt_id, synthetic: result.synthetic === true,
        response: this.clean(result.json), raw_text: result.raw_text === undefined ? undefined : redact(result.raw_text, this.o.secrets ?? []), input_tokens: result.input_tokens, output_tokens: result.output_tokens,
        ...(result.provenance ? { provenance: this.clean(result.provenance) } : {}), ...(result.tokens_estimated ? { tokens_estimated: true } : {}),
        request_summary: {
          stage: req.stage, logical_key: req.logical_key, sampling: req.sampling, system_sha256: sha256(req.system),
          image_sha256: req.content.flatMap((p) => (p.type === "image" ? [p.sha256] : [])),
        },
        recorded_at: (this.o.now?.() ?? new Date()).toISOString(),
      };
    }
    return { result, pending, rec: this.push({ ...base, provider: result.provider, model: result.model, source, synthetic: result.synthetic === true, input_tokens: result.input_tokens, output_tokens: result.output_tokens, latency_ms: result.latency_ms, temperature_dropped: result.temperature_dropped === true, response: this.clean(result.json), ...(result.tokens_estimated ? { tokens_estimated: true } : {}) }) };
  }

  private push(r: CallRecord): CallRecord { this.records.push(r); return r; }

  /** Запис для таблиці llm_calls (LlmCall §35) */
  toLlmCall(r: CallRecord, audit_run_id: string | null, stage: LlmCall["stage"]): LlmCall {
    return {
      id: r.call_id, audit_run_id, stage, prompt_version: r.prompt_id,
      provider: r.provider === "anthropic" || r.provider === "openai" ? r.provider : "replay",
      model: r.model, request_hash: r.request_hash, response_json: r.response ?? null,
      status: r.status === "invalid" ? "error" : r.source === "cache" ? "cached" : "ok",
      error: r.status === "invalid" ? "output rejected by validation" : null,
      input_tokens: r.input_tokens, output_tokens: r.output_tokens, latency_ms: Math.round(r.latency_ms),
      created_at: (this.o.now?.() ?? new Date()).toISOString(),
    };
  }
}
export { BudgetExceededError };
