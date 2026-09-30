import { ProviderHttpError, ProviderTimeoutError } from "../errors.js";
import { redact } from "../redact.js";
import type { FetchLike } from "../types.js";

export interface HttpOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** повторів після першої спроби для 429/5xx/таймауту */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** секрети для редакції повідомлень про помилки */
  secrets: readonly string[];
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HttpResult { status: number; text: string; json: unknown }

/**
 * POST JSON із повторами 429/5xx (Retry-After або експоненційна пауза) і таймаутом.
 * 4xx (крім 429) не повторюється тут — викликач вирішує (напр. 400 на temperature).
 * Тіло помилки провайдера редагується від секретів і обрізається.
 */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, o: HttpOptions): Promise<HttpResult> {
  const f = o.fetchImpl ?? defaultFetch;
  const sleep = o.sleep ?? defaultSleep;
  const max = o.maxRetries ?? 2;
  const payload = JSON.stringify(body);
  let last: Error | null = null;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload, signal: AbortSignal.timeout(o.timeoutMs ?? 120_000) });
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* тіло не JSON: викликач вирішує */ }
        return { status: res.status, text, json };
      }
      const retriable = res.status === 429 || res.status >= 500;
      const err = new ProviderHttpError(`provider HTTP ${res.status}: ${redact(text, o.secrets).slice(0, 300)}`, res.status, retriable);
      if (!retriable) throw Object.assign(err, { body: redact(text, o.secrets) });
      last = err;
      if (attempt < max) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : Math.min(500 * 2 ** attempt, 8000));
      }
    } catch (e) {
      if (e instanceof ProviderHttpError) { if (!e.retriable) throw e; last = e; continue; }
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        last = new ProviderTimeoutError(`provider timeout after ${o.timeoutMs ?? 120_000} ms`);
        if (attempt < max) await sleep(Math.min(500 * 2 ** attempt, 8000));
        continue;
      }
      throw new ProviderHttpError(`network error: ${redact(String((e as Error)?.message ?? e), o.secrets)}`, null, false);
    }
  }
  throw last ?? new ProviderHttpError("provider request failed", null, false);
}

/** 400, у тексті якого згадано temperature/top_p — сигнал повторити без семплінгу (G0-27) */
export function isSamplingRejection(e: unknown): boolean {
  if (!(e instanceof ProviderHttpError) || e.status !== 400) return false;
  const body = String((e as { body?: string }).body ?? e.message);
  return /temperature|top_p|top_k/i.test(body);
}
