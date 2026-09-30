import path from "node:path";
import { DEFAULT_MAX_AUDIT_TOKENS, TokenBudget } from "./budget.js";
import { DirStore, ReplayCache } from "./cache.js";
import { LlmClient } from "./client.js";
import { ConfigError } from "./errors.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAiProvider } from "./providers/openai.js";
import type { Logger } from "./redact.js";
import type { CacheMode, FetchLike } from "./types.js";

export type Env = Record<string, string | undefined>;
export type LlmModeAudit = "live" | "replay" | "none";

export interface ResolvedConfig {
  llm_mode: LlmModeAudit;
  provider: "anthropic" | "openai" | "replay" | null;
  model: string | null;
  max_audit_tokens: number;
  cache_mode: CacheMode;
  /** секрети, які треба редагувати в логах */
  secrets: string[];
}

const isProd = (env: Env) => env.NODE_ENV === "production" || env.SITELENS_ENV === "production";

/**
 * Провайдер і модель — лише з env (жодного хардкоду моделі). Без LLM_PROVIDER: береться той, чий ключ є; немає ключів → none (G0-2).
 * replay дозволений лише поза production (G0-2, DEV-11).
 */
export function resolveConfig(env: Env): ResolvedConfig {
  const max = env.MAX_AUDIT_TOKENS ? Number(env.MAX_AUDIT_TOKENS) : DEFAULT_MAX_AUDIT_TOKENS;
  if (!Number.isFinite(max) || max <= 0) throw new ConfigError("MAX_AUDIT_TOKENS має бути додатним числом");
  const cache_mode: CacheMode = env.LLM_CACHE_MODE === "bypass" ? "bypass" : "use";
  const secrets = [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY].filter((s): s is string => !!s);
  let p = env.LLM_PROVIDER?.trim().toLowerCase() || "";
  if (!p) p = env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : "none";
  if (p === "none") return { llm_mode: "none", provider: null, model: null, max_audit_tokens: max, cache_mode, secrets };
  if (p === "replay") {
    if (isProd(env)) throw new ConfigError("LLM_PROVIDER=replay заборонено в production: replay лише для dev/test (G0-2)");
    return { llm_mode: "replay", provider: "replay", model: env.LLM_MODEL ?? null, max_audit_tokens: max, cache_mode, secrets };
  }
  if (p !== "anthropic" && p !== "openai") throw new ConfigError(`LLM_PROVIDER=${p}: очікується anthropic|openai|replay|none`);
  const key = p === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!key) throw new ConfigError(`LLM_PROVIDER=${p}, але ${p === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} не задано`);
  if (!env.LLM_MODEL) throw new ConfigError("LLM_MODEL не задано: модель не хардкодиться (SPEC §6)");
  return { llm_mode: "live", provider: p, model: env.LLM_MODEL, max_audit_tokens: max, cache_mode, secrets };
}

export interface ClientDeps { fetchImpl?: FetchLike; logger?: Logger; replayDir?: string; namespace?: string; sleep?: (ms: number) => Promise<void> }

/** Клієнт зі змінних середовища. none → клієнт режиму none (кожен виклик = LlmDisabledError, етапи роблять skipped). */
export function createClientFromEnv(env: Env, deps: ClientDeps = {}): { client: LlmClient; config: ResolvedConfig } {
  const config = resolveConfig(env);
  const budget = new TokenBudget(config.max_audit_tokens);
  const common = { budget, logger: deps.logger, cache_mode: config.cache_mode, secrets: config.secrets };
  if (config.llm_mode === "none") return { client: new LlmClient({ mode: "none", ...common }), config };
  const ns = deps.namespace ?? env.LLM_CACHE_NAMESPACE ?? "default";
  const dir = deps.replayDir ?? env.REPLAY_DIR ?? path.resolve("fixtures/replay");
  if (config.llm_mode === "replay") {
    const cache = new ReplayCache(new DirStore(dir, true), ns);
    const [prov, model] = (env.REPLAY_AS ?? "replay:synthetic-fixture-v1").split(/:(.*)/s);
    return { client: new LlmClient({ mode: "replay", cache, cache_identity: { provider: prov ?? "replay", model: model || "synthetic-fixture-v1" }, ...common }), config };
  }
  const key = (config.provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) as string;
  const cfg = { apiKey: key, model: config.model as string, fetchImpl: deps.fetchImpl, sleep: deps.sleep, baseUrl: config.provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL };
  const provider = config.provider === "anthropic" ? new AnthropicProvider(cfg) : new OpenAiProvider(cfg);
  const cache = new ReplayCache(new DirStore(dir), ns);
  return { client: new LlmClient({ mode: "live", provider, cache, ...common }), config };
}
