/**
 * Типи й хелпери сторінки /settings/ai (BYO AI).
 * TODO(backend): контракт живе в packages/schemas/src/ai-settings.ts (робить sl-backend-engineer). Щойно файл з'явиться —
 * замінити локальні типи на `import type { ... } from "@sitelens/schemas"`. Ключ API не приходить з API ніколи: є лише key_set/key_hint.
 */
import type { AiCheckResponse, AiSettingsInput, AiSettingsView, ProviderKind } from "@sitelens/schemas";

export type { AiCheckResponse as AiCheckResult, AiSettingsInput, AiSettingsView, ProviderKind };
/** Дзеркало MAX_AUDIT_TOKENS_MIN/MAX контракту: Turbopack не резолвить runtime-імпорти `.js→.ts` з @sitelens/schemas, тож у клієнті лише `import type`; рівність із контрактом ловить unit-тест. */
export const MAX_AUDIT_TOKENS_MIN = 10_000;
export const MAX_AUDIT_TOKENS_MAX = 5_000_000;
/** порядок карток у UI; набір звіряється з контрактом тестом */
export const PROVIDER_KINDS = ["anthropic", "openai", "openai_compatible", "claude_cli", "none"] as const satisfies readonly ProviderKind[];

/** Коди помилок перевірки, для яких є переклад. Інші → «unknown» (сирий код показується лише як технічна довідка). */
export const CHECK_ERROR_CLASSES = [
  "auth", "forbidden", "rate_limited", "quota", "model_not_found", "bad_request", "network", "dns", "timeout", "tls",
  "ssrf_blocked", "not_configured", "no_key", "cli_not_installed", "cli_not_logged_in", "provider_error", "unknown",
] as const;

export const KIND_NEEDS_KEY: Record<ProviderKind, boolean> = { anthropic: true, openai: true, openai_compatible: true, claude_cli: false, none: false };
export const KIND_NEEDS_MODEL: Record<ProviderKind, boolean> = { anthropic: true, openai: true, openai_compatible: true, claude_cli: false, none: false };
/** приклади-плейсхолдери (не значення за замовчуванням; поле лишається порожнім, доки користувач не введе) */
export const MODEL_PLACEHOLDER: Record<ProviderKind, string> = {
  anthropic: "claude-sonnet-4-5", openai: "gpt-4.1", openai_compatible: "llama3.1:8b", claude_cli: "sonnet", none: "",
};

export function parseTokens(s: string): number | null {
  const v = s.trim();
  if (!/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= MAX_AUDIT_TOKENS_MIN && n <= MAX_AUDIT_TOKENS_MAX ? n : null;
}
export function validBaseUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}
