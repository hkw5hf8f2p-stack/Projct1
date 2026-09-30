/** Гучні помилки шару LLM. Жодна з них не має «тихого» фолбеку. */
export class LlmError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** промах у replay / scripted fake — ніколи не йдемо до живого провайдера (G0-16) */
export class ReplayMissError extends LlmError {
  constructor(message: string, readonly key: string) { super(message, "replay_miss"); }
}
export class ConfigError extends LlmError {
  constructor(message: string) { super(message, "config"); }
}
export class BudgetExceededError extends LlmError {
  constructor(message: string, readonly used: number, readonly max: number) { super(message, "budget_limited"); }
}
export class ProviderHttpError extends LlmError {
  constructor(message: string, readonly status: number | null, readonly retriable: boolean) { super(message, "provider_http"); }
}
export class ProviderTimeoutError extends LlmError {
  constructor(message: string) { super(message, "provider_timeout"); }
}
/** відповідь не пройшла Zod/семантичні правила навіть після repair-повтору */
export class OutputInvalidError extends LlmError {
  constructor(message: string, readonly issues: string[], readonly raw: unknown) { super(message, "output_invalid"); }
}
export class LlmDisabledError extends LlmError {
  constructor() { super("no LLM provider (llm_mode=none)", "llm_disabled"); }
}
