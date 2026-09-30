/** Мапінг помилок провайдера на закритий перелік AI_CHECK_ERROR_CLASSES (DEV-86). Повертає лише код: текст помилки може містити секрети. */
import type { AiCheckErrorClass, ProviderKind } from "@sitelens/schemas";
import { ConfigError, OutputInvalidError, ProviderAuthError, ProviderHttpError, ProviderTimeoutError } from "@sitelens/llm";

/** мережеві збої (fetch без HTTP-статусу): текст undici/Node; точна причина в `fetch failed` прихована → частина ознак unverified */
const BAD_HOST = /ENOTFOUND|EAI_AGAIN|Invalid URL|ERR_INVALID_URL|getaddrinfo/i;
const BLOCKED = /EACCES|EPERM|proxy|blocked|forbidden by|CERT_|certificate|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ECONNRESET/i;

export function classifyAiError(e: unknown, kind?: ProviderKind): AiCheckErrorClass {
  if (e instanceof ProviderAuthError) return "not_logged_in";
  if (e instanceof ProviderTimeoutError) return "timeout";
  if (e instanceof ConfigError) return "provider_not_available";
  if (e instanceof OutputInvalidError) return "invalid_response";
  if (e instanceof ProviderHttpError) {
    const s = e.status;
    if (s === null) {
      const m = e.message;
      if (BAD_HOST.test(m)) return kind === "openai_compatible" ? "bad_base_url" : "network_blocked";
      if (BLOCKED.test(m)) return "network_blocked";
      return "provider_unavailable";
    }
    if (s === 401 || s === 403) return "auth_failed";
    if (s === 404) return kind === "openai_compatible" ? "bad_base_url" : "model_not_found";
    if (s === 429) return "rate_limited";
    if (s === 400 || s === 422) return /model/i.test(e.message) ? "model_not_found" : "unknown";
    if (s >= 500) return "provider_unavailable";
    if (s >= 200 && s < 300 && /unexpected response shape/.test(e.message)) return "invalid_response";
    return "unknown";
  }
  const code = (e as { code?: string } | null)?.code;
  if (code === "output_invalid") return "invalid_response";
  if (code === "provider_timeout") return "timeout";
  return "unknown";
}
