/**
 * Захоплення §10 для однієї сторінки на одному viewport: скриншоти viewport + full-page, видимий текст, title/meta,
 * headings, links, buttons, form controls, alt, accessibility snapshot, console errors, failed requests, HTTP status,
 * redirect chain, load metrics, axe; поля повноти G0-10 (DEV-19). Браузер приймається ззовні (запуск — secure-launch).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Request } from "playwright";
import { handleBanner } from "./banner.js";
import { assertSecureBrowser, type SecureBrowser } from "../secure-launch.js";
import { PATTERN_SOURCES } from "./patterns.js";
import { PRICE_PARSER_SOURCE } from "./price-parser.js";
import { tileFullPage } from "./tiles.js";
import {
  vpDir,
  VIEWPORT_SPECS,
  type AxeViolation,
  type Completeness,
  type Landmark,
  type ExtractResult,
  type NetworkRow,
  type ScreenshotRef,
  type ViewportCapture,
  type ViewportSpec,
  type VP,
} from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const script = (name: string) => readFileSync(path.join(HERE, "page-scripts", name), "utf8");
const EXTRACT = script("extract.js").trim().replace(/;$/, "");
const SIGNATURE = script("signature.js");
const FX_MARKERS = script("fx-markers.js");

export interface CaptureOptions {
  /** захищений браузер (sl-security): проксі, шар 2 (блок не-GET/WS з логом), SW block; блок робить він, ми лише рахуємо */
  secure: SecureBrowser;
  url: string;
  vp: VP;
  /** корінь прогону; файли пишуться в <runDir>/pages/<pageId>/<WxH>/ */
  runDir: string;
  pageId: string;
  /** false → PNG/тайли не пишуться (мутанти, повтори стабільності); розміри вимірюються так само */
  writeShots: boolean;
  tiles: boolean;
  collectFxMarkers?: boolean;
  /** ≥ 1500 мс на живих сайтах (DEV-18); 0 для локальної фікстури */
  throttle?: { wait: () => Promise<void> };
}

const png = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const settle = (page: Page) => page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);

async function scrollThrough(page: Page, vh: number): Promise<boolean> {
  let y = 0;
  for (let i = 0; i < 40; i++) {
    y += Math.round(0.8 * vh);
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await settle(page);
    await page.waitForTimeout(40);
    const h = (await page.evaluate(`Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`)) as number;
    if (y + vh >= h) {
      await page.waitForTimeout(60);
      const h2 = (await page.evaluate(`Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`)) as number;
      if (h2 === h) return true;
    }
  }
  return false;
}

const sameSig = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 1);

