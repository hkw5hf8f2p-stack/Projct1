/** BYO AI (налаштування інсталяції, без облікових записів): контракт API /api/settings/ai. Ключ у View НІКОЛИ не повертається. */
import { z } from "zod";

export const ProviderKind = z.enum(["none", "anthropic", "openai", "openai_compatible", "claude_cli"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const MAX_AUDIT_TOKENS_MIN = 10_000;
export const MAX_AUDIT_TOKENS_MAX = 5_000_000;

/**
 * base_url лише для openai_compatible: http(s), без userinfo. Локальні адреси (http://127.0.0.1:11434) дозволені саме тут — це явний вибір
 * власника інсталяції, а не ціль аудиту (SSRF-фільтр цілей аудиту цього не стосується).
 */
export const AiBaseUrl = z.string().trim().min(1).max(2048).superRefine((v, ctx) => {
  let u: URL;
  try { u = new URL(v); } catch { ctx.addIssue({ code: "custom", message: "base_url: некоректний URL" }); return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") ctx.addIssue({ code: "custom", message: "base_url: лише http(s)" });
  if (u.username !== "" || u.password !== "" || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(v)) ctx.addIssue({ code: "custom", message: "base_url: userinfo (user:pass@) заборонено" });
  if (u.search !== "" || u.hash !== "") ctx.addIssue({ code: "custom", message: "base_url: без query/fragment" });
});

export const AiSettingsInput = z.object({
  kind: ProviderKind,
  model: z.string().trim().min(1).max(200).optional(),
  base_url: AiBaseUrl.optional(),
  api_key: z.string().min(1).max(4096).optional(),
  max_audit_tokens: z.number().int().min(MAX_AUDIT_TOKENS_MIN).max(MAX_AUDIT_TOKENS_MAX).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.base_url !== undefined && v.kind !== "openai_compatible") ctx.addIssue({ code: "custom", path: ["base_url"], message: "base_url лише для openai_compatible" });
  if (v.kind === "openai_compatible" && v.base_url === undefined) ctx.addIssue({ code: "custom", path: ["base_url"], message: "base_url обов'язковий для openai_compatible" });
  if (v.api_key !== undefined && (v.kind === "none" || v.kind === "claude_cli")) ctx.addIssue({ code: "custom", path: ["api_key"], message: `${v.kind}: без ключа` });
});
export type AiSettingsInput = z.infer<typeof AiSettingsInput>;

/**
 * Закритий перелік error_class для POST /api/settings/ai/check (DEV-84). Без тексту помилки провайдера (він може містити секрети).
 * Мапінг помилок провайдерів на нього — apps/api/src/ai-errors.ts; дзеркало в UI (apps/web/src/lib/ai-settings.ts) звіряється unit-тестом.
 */
export const AI_CHECK_ERROR_CLASSES = [
  "no_provider", "no_key", "auth_failed", "not_logged_in", "rate_limited", "model_not_found", "provider_unavailable", "provider_not_available",
  "timeout", "invalid_response", "network_blocked", "bad_base_url", "unknown",
] as const;
export const AiCheckErrorClass = z.enum(AI_CHECK_ERROR_CLASSES);
export type AiCheckErrorClass = z.infer<typeof AiCheckErrorClass>;

export const AiCheckResult = z.object({
  ok: z.boolean(),
  at: z.string(),
  error_class: AiCheckErrorClass.optional(),
  model_reported: z.string().optional(),
});

export const AiSettingsView = z.object({
  kind: ProviderKind,
  model: z.string(),
  base_url: z.string().optional(),
  key_set: z.boolean(),
  /** «…abcd» — останні 4 символи; лише для ключа, збереженого через UI */
  key_hint: z.string().optional(),
  max_audit_tokens: z.number().int(),
  /** null — налаштувань через UI ще не збережено */
  updated_at: z.string().nullable(),
  last_check: AiCheckResult.optional(),
  /** звідки чинна конфігурація: ui (збережено тут) > env (.env) > none */
  source: z.enum(["ui", "env", "none"]),
});
export type AiSettingsView = z.infer<typeof AiSettingsView>;

export const AiCheckResponse = z.object({
  ok: z.boolean(),
  error_class: AiCheckErrorClass.optional(),
  latency_ms: z.number(),
  model_reported: z.string().optional(),
});
export type AiCheckResponse = z.infer<typeof AiCheckResponse>;
