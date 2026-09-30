import { NextResponse } from "next/server";
import { apiError, guardFixture } from "@/dev/http";
import { startLive } from "@/dev/fixtures";

export const dynamic = "force-dynamic";

/** dev: імітація POST /api/audits. Ключові слова в URL обирають фікстуру (див. planning/engineering/web-dev-fixtures.md). */
export async function POST(req: Request) {
  const g = guardFixture();
  if (g) return g;
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) return apiError(400, "bad_request", 'Очікується JSON {"url": "https://…"}');
  const host = (() => {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!host || /^(localhost|.*\.internal|.*\.local)$/.test(host) || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cde])/.test(host))
    return apiError(400, "invalid_url", "Адреса веде у внутрішню мережу й заблокована (SSRF)");
  const pick = (k: string) => url.toLowerCase().includes(k);
  if (pick("ratelimit")) return apiError(429, "rate_limited", "Перевищено ліміт аудитів на годину");
  const id = pick("nollm") ? "fx_nollm" : pick("clean") ? "fx_clean" : pick("queued") ? "fx_queued" : pick("failed") ? "fx_failed_timeout" : pick("bot") ? "fx_failed_bot_protection" : pick("slow") ? "fx_slow" : pick("static") ? "fx_completed" : "fx_live";
  if (id === "fx_live") startLive(id);
  return NextResponse.json({ auditId: id }, { status: 202, headers: { Location: `/api/audits/${id}` } });
}
