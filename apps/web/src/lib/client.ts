/**
 * Тонкий клієнт API з адаптером (SPEC §8 статуси, §48 помилки).
 *  - api:     GET /api/audits/:id, /report — через rewrites на Fastify (127.0.0.1:3001)
 *  - fixture: /api/dev/* — локальні JSON-фікстури; вмикається ЯВНО `SITELENS_SOURCE=fixture` (лише dev)
 * Токен ACCESS_TOKEN (якщо API його вимагає) — у sessionStorage цієї вкладки, ніколи в localStorage/URL/логах.
 */
import type { AuditStatus, Report } from "./types";

export const SOURCE: "api" | "fixture" = process.env["NEXT_PUBLIC_SITELENS_SOURCE"] === "fixture" ? "fixture" : "api";
const BASE = SOURCE === "fixture" ? "/api/dev" : "/api";

const TOKEN_KEY = "sl_access_token";
export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null): void {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sessionStorage недоступний — токен живе лише до перезавантаження, це ок */
  }
}

export interface ApiFailure { ok: false; http: number; cls: string; message: string }
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const headers = new Headers(init?.headers);
  const tok = getToken();
  if (tok) headers.set("Authorization", `Bearer ${tok}`);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    return { ok: false, http: 0, cls: "network", message: "network" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* не JSON */
  }
  if (res.ok) return body === null ? { ok: false, http: res.status, cls: "internal", message: "empty body" } : { ok: true, data: body as T };
  const e = (body as { error?: { class?: string; message?: string } } | null)?.error;
  return { ok: false, http: res.status, cls: e?.class ?? (res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "internal"), message: e?.message ?? `HTTP ${res.status}` };
}

export const createAudit = (url: string, language: "uk" | "en") =>
  call<{ auditId: string }>("/audits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, language }) });
export const getStatus = (id: string) => call<AuditStatus>(`/audits/${encodeURIComponent(id)}`);
export const getReport = (id: string) => call<Report>(`/audits/${encodeURIComponent(id)}/report`);

/**
 * URL артефакту доказу (скриншот). Реальний API віддає `GET /api/audits/:id/artifacts/<path>` (DEV-71; перевірено e2e через SITELENS_SOURCE=api —
 * apps/worker/test/web-api.e2e.test.ts); у fixture-режимі його віддає dev-роут. При заданому ACCESS_TOKEN `<img>` не шле Authorization — unverified. Змінюється в одному місці — тут.
 */
export function artifactUrl(auditId: string, ref: string): string {
  return `${BASE}/audits/${encodeURIComponent(auditId)}/artifacts/${ref.split("/").map(encodeURIComponent).join("/")}`;
}
