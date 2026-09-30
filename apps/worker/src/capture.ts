/**
 * Захоплення однієї сторінки для worker (D+M) з класифікацією збоїв §48. Дзеркалить `capturePage` із packages/browser/src/audit/run-site.ts
 * (той замикає його всередині auditSite і не дає колбека прогресу — див. хук-запит у browser-api.ts). Зміни відносно S1a:
 * (1) збій D → M не знімається; (2) проксі-рішення й сигнали → classifyCapture; (3) транзієнтні класи повторюються до CAPTURE_ATTEMPTS.
 */
import { mkdirSync } from "node:fs";
import { ClassifiedError, classifyCapture, classifyThrown, isTransient, type CaptureSignals, type Classified } from "@sitelens/pipeline";
import { captureViewport, classifyPageType, detectBotProtection, pageGroupOf, type PageCapture, type VP, type ViewportCapture } from "./browser-api.js";
import type { Runtime } from "./runtime.js";

export const pageIdOf = (u: URL): string => {
  const raw = (u.pathname + u.search).replace(/^\/+|\/+$/g, "");
  return raw === "" ? "index" : raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
};

export interface EgressDenied { host: string; port: number; reason: string }
export type Outcome = { ok: true; capture: PageCapture; egress_denied: EgressDenied[] } | { ok: false; failure: Classified; http_status: number | null; attempts: number; egress_denied: EgressDenied[] };

/** Відмови egress-проксі (шар 1 SSRF) за час захоплення: доказ, що блокування відбулось (а не «нічого не прийшло»). */
function deniedSince(sb: { proxy: { log: Array<{ host: string; port: number; decision: string; reason: string }> } }, from: number): EgressDenied[] {
  return sb.proxy.log.slice(from).filter((d) => d.decision === "deny").slice(0, 50).map((d) => ({ host: d.host, port: d.port, reason: d.reason.slice(0, 160) }));
}

function signalsOf(c: ViewportCapture, proxy: Array<{ host: string; decision: string; reason: string }>, targetHost: string, elapsedMs: number): CaptureSignals {
  const bot = detectBotProtection({ http_status: c.http_status, headers: c.response_headers, title: c.title, visible_text: c.visible_text, markers: c.bot_markers });
  return {
    navigation_completed: c.completeness.navigation_completed,
    http_status: c.http_status,
    content_type: (c.response_headers["content-type"] ?? "").split(";")[0]?.trim() || null,
    document_failures: c.failed_requests.filter((f) => f.resource_type === "document").map((f) => f.failure),
    visible_text_length: c.completeness.visible_text_length,
    visible_links: c.links.filter((l) => l.visible).length,
    js_error_count: c.completeness.js_error_count,
    console_error_count: c.console_errors.length,
    visible_text_sample: c.visible_text.slice(0, 400),
    bot: { blocked: bot.blocked, kind: bot.kind, signals: bot.signals },
    proxy,
    target_host: targetHost,
    elapsed_ms: elapsedMs,
  };
}

type ViewportOut = { ok: true; cap: ViewportCapture; timing: Record<string, number | null>; denied: EgressDenied[] } | { ok: false; failure: Classified; http_status: number | null; denied: EgressDenied[] };

async function oneViewport(rt: Runtime, url: string, pageId: string, vp: VP, runDir: string): Promise<ViewportOut> {
  const sb = await rt.getBrowser();
  const from = sb.proxy.log.length;
  const t0 = Date.now();
  const navFrom = rt.nav.failures.length;
  const crashesFrom = rt.nav.crashes;
  try {
    if (rt.hasFault("page_crash", url)) throw new Error("Page crashed (fault injection: simulated)");
    if (rt.hasFault("browser_crash", url)) throw new Error("Target page, context or browser has been closed (fault injection: simulated)");
    const r = await captureViewport({ secure: sb, url, vp, runDir, pageId, writeShots: true, tiles: process.env["CAPTURE_TILES"] === "1", throttle: rt.gate, userAgent: rt.userAgent });
    const host = new URL(url).hostname;
    const proxy = sb.proxy.log.slice(from).map((d) => ({ host: d.host, decision: d.decision, reason: d.reason }));
    const denied = deniedSince(sb, from);
    const failure = classifyCapture(signalsOf(r.capture, proxy, host, Date.now() - t0));
    if (failure) return { ok: false, failure, http_status: r.capture.http_status, denied };
    return { ok: true, cap: r.capture, timing: r.timing, denied };
  } catch (e) {
    if (e instanceof ClassifiedError) return { ok: false, failure: { errorClass: e.errorClass, detail: e.detail }, http_status: null, denied: [] };
    // captureViewport кинув (напр. «Execution context was destroyed» після невдалої навігації): класифікуємо за тим, що бачили самі
    const connected = sb.browser.isConnected();
    const denied = connected ? deniedSince(sb, from) : [];
    if (rt.nav.crashes > crashesFrom) return { ok: false, failure: { errorClass: "page_crash", detail: "вкладка аварійно завершилась (Playwright: crash)" }, http_status: null, denied };
    if (connected) {
      const failures = rt.nav.failures.slice(navFrom).map((f) => f.failure);
      const host = new URL(url).hostname;
      const proxy = sb.proxy.log.slice(from).map((d) => ({ host: d.host, decision: d.decision, reason: d.reason }));
      if (failures.length > 0 || proxy.some((p) => p.host === host && p.decision !== "allow")) {
        const c = classifyCapture({ navigation_completed: false, http_status: null, content_type: null, document_failures: failures, elapsed_ms: Date.now() - t0, visible_text_length: 0, visible_links: 0, js_error_count: 0, console_error_count: 0, visible_text_sample: "", bot: { blocked: false, kind: null, signals: [] }, proxy, target_host: host });
        if (c) return { ok: false, failure: c, http_status: null, denied };
      }
    }
    return { ok: false, failure: classifyThrown(e, { browserConnected: connected }), http_status: null, denied };
  }
}

export async function capturePageFlow(rt: Runtime, o: { url: string; pageId: string; runDir: string; seedUrl: string }): Promise<Outcome> {
  const u = new URL(o.url);
  mkdirSync(o.runDir, { recursive: true });
  let last: Outcome | null = null;
  for (let attempt = 1; attempt <= rt.cfg.captureAttempts; attempt++) {
    const out = await rt.gate.run(o.url, async (): Promise<Outcome> => {
      const d = await oneViewport(rt, o.url, o.pageId, "D", o.runDir);
      if (!d.ok) return { ok: false, failure: d.failure, http_status: d.http_status, attempts: attempt, egress_denied: d.denied };
      const m = await oneViewport(rt, o.url, o.pageId, "M", o.runDir);
      if (!m.ok) return { ok: false, failure: m.failure, http_status: m.http_status, attempts: attempt, egress_denied: [...d.denied, ...m.denied] };
      const classification = classifyPageType(d.cap, m.cap, { seed_url: o.seedUrl });
      return {
        ok: true,
        egress_denied: [...d.denied, ...m.denied],
        capture: {
          url: o.url, path: u.pathname + u.search, page_id: o.pageId, page_type: classification.page_type, page_type_reason: classification.reason ?? null, classification, page_error: null,
          page_group: pageGroupOf(classification.page_type, u.pathname), D: d.cap, M: m.cap, timing: { D: d.timing, M: m.timing },
        },
      };
    });
    last = out;
    if (out.ok) return out;
    if (!isTransient(out.failure.errorClass)) return out;
    if (out.failure.errorClass === "browser_crash") await rt.resetBrowser();
    await new Promise((r) => setTimeout(r, 500));
  }
  return last!;
}

