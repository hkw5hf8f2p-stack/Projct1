import path from "node:path";
import { DEFAULT_MAX_AUDIT_TOKENS, TokenBudget } from "./budget.js";
import { DirStore, ReplayCache } from "./cache.js";
import { LlmClient } from "./client.js";
import { ConfigError } from "./errors.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { ClaudeCliProvider } from "./providers/claude-cli.js";
import { DEFAULT_NAMESPACE, SessionProvider } from "./providers/session.js";
import { OpenAiProvider } from "./providers/openai.js";
import { OpenAiChatProvider } from "./providers/openai-chat.js";
import type { Logger } from "./redact.js";
import type { CacheMode, FetchLike } from "./types.js";

export type Env = Record<string, string | undefined>;
export type LlmModeAudit = "live" | "replay" | "none";
export type OpenAiApiMode = "responses" | "chat";

/**
 * Режим OpenAI-адаптера. Явний `OPENAI_API_MODE=responses|chat` — понад усе. Інакше: `LLM_PROVIDER=openai_compatible` або `OPENAI_BASE_URL` не на api.openai.com
 * (так BYO-налаштування «openai_compatible» доходить до пакета) → chat completions (Ollama/LM Studio/vLLM не мають /v1/responses); інакше responses.
 */
export function resolveOpenAiApiMode(env: Env, compatible: boolean): OpenAiApiMode {
  const raw = env.OPENAI_API_MODE?.trim().toLowerCase();
  if (raw) {
    if (raw === "responses") return "responses";
    if (raw === "chat" || raw === "chat_completions" || raw === "chat-completions") return "chat";
    throw new ConfigError(`OPENAI_API_MODE=${raw}: очікується responses|chat`);
  }
  if (compatible) return "chat";
  const base = env.OPENAI_BASE_URL?.trim();
  if (!base) return "responses";
  try { return new URL(base).hostname === "api.openai.com" ? "responses" : "chat"; } catch { throw new ConfigError("OPENAI_BASE_URL: некоректний URL"); }
}

export interface ResolvedConfig {
  llm_mode: LlmModeAudit;
  provider: "anthropic" | "openai" | "replay" | "session" | "claude-cli" | null;
  model: string | null;
  /** DEV-82/83: транспорт поза API-ключем. Для AuditRun/Report схема лишається llm_mode ∈ {live,replay,none} (session → replay, claude-cli → live) */
  transport: "session" | "claude-cli" | null;
  /** лише для provider=openai: Responses API чи Chat Completions (DEV-89); openai_compatible і чужий OPENAI_BASE_URL → chat */
  openai_api_mode?: OpenAiApiMode;
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
  const secrets = [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN].filter((s): s is string => !!s);
  let p = env.LLM_PROVIDER?.trim().toLowerCase() || "";
  if (!p) p = env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : "none";
  if (p === "none") return { llm_mode: "none", provider: null, model: null, transport: null, max_audit_tokens: max, cache_mode, secrets };
  if (p === "replay") {
    if (isProd(env)) throw new ConfigError("LLM_PROVIDER=replay заборонено в production: replay лише для dev/test (G0-2)");
    const asSession = (env.REPLAY_AS ?? "").startsWith("session:");
    return { llm_mode: "replay", provider: "replay", model: env.LLM_MODEL ?? null, transport: asSession ? "session" : null, max_audit_tokens: max, cache_mode, secrets };
  }
  if (p === "session") {
    if (isProd(env)) throw new ConfigError("LLM_PROVIDER=session заборонено в production: транспорт лише для живого пасу S7 без API (DEV-82)");
    if (!env.SESSION_MODEL_NAME) throw new ConfigError("LLM_PROVIDER=session: SESSION_MODEL_NAME не задано (входить у ключ E5 і в provenance)");
    if (cache_mode === "bypass") throw new ConfigError("LLM_PROVIDER=session + LLM_CACHE_MODE=bypass: відповіді сесії живуть лише в кеші; для E2 бери окремий LLM_CACHE_NAMESPACE на прогін");
    return { llm_mode: "replay", provider: "session", model: env.SESSION_MODEL_NAME, transport: "session", max_audit_tokens: max, cache_mode, secrets };
  }
  if (p === "claude-cli") {
    if (isProd(env)) throw new ConfigError("LLM_PROVIDER=claude-cli заборонено в production: підписка — для особистого/локального використання (DEV-83)");
    return { llm_mode: "live", provider: "claude-cli", model: env.LLM_MODEL ?? null, transport: "claude-cli", max_audit_tokens: max, cache_mode, secrets };
  }
  const compatible = p === "openai_compatible" || p === "openai-compatible";
  if (compatible) {
    if (!env.OPENAI_BASE_URL?.trim()) throw new ConfigError("LLM_PROVIDER=openai_compatible: OPENAI_BASE_URL не задано (адреса сервера, напр. http://127.0.0.1:11434/v1)");
    if (!env.LLM_MODEL) throw new ConfigError("LLM_MODEL не задано: модель не хардкодиться (SPEC §6)");
    // локальні сервери часто без ключа: підставляємо заглушку (як BYO-overlay); справжній ключ, якщо заданий, редагується в логах
    return { llm_mode: "live", provider: "openai", model: env.LLM_MODEL, transport: null, openai_api_mode: resolveOpenAiApiMode(env, true), max_audit_tokens: max, cache_mode, secrets };
  }
  if (p !== "anthropic" && p !== "openai") throw new ConfigError(`LLM_PROVIDER=${p}: очікується anthropic|openai|openai_compatible|claude-cli|session|replay|none`);
  const key = p === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  if (!key) throw new ConfigError(`LLM_PROVIDER=${p}, але ${p === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} не задано`);
  if (!env.LLM_MODEL) throw new ConfigError("LLM_MODEL не задано: модель не хардкодиться (SPEC §6)");
  return { llm_mode: "live", provider: p, model: env.LLM_MODEL, transport: null, ...(p === "openai" ? { openai_api_mode: resolveOpenAiApiMode(env, false) } : {}), max_audit_tokens: max, cache_mode, secrets };
}

