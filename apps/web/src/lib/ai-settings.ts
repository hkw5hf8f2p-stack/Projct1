/**
 * Типи й хелпери сторінки /settings/ai (BYO AI).
 * TODO(backend): контракт живе в packages/schemas/src/ai-settings.ts (робить sl-backend-engineer). Щойно файл з'явиться —
 * замінити локальні типи на `import type { ... } from "@sitelens/schemas"`. Ключ API не приходить з API ніколи: є лише key_set/key_hint.
 */
import type { AiCheckErrorClass, AiCheckResponse, AiSettingsInput, AiSettingsView, ProviderKind } from "@sitelens/schemas";

export type { AiCheckResponse as AiCheckResult, AiSettingsInput, AiSettingsView, ProviderKind };
/** Дзеркало MAX_AUDIT_TOKENS_MIN/MAX контракту: Turbopack не резолвить runtime-імпорти `.js→.ts` з @sitelens/schemas, тож у клієнті лише `import type`; рівність із контрактом ловить unit-тест. */
export const MAX_AUDIT_TOKENS_MIN = 10_000;
export const MAX_AUDIT_TOKENS_MAX = 5_000_000;
/** порядок карток у UI; набір звіряється з контрактом тестом */
export const PROVIDER_KINDS = ["anthropic", "openai", "openai_compatible", "claude_cli", "none"] as const satisfies readonly ProviderKind[];

/** Дзеркало AI_CHECK_ERROR_CLASSES контракту (Turbopack не резолвить runtime-імпорти з @sitelens/schemas); рівність із контрактом ловить unit-тест. Інші коди → «unknown». */
export const CHECK_ERROR_CLASSES = [
  "no_provider", "no_key", "auth_failed", "not_logged_in", "rate_limited", "model_not_found", "provider_unavailable", "provider_not_available",
  "timeout", "invalid_response", "network_blocked", "bad_base_url", "unknown",
] as const satisfies readonly AiCheckErrorClass[];

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
