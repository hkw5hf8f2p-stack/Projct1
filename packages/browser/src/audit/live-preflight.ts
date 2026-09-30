/**
 * Передпольотна перевірка `pnpm run audit:live -- <url>` (DEV-18, G0-13, G0-14): до будь-якої мережі й до запуску браузера.
 * Порядок: статична перевірка URL (SSRF-літерали, userinfo) → SITE_DENYLIST (сайт §66 тощо) → добовий ліміт (≤ 5 аудитів на сайт).
 * Відмова на будь-якому кроці НЕ збільшує лічильник добового ліміту наступних кроків (ліміт — останній, він і записує).
 */
import path from "node:path";
import { DailyAuditLimiter } from "./ethics.js";
import { assertSiteAllowed, type SiteDenylist } from "../net/site-denylist.js";
import { normalizeTargetUrl } from "../net/url-guard.js";

export type Preflight = { ok: true; url: string; host: string; daily: { count: number; limit: number; day: string } } | { ok: false; step: "url" | "denylist" | "daily_limit"; reason: string };

export function liveOutDir(root: string, host: string): string {
  return path.join(root, "planning/qa/artifacts/sprint-1b/live", host.replace(/[^a-z0-9.-]/gi, "_"));
}

export function preflightLive(input: string, o: { denylist: SiteDenylist; limiter: DailyAuditLimiter }): Preflight {
  const n = normalizeTargetUrl(input);
  if (!n.ok) return { ok: false, step: "url", reason: n.reason };
  try {
    assertSiteAllowed(n.url, o.denylist);
  } catch (e) {
    return { ok: false, step: "denylist", reason: (e as Error).message };
  }
  const v = o.limiter.tryRecord(n.host);
  if (!v.allowed) return { ok: false, step: "daily_limit", reason: `ліміт ${v.limit} аудитів на сайт за добу вичерпано (${v.count}/${v.limit}, ${v.day} UTC)` };
  return { ok: true, url: n.url, host: n.host, daily: { count: v.count, limit: v.limit, day: v.day } };
}