export async function captureViewport(o: CaptureOptions): Promise<{ capture: ViewportCapture; timing: Record<string, number | null> }> {
  assertSecureBrowser(o.secure, "captureViewport");
  const spec: ViewportSpec = VIEWPORT_SPECS[o.vp];
  const dirRel = `pages/${o.pageId}/${vpDir(spec)}`;
  const dirAbs = path.join(o.runDir, dirRel);
  await mkdir(dirAbs, { recursive: true });

  const blockedFrom = o.secure.blocked.length;
  const context = await o.secure.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.dpr,
    isMobile: spec.isMobile,
    hasTouch: spec.isMobile,
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  const rows = new Map<Request, NetworkRow>();
  const bodyJobs: Promise<void>[] = [];
  const consoleErrors: Array<{ text: string; location: string }> = [];
  const failed: Array<{ url: string; resource_type: string; failure: string }> = [];
  let jsErrors = 0;

  // watchdog: зависла операція сторінки не має блокувати аудит (SPEC §48 ізоляція збоїв) — закриваємо контекст, виклик кине
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void context.close().catch(() => undefined);
  }, 60_000);
  try {
    const page = await context.newPage();
    page.on("pageerror", () => {
      jsErrors++;
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push({ text: m.text().slice(0, 300), location: m.location().url });
    });
    page.on("request", (r) => {
      rows.set(r, { method: r.method(), url: r.url(), resource_type: r.resourceType(), status: null, content_type: null, body_bytes: null, blocked: false, failure: null });
    });
    page.on("response", (resp) => {
      const row = rows.get(resp.request());
      if (!row) return;
      row.status = resp.status();
      row.content_type = (resp.headers()["content-type"] ?? "").split(";")[0]?.trim() || null;
      if (row.content_type?.startsWith("image/") && resp.status() === 200) {
        bodyJobs.push(
          resp
            .body()
            .then((b) => {
              row.body_bytes = b.length;
            })
            .catch(() => {
              row.body_bytes = null;
            }),
        );
      }
    });
    page.on("requestfailed", (r) => {
      const row = rows.get(r);
      const failure = r.failure()?.errorText ?? "unknown";
      if (row) row.failure = failure;
      if (failure !== "net::ERR_BLOCKED_BY_CLIENT") failed.push({ url: r.url(), resource_type: r.resourceType(), failure });
    });

    await o.throttle?.wait();
    let navigationCompleted = true;
    let status: number | null = null;
    const chain: Array<{ url: string; status: number | null }> = [];
    let finalUrl = o.url;
    try {
      const resp = await page.goto(o.url, { waitUntil: "load", timeout: 30_000 });
      status = resp?.status() ?? null;
      finalUrl = page.url();
      let req: Request | null = resp?.request() ?? null;
      const hops: Request[] = [];
      while (req?.redirectedFrom()) {
        req = req.redirectedFrom();
        if (req) hops.unshift(req);
      }
      for (const h of hops) chain.push({ url: h.url(), status: (await h.response())?.status() ?? null });
      chain.push({ url: finalUrl, status });
    } catch {
      navigationCompleted = false;
    }

    await page.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    const banner = await handleBanner(page);
    const scrollCompleted = await scrollThrough(page, spec.height);
    await page.evaluate(`window.scrollTo(0, 0)`);
    await settle(page);
    const sig1 = (await page.evaluate(SIGNATURE)) as number[];
    await settle(page);
    const sig2 = (await page.evaluate(SIGNATURE)) as number[];
    const layoutStable = sameSig(sig1, sig2);

    // ---- скриншоти
    const refs: { viewport: ScreenshotRef; fullpage: ScreenshotRef } = {
      viewport: { file: `${dirRel}/viewport.png`, width_px: 0, height_px: 0, written: false },
      fullpage: { file: `${dirRel}/fullpage.png`, width_px: 0, height_px: 0, written: false },
    };
    const vBuf = await page.screenshot({ animations: "disabled", caret: "hide" });
    const fBuf = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
    refs.viewport = { ...refs.viewport, width_px: png(vBuf).w, height_px: png(vBuf).h, written: o.writeShots };
    refs.fullpage = { ...refs.fullpage, width_px: png(fBuf).w, height_px: png(fBuf).h, written: o.writeShots };
    if (o.writeShots) {
      await writeFile(path.join(dirAbs, "viewport.png"), vBuf);
      await writeFile(path.join(dirAbs, "fullpage.png"), fBuf);
    }

    // ---- axe (повний дефолтний набір правил, лише violations)
    let axe: ViewportCapture["axe"] = { version: "", violations: [] };
    try {
      const r = await new AxeBuilder({ page }).analyze();
      const violations: AxeViolation[] = [];
      for (const v of r.violations) {
        const nodes = [];
        for (const n of v.nodes) {
          const target = n.target.map(String).join(" ");
          const info = (await page.evaluate(
            `((sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); const main = document.querySelector('main, [role=main]'); const ex = el.closest('header, nav, footer, aside, [role=banner], [role=navigation], [role=contentinfo]'); let lm = 'main'; if (ex && !(main && main.contains(ex))) { const t = ex.tagName.toLowerCase(); const ro = (ex.getAttribute('role') || '').toLowerCase(); lm = t === 'nav' || ro === 'navigation' ? 'nav' : t === 'header' || ro === 'banner' ? 'header' : t === 'footer' || ro === 'contentinfo' ? 'footer' : 'aside'; } else if (main) lm = main.contains(el) ? 'main' : 'other'; return { rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }, landmark: lm, tag: el.tagName.toLowerCase() }; })(${JSON.stringify(target)})`,
          ).catch(() => null)) as { rect: { x: number; y: number; w: number; h: number }; landmark: Landmark; tag: string } | null;
          const rect = info?.rect ?? null;
          nodes.push({ target, html: n.html.slice(0, 300), failureSummary: (n.failureSummary ?? "").slice(0, 300), rect, landmark: info?.landmark ?? null, tag: info?.tag ?? null });
        }
        violations.push({ id: v.id, impact: v.impact ?? null, help: v.help, helpUrl: v.helpUrl, nodes });
      }
      violations.sort((a, b) => a.id.localeCompare(b.id));
      axe = { version: r.testEngine.version, violations };
    } catch (e) {
      axe = { version: "", violations: [], error: String(e).slice(0, 200) };
    }

    // ---- вилучення DOM (після скриншотів/axe прокрутку могло зсунути: FV міряється лише при scrollY = 0)
    await page.evaluate(`window.scrollTo(0, 0)`);
    await settle(page);
    const ex = (await page.evaluate(`(${EXTRACT})(${JSON.stringify({ ...PATTERN_SOURCES, VW: spec.width, VH: spec.height })}, ${PRICE_PARSER_SOURCE})`)) as ExtractResult;
    const fx = o.collectFxMarkers ? ((await page.evaluate(FX_MARKERS)) as Record<string, Array<{ x: number; y: number; w: number; h: number }>>) : undefined;
    const ariaSnapshot = await page.locator("body").ariaSnapshot().catch(() => "");
    const metrics = (await page.evaluate(
      `(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByType('paint'); const res = performance.getEntriesByType('resource'); return { dom_content_loaded_ms: n ? n.domContentLoadedEventEnd : null, load_ms: n ? n.loadEventEnd : null, first_paint_ms: (p.find((e) => e.name === 'first-paint') || {}).startTime ?? null, fcp_ms: (p.find((e) => e.name === 'first-contentful-paint') || {}).startTime ?? null, resource_count: res.length, transfer_bytes: res.reduce((a, e) => a + (e.transferSize || 0), 0) + (n ? n.transferSize : 0) }; })()`,
    ).catch(() => ({}))) as Record<string, number | null>;

    // ---- тайли для LLM (D4)
    const tiles = o.tiles
      ? await tileFullPage(page, { vp: o.vp, spec, runDir: o.runDir, dirRel, viewportRef: refs.viewport.file, fullHeight: ex.overflow.scroll_height, fullWidth: Math.max(spec.width, ex.overflow.scroll_width), write: o.writeShots })
      : null;

    await Promise.all(bodyJobs);
    // блоки шару 2 цього захоплення: записи, додані secureLaunch у спільний лог після початку (сторінки йдуть послідовно)
    const blocked = o.secure.blocked.slice(blockedFrom);
    const blockedRows: NetworkRow[] = blocked.map((b) => ({ method: b.method, url: b.url, resource_type: b.resource_type ?? b.kind, status: null, content_type: null, body_bytes: null, blocked: true, failure: b.reason }));
    const requests: NetworkRow[] = [...rows.values(), ...blockedRows].sort((a, b) => (a.url + a.method).localeCompare(b.url + b.method));
    const failedCritical = failed.filter((f) => {
      try {
        return new URL(f.url).origin === new URL(o.url).origin && ["document", "script", "xhr", "fetch"].includes(f.resource_type);
      } catch {
        return false;
      }
    }).length;

    const reasons: string[] = [];
    if (blocked.length > 0) reasons.push(`blocked_requests:${blocked.length}`);
    if (jsErrors > 0) reasons.push(`js_errors:${jsErrors}`);
    if (banner.state === "open") reasons.push("banner_open");
    if (!scrollCompleted) reasons.push("scroll_incomplete");
    if (!layoutStable) reasons.push("layout_unstable");
    if (!(status !== null && status >= 200 && status < 300)) reasons.push(`http_status:${status}`);
    if (!navigationCompleted) reasons.push("navigation_incomplete");
    if (failedCritical > 0) reasons.push(`failed_critical_requests:${failedCritical}`);
    const completeness: Completeness = {
      blocked_requests_count: blocked.length,
      js_error_count: jsErrors,
      banner_state: banner.state,
      scroll_completed: scrollCompleted,
      layout_stable: layoutStable,
      http_status: status,
      navigation_completed: navigationCompleted,
      failed_critical_requests: failedCritical,
      visible_text_length: ex.visible_text.trim().length,
      capture_complete: reasons.length === 0,
      incomplete_reasons: reasons,
    };

    const files = { capture: `${dirRel}/capture.json`, network: `${dirRel}/network.json`, axe: `${dirRel}/axe.json`, dir: dirRel };
    const capture: ViewportCapture = {
      ...ex,
      vp: o.vp,
      width: spec.width,
      height: spec.height,
      dpr: spec.dpr,
      url: o.url,
      final_url: finalUrl,
      http_status: status,
      redirect_chain: chain,
      aria_snapshot: ariaSnapshot,
      console_errors: consoleErrors,
      failed_requests: failed,
      requests,
      screenshots: refs,
      banner,
      completeness,
      axe,
      tiles,
      fx_markers: fx,
      files,
    };
    // network.json / axe.json — окремі артефакти доказів; capture.json — усе інше (без часових метрик)
    await writeFile(path.join(o.runDir, files.network), JSON.stringify(requests, null, 2) + "\n");
    await writeFile(path.join(o.runDir, files.axe), JSON.stringify(axe, null, 2) + "\n");
    const { requests: _r, axe: _a, signature: _s, ...slim } = capture;
    void _r;
    void _a;
    void _s;
    await writeFile(path.join(o.runDir, files.capture), JSON.stringify(slim, null, 2) + "\n");
    return { capture, timing: metrics };
  } catch (e) {
    if (timedOut) throw new Error(`capture watchdog 60s: ${o.url} ${o.vp}`);
    throw e;
  } finally {
    clearTimeout(watchdog);
    await context.close().catch(() => undefined);
  }
}
