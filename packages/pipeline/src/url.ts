/** Валідація URL на вході API (перший шар SSRF; другий — egress-проксі в worker). Використовує url-guard S1b без змін. */
import { normalizeTargetUrl } from "@sitelens/browser";
import type { AppConfig } from "./config.js";

export type UrlCheck = { ok: true; url: string; host: string; domain: string; fixture: boolean } | { ok: false; reason: string };

export function validateSubmittedUrl(input: unknown, cfg: Pick<AppConfig, "fixtureMode" | "fixtureOrigins">): UrlCheck {
  if (typeof input !== "string" || input.trim() === "") return { ok: false, reason: "URL порожній" };
  if (input.length > 2048) return { ok: false, reason: "URL довший за 2048 символів" };
  if ([...input].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return { ok: false, reason: "керівні символи в URL" };
  if (cfg.fixtureMode) {
    // fixture-режим (лише тести/локальні фікстури): точний allowlist origin-ів; решта проходить звичайну перевірку
    try {
      const u = new URL(input.trim());
      if ((u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "" && cfg.fixtureOrigins.includes(u.origin)) {
        u.hash = "";
        return { ok: true, url: u.href, host: u.hostname, domain: u.host, fixture: true };
      }
    } catch {
      /* далі — звичайна перевірка дасть відмову */
    }
  }
  const n = normalizeTargetUrl(input);
  if (!n.ok) return { ok: false, reason: n.reason };
  const u = new URL(n.url);
  u.hash = "";
  return { ok: true, url: u.href, host: n.host, domain: u.host.replace(/^www\./, ""), fixture: false };
}
