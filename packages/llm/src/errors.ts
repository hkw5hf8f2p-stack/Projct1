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
/** транспорт `session` (S7 без API): запит записано в requests/, відповіді сесійної моделі ще немає. Не збій і не completed. */
export class SessionAwaitingError extends LlmError {
  constructor(readonly request_id: string, readonly key: string, readonly attempt: number, readonly request_file: string) {
    super(`awaiting_session_model: запит ${request_id} (attempt=${attempt}) чекає відповіді сесійної моделі`, "awaiting_session_model");
  }
}
/** claude-cli: не залогінено / токен недійсний (повтор не допоможе) */
export class ProviderAuthError extends LlmError {
  constructor(message: string) { super(message, "provider_auth"); }
}