export interface ClientDeps { fetchImpl?: FetchLike; logger?: Logger; replayDir?: string; namespace?: string; sleep?: (ms: number) => Promise<void> }

/** Клієнт зі змінних середовища. none → клієнт режиму none (кожен виклик = LlmDisabledError, етапи роблять skipped). */
export function createClientFromEnv(env: Env, deps: ClientDeps = {}): { client: LlmClient; config: ResolvedConfig } {
  const config = resolveConfig(env);
  const budget = new TokenBudget(config.max_audit_tokens);
  const common = { budget, logger: deps.logger, cache_mode: config.cache_mode, secrets: config.secrets };
  if (config.llm_mode === "none") return { client: new LlmClient({ mode: "none", ...common }), config };
  const ns = deps.namespace ?? env.LLM_CACHE_NAMESPACE ?? (config.transport === "session" ? DEFAULT_NAMESPACE : "default");
  const dir = deps.replayDir ?? env.REPLAY_DIR ?? path.resolve("fixtures/replay");
  if (config.provider === "session") {
    const root = env.S7_SESSION_DIR ?? path.resolve("planning/qa/artifacts/s7-session");
    const sdir = deps.replayDir ?? env.REPLAY_DIR ?? path.join(root, "cache");
    const provider = new SessionProvider({ root, model: config.model as string, namespace: ns, language: env.SESSION_LANGUAGE === "en" ? "en" : env.SESSION_LANGUAGE === "uk" ? "uk" : undefined });
    return { client: new LlmClient({ mode: "live", provider, cache: new ReplayCache(new DirStore(sdir), ns), record_rejected: true, ...common }), config };
  }
  if (config.provider === "claude-cli") {
    const provider = new ClaudeCliProvider({ model: config.model ?? undefined, env, timeoutMs: env.CLAUDE_CLI_TIMEOUT_MS ? Number(env.CLAUDE_CLI_TIMEOUT_MS) : undefined });
    return { client: new LlmClient({ mode: "live", provider, cache: new ReplayCache(new DirStore(dir), ns), ...common }), config };
  }
  if (config.llm_mode === "replay") {
    const cache = new ReplayCache(new DirStore(dir, true), ns);
    const [prov, model] = (env.REPLAY_AS ?? "replay:synthetic-fixture-v1").split(/:(.*)/s);
    return { client: new LlmClient({ mode: "replay", cache, cache_identity: { provider: prov ?? "replay", model: model || "synthetic-fixture-v1" }, ...common }), config };
  }
  const key = (config.provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY || (env.OPENAI_BASE_URL ? "local-no-key" : undefined)) as string;
  const cfg = { apiKey: key, model: config.model as string, fetchImpl: deps.fetchImpl, sleep: deps.sleep, baseUrl: config.provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL };
  const provider = config.provider === "anthropic" ? new AnthropicProvider(cfg) : config.openai_api_mode === "chat" ? new OpenAiChatProvider(cfg) : new OpenAiProvider(cfg);
  const cache = new ReplayCache(new DirStore(dir), ns);
  return { client: new LlmClient({ mode: "live", provider, cache, ...common }), config };
}
