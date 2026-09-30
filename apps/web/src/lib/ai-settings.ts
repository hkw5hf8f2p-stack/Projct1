/**
 * Типи й хелпери сторінки /settings/ai (BYO AI).
 * TODO(backend): контракт живе в packages/schemas/src/ai-settings.ts (робить sl-backend-engineer). Щойно файл з'явиться —
 * замінити локальні типи на `import type { ... } from "@sitelens/schemas"`. Ключ API не приходить з API ніколи: є лише key_set/key_hint.
 */
export const PROVIDER_KINDS = ["anthropic", "openai", "openai_compatible", "claude_cli", "none"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface AiCheckSummary { ok: boolean; error_class?: string | null; checked_at?: string | null; latency_ms?: number | null }
export interface AiSettingsView {
  kind: ProviderKind;
  model: string | null;
  base_url?: string | null;
  key_set: boolean;
  key_hint?: string | null;
  max_audit_tokens: number;
  updated_at: string | null;
  last_check?: AiCheckSummary | null;
}
export interface AiSettingsInput { kind: ProviderKind; model?: string; base_url?: string; api_key?: string; max_audit_tokens?: number }
export interface AiCheckResult { ok: boolean; error_class?: string | null; latency_ms: number; model_reported?: string | null }

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
  return n >= 1 ? n : null;
}
export function validBaseUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
