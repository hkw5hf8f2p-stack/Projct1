/**
 * Виконавець браузерних журналів (SPEC §19B, §20–§23, §11; G0-11, G0-12): цикл кроків агента над Playwright.
 *
 * Хто вирішує що: агент (`AgentDriver`: живий LLM, replay або scripted fake) лише ПРОПОНУЄ дію; виконує й забороняє КОД:
 *   - дії — лише click/scroll/back/navigate_internal_link/stop_*, цілі — семантичні локатори (getByRole/getByText, без координат);
 *   - елемент перед кліком читається з DOM і проходить `checkElement` (deny-list URL/тексту, same-origin, submit, download);
 *   - комерційний CTA («В кошик») — «знайдено й доступно», НЕ натиснуто; успіх «кошик» рахує код (див. `cartVerdict`);
 *   - мережа: context.route блокує GET на deny-list і головну навігацію поза origin; не-GET/HEAD блокує secureLaunch (шар 2);
 *   - популярні прийоми: `window.open` → null (WINDOW_OPEN_LOCK_SCRIPT), `target=_blank` → та сама вкладка, dialog → dismiss.
 * Кожна дія й кожен блок пишуться в `journey.json` (§20 «every action must be logged»); Evidence §23 — `buildJourneyEvidence`.
 * Без живого LLM: `driver` у тестах — scripted; це доводить плумбінг і фільтр, не якість моделі (⏭️ live pass).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page, Request } from "playwright";
import { assertSecureBrowser, type SecureBrowser } from "../secure-launch.js";
import { WINDOW_OPEN_LOCK_SCRIPT } from "../audit/capture-page.js";
import { handleBanner } from "../audit/banner.js";
import { CTA_SRC, PRICE_EXCL_SRC, PRICE_SRC, SHIP_RE } from "../audit/patterns.js";
import { VIEWPORT_SPECS, type BannerRecord, type VP } from "../audit/types.js";
import { checkAction, checkElement, denyUrl, sameOrigin, type ElementFacts, type SemanticTarget } from "./action-filter.js";

// ---------------------------------------------------------------------------------------------------------------- типи
export interface AgentStepDecision {
  action: string;
  target: string;
  reason_summary: string;
  task_progress: string;
  friction_detected: string[];
  confidence?: number;
}
export interface AgentFriction { category: string; claim_kind?: string; severity: "low" | "medium" | "high"; evidence: string; page_url: string }
export interface AgentResult { success: "true" | "false" | "partial"; frictions: AgentFriction[]; positive_signals: string[]; uncertainties: string[]; final_summary: string }
export interface AgentDecision { step: AgentStepDecision; result: AgentResult | null }

export interface AgentObservation {
  step: number;
  remaining: number;
  url: string;
  title: string;
  a11y_outline: string;
  visible_text: string;
  link_texts: string[];
  history: ReadonlyArray<{ action: string; target: string; reason_summary: string }>;
  /** перше вікно (D4), абсолютний шлях; null, якщо writeShots=false */
  screenshot_path: string | null;
}
/** Агент: живий LLM (`agentTurn`), replay або scripted fake. Кидає виняток → сесія `failed` (§48), аудит не падає. */
export type AgentDriver = (obs: AgentObservation) => Promise<AgentDecision>;

export interface JourneyTask { id: string; name: string; goal: string; task_type: string; max_actions?: number }

export interface JourneyOptions {
  secure: SecureBrowser;
  startUrl: string;
  /** корінь прогону; артефакти — у <runDir>/journeys/<session_id>/ */
  runDir: string;
  audit_run_id: string;
  lens_id: string;
  task: JourneyTask;
  driver: AgentDriver;
  /** за замовчуванням task.max_actions ?? 8; жорстка стеля 16 */
  maxSteps?: number;
  vp?: VP;
  writeShots?: boolean;
  /** HostGate (DEV-18): пауза ≥ 1500 мс на живих сайтах; у prod-режимі проксі обов'язковий разом із userAgent */
  throttle?: { wait: (url: string) => Promise<void> };
  userAgent?: string;
  /** ЛИШЕ контрольний тест: вимикає кодовий фільтр (deny-list/same-origin/текст) і мережеві правила — щоб показати, що GET /logout інакше доходить. Не-GET усе одно блокує secureLaunch. */
  __controlNoFilter?: boolean;
}

export const MAX_JOURNEY_STEPS = 16;
const MAX_INVALID_IN_ROW = 3;

export type StepVerdict = "executed" | "blocked" | "found_not_clicked" | "not_found" | "not_actionable" | "noop" | "stop" | "invalid";
export interface StepLog {
  n: number;
  url_before: string;
  url_after: string;
  decision: AgentStepDecision;
  verdict: StepVerdict;
  rule: string | null;
  detail: string | null;
  located: { role: string; name: string; count: number; picked_visible: boolean } | null;
  element: { tag: string; text: string; href: string | null } | null;
  screenshot: string | null;
}
export interface NetBlock { ts: string; kind: "deny_url" | "cross_origin_navigation" | "popup" | "download"; url: string; rule: string | null }

export interface CartVerdict {
  /** кнопка/посилання з комерційним дієсловом CTA знайдено на якійсь із відвіданих сторінок */
  button_found: boolean;
  /** видима, не disabled, не перекрита (hit-test у центрі) */
  reachable: boolean;
  button_text: string | null;
  page_url: string | null;
  /** ціна/доставка відомі на цей крок або раніше (SPEC §19B «до неї») */
  price_known_before: boolean;
  shipping_known_before: boolean;
  success: "true" | "false" | "partial";
}

export interface SessionOut {
  session_id: string;
  audit_run_id: string;
  lens_id: string;
  task_id: string;
  level: "journey";
  status: "done" | "failed";
  success: "true" | "false" | "partial";
  actions_used: number;
  frictions: Array<{ category: string; severity: "low" | "medium" | "high"; evidence: string; page_url: string }>;
  positive_signals: string[];
  uncertainties: string[];
  final_summary: string;
  steps: AgentStepDecision[];
}

export type EndReason = "stop_success" | "stop_failure" | "step_limit" | "driver_error" | "navigation_failed" | "invalid_decisions";

export interface JourneyEvidence {
  id: string;
  type: "browser_session";
  source_class: "OBSERVED" | "SYNTHETIC";
  page_url: string;
  page_path: string;
  description: string;
  artifact_reference: string;
  selector_or_region: { selector: string };
  self_confirming: false;
  category?: string;
  claim_kind?: string;
  excerpt?: string;
  detector_id?: string;
  assertion?: "presence" | "absence";
  viewport?: VP;
  measurement?: Record<string, unknown>;
  capture_complete?: boolean;
  incomplete_reasons?: string[];
  capture_context?: {
    banner_state: "none" | "closed" | "open";
    banner_actions: BannerRecord["actions"];
    blocked_requests_count: number;
    js_error_count: number;
    scroll_completed: boolean;
    layout_stable: boolean;
    http_status: number | null;
  };
  session_id: string;
  lens_id: string;
  task_id: string;
  level: "journey";
  browser_failure?: { kind: "not_actionable" | "obscured" | "http_error" | "nav_timeout" | "blocked_overlay"; selector?: string; reproduced_by_replay: boolean };
}

export interface JourneyResult {
  session: SessionOut;
  evidence: JourneyEvidence[];
  steps: StepLog[];
  cart: CartVerdict;
  end_reason: EndReason;
  /** блоки кодового фільтра/мережі (GET deny-list, cross-origin, popup, download) */
  net_blocks: NetBlock[];
  /** не-GET/HEAD, заблоковані шаром 2 secureLaunch за час журналу */
  method_blocks: number;
  /** friction, відкинуті кодом (цитата не знайдена в побаченому тексті) */
  rejected_frictions: Array<{ friction: AgentFriction; reason: string }>;
  dir: string;
  files: { journey: string; session: string; evidence: string };
}

// ---------------------------------------------------------------------------------------------------------------- допоміжне
const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Скан сторінки: комерційні CTA (add-to-cart/buy; «checkout/оформити» не рахуємо), reachability = visible ∧ enabled ∧ hit-test у центрі. */
const CART_SCAN = `((ctaSrc) => {
  const re = new RegExp(ctaSrc, "iu"), skip = /checkout|оформ/i;
  const cands = Array.from(document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button]'));
  const out = [];
  for (const el of cands) {
    const text = (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    if (!text || skip.test(text) || !re.test(text)) continue;
    let visible = false;
    try { visible = el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); } catch (e) { visible = true; }
    const r0 = el.getBoundingClientRect();
    if (r0.width * r0.height < 1) visible = false;
    const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
    let hit = false;
    if (visible) {
      const sy = window.scrollY, sx = window.scrollX;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
      hit = !!top && (top === el || el.contains(top) || top.contains(el));
      window.scrollTo(sx, sy);
    }
    out.push({ text: text.slice(0, 80), tag: el.tagName.toLowerCase(), visible, disabled, hit });
  }
  return out;
})`;
interface CartCandidate { text: string; tag: string; visible: boolean; disabled: boolean; hit: boolean }

const FACTS = `((n) => {
  const a = n.closest('a[href]');
  const form = n.form || n.closest('form');
  const t = n.tagName, type = (n.getAttribute('type') || '').toLowerCase();
  const isSubmitEl = (t === 'BUTTON' && (type === '' || type === 'submit')) || (t === 'INPUT' && (type === 'submit' || type === 'image'));
  const method = ((n.getAttribute('formmethod') || (form ? form.method : '') || 'get') + '').toLowerCase();
  return {
    tag: t.toLowerCase(),
    text: ((n.getAttribute('aria-label') || n.innerText || n.value || n.getAttribute('alt') || n.getAttribute('title') || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    href: a ? a.href : null,
    submits_form: !!form && isSubmitEl && method !== 'get',
    has_download_attr: !!(a && a.hasAttribute('download')),
    blank: !!(a && a.target === '_blank'),
    visible: (() => { try { return n.checkVisibility({ opacityProperty: true, visibilityProperty: true }); } catch (e) { return true; } })() && n.getBoundingClientRect().width * n.getBoundingClientRect().height >= 1,
    disabled: !!n.disabled || n.getAttribute('aria-disabled') === 'true',
  };
})`;
interface RawFacts extends ElementFacts { blank: boolean; visible: boolean; disabled: boolean }

const PRICE_G = new RegExp(PRICE_SRC, "giu");
const PRICE_EXCL = new RegExp(PRICE_EXCL_SRC, "iu");
/**
 * Ціна ТОВАРУ відома: є цінове значення, перед яким (25 знаків) немає «від/from/економія/знижка/save» і біля якого (±40) немає слів про доставку
 * («від 70 грн» на сторінці доставки — вартість доставки, не ціна товару; виявлено першим прогоном тесту).
 */
export function productPriceKnown(text: string): boolean {
  for (const m of text.matchAll(PRICE_G)) {
    const i = m.index ?? 0;
    if (PRICE_EXCL.test(text.slice(Math.max(0, i - 25), i))) continue;
    if (SHIP_RE.test(text.slice(Math.max(0, i - 40), i + m[0].length + 40))) continue;
    return true;
  }
  return false;
}

/** role:"name" → Playwright-локатор (§11): getByRole / getByText / getByLabel; спершу exact, потім підрядок без регістру. */
export function locatorFor(page: Page, t: SemanticTarget, exact: boolean): Locator {
  switch (t.role) {
    case "text": return page.getByText(t.name, { exact });
    case "label": return page.getByLabel(t.name, { exact });
    default: return page.getByRole(t.role, { name: t.name, exact });
  }
}

/** Код рішення «кошик» (SPEC §19B): кнопка знайдена й доступна, і на цей крок або раніше відомі ціна та доставка. */
export function cartVerdict(obs: Array<{ url: string; cart: CartCandidate[]; price: boolean; ship: boolean }>): CartVerdict {
  let priceSeen = false, shipSeen = false;
  let first: CartVerdict | null = null;
  for (const o of obs) {
    priceSeen ||= o.price;
    shipSeen ||= o.ship;
    const best = o.cart.find((c) => c.visible && !c.disabled && c.hit) ?? o.cart[0];
    if (!best) continue;
    const reachable = best.visible && !best.disabled && best.hit;
    const v: CartVerdict = {
      button_found: true, reachable, button_text: best.text, page_url: o.url, price_known_before: priceSeen, shipping_known_before: shipSeen,
      success: reachable && priceSeen && shipSeen ? "true" : "partial",
    };
    if (v.success === "true") return v;
    first ??= v;
  }
  return first ?? { button_found: false, reachable: false, button_text: null, page_url: null, price_known_before: false, shipping_known_before: false, success: "false" };
}

const QUOTE_RE = /^\s*["“«„](.+?)["”»“]\s*$/su;
/** Цитата friction має бути в побаченому тексті (DEV-63: перевірка дублюється в pipeline); NOT_FOUND — твердження відсутності (SYNTHETIC-гіпотеза). */
export function verifyFrictionEvidence(f: AgentFriction, corpus: string): { ok: true } | { ok: false; reason: string } {
  const ev = f.evidence.trim();
  if (/^NOT_FOUND\s*:/i.test(ev)) return { ok: true };
  const m = QUOTE_RE.exec(ev);
  if (!m) return { ok: false, reason: "no_verifiable_evidence" };
  return norm(corpus).includes(norm(m[1]!)) ? { ok: true } : { ok: false, reason: "quote_not_on_pages" };
}

// ---------------------------------------------------------------------------------------------------------------- журнал
export async function runJourney(o: JourneyOptions): Promise<JourneyResult> {
  assertSecureBrowser(o.secure, "runJourney");
  if (o.secure.proxy.mode.kind === "prod" && (!o.throttle || !o.userAgent)) throw new Error("runJourney: у prod-режимі потрібні throttle (HostGate) і userAgent (DEV-18)");
  const vp: VP = o.vp ?? "D";
  const spec = VIEWPORT_SPECS[vp];
  const maxSteps = Math.min(o.maxSteps ?? o.task.max_actions ?? 8, MAX_JOURNEY_STEPS);
  const sessionId = `${safeId(o.lens_id)}__${safeId(o.task.id)}`;
  const dirRel = `journeys/${sessionId}`;
  const dirAbs = path.join(o.runDir, dirRel);
  await mkdir(dirAbs, { recursive: true });
  const origin = new URL(o.startUrl).origin;
  const filterOn = o.__controlNoFilter !== true;

  const methodFrom = o.secure.blocked.length;
  const netBlocks: NetBlock[] = [];
  const steps: StepLog[] = [];
  const decisions: AgentStepDecision[] = [];
  const observed: Array<{ url: string; cart: CartCandidate[]; price: boolean; ship: boolean }> = [];
  let corpus = "";
  let jsErrors = 0;
  let firstStatus: number | null = null;
  let lastStatus: number | null = null;
  let banner: BannerRecord = { detected: false, state: "none", actions: [] };
  let result: AgentResult | null = null;
  let endReason: EndReason = "step_limit";
  let failedError: string | null = null;
  const failures: Array<{ kind: NonNullable<JourneyEvidence["browser_failure"]>["kind"]; selector?: string; url: string; detail: string }> = [];

  const context = await o.secure.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: spec.dpr,
    isMobile: spec.isMobile,
    hasTouch: spec.isMobile,
    acceptDownloads: false,
    serviceWorkers: "block",
    ...(o.userAgent ? { userAgent: o.userAgent } : {}),
  });
  let closed = false;
  const watchdog = setTimeout(() => { closed = true; void context.close().catch(() => undefined); }, 120_000);
  try {
    await context.addInitScript({ content: WINDOW_OPEN_LOCK_SCRIPT });
    if (filterOn) {
      // Шар 3: те саме deny-list на мережі. GET до deny-list і головна навігація за межі origin не доходять до цілі (JS-навігація, fetch, meta refresh).
      await context.route("**/*", async (route, request: Request) => {
        const rt = request.resourceType();
        const url = request.url();
        if (rt === "document" || rt === "xhr" || rt === "fetch" || rt === "ping") {
          const rule = denyUrl(url, rt === "document" ? "navigation" : "request");
          if (rule && !/^data:|^about:|^blob:/.test(url)) {
            netBlocks.push({ ts: new Date().toISOString(), kind: "deny_url", url, rule });
            return route.abort("blockedbyclient");
          }
        }
        let isMainNav = false;
        try { isMainNav = request.isNavigationRequest() && request.frame().parentFrame() === null; } catch { /* SW/worker */ }
        if (isMainNav && !sameOrigin(url, origin)) {
          netBlocks.push({ ts: new Date().toISOString(), kind: "cross_origin_navigation", url, rule: "cross_origin" });
          return route.abort("blockedbyclient");
        }
        return route.fallback();
      });
    }
    // popup поза журналом не існує: window.open → null; якщо все ж з'явився (target=_blank) — закриваємо й логуємо
    const page: Page = await context.newPage();
    context.on("page", (p) => {
      if (p === page) return;
      netBlocks.push({ ts: new Date().toISOString(), kind: "popup", url: p.url(), rule: "popup" });
      void p.close().catch(() => undefined);
    });
    page.on("pageerror", () => { jsErrors++; });
    page.on("dialog", (d) => { void d.dismiss().catch(() => undefined); });
    page.on("download", (d) => {
      netBlocks.push({ ts: new Date().toISOString(), kind: "download", url: d.url(), rule: "binary_download" });
      void d.cancel().catch(() => undefined);
    });
    page.on("response", (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastStatus = r.status();
      } catch { /* ignore */ }
    });

    const settle = async () => {
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
      await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`).catch(() => undefined);
    };

    // ---- старт: goto (deny-list діє й тут)
    const startRule = filterOn ? denyUrl(o.startUrl, "navigation") : null;
    if (startRule) {
      endReason = "navigation_failed";
      failedError = `start_url_denied:${startRule}`;
    } else {
      await o.throttle?.wait(o.startUrl);
      try {
        const resp = await page.goto(o.startUrl, { waitUntil: "load", timeout: 30_000 });
        firstStatus = resp?.status() ?? null;
        lastStatus = firstStatus;
        if (firstStatus === null || firstStatus >= 400) failures.push({ kind: "http_error", url: o.startUrl, detail: `HTTP ${firstStatus}` });
        banner = await handleBanner(page).catch(() => banner);
      } catch (e) {
        endReason = "navigation_failed";
        failedError = `nav_failed:${String(e).slice(0, 120)}`;
        failures.push({ kind: "nav_timeout", url: o.startUrl, detail: failedError });
      }
    }

    let lastGoodUrl = o.startUrl;
    let recovered = 0;
    let navFailed = false;
    page.on("requestfailed", (r) => {
      try { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navFailed = true; } catch { /* ignore */ }
    });
    /**
     * Скасована фільтром або відхилена проксі головна навігація лишає сторінку «мертвою» (error page, `page.url()` при цьому = URL-мета,
     * а не chrome-error://). Ознака — `requestfailed` головного документа; повертаємось на останню нормальну сторінку, щоб агент не застряг.
     */
    const recover = async () => {
      if (!navFailed) return;
      navFailed = false;
      const isErr = (await page.evaluate(`!!document.querySelector('#main-frame-error, body.neterror, .neterror')`).catch(() => true)) as boolean;
      if (!isErr && page.url() === lastGoodUrl) return;
      recovered++;
      await o.throttle?.wait(lastGoodUrl);
      await page.goto(lastGoodUrl, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
      navFailed = false;
    };
    const observe = async (n: number, remaining: number): Promise<AgentObservation> => {
      await recover();
      const url = page.url();
      if (/^https?:/.test(url)) lastGoodUrl = url;
      const title = await page.title().catch(() => "");
      const outline = clip(await page.locator("body").ariaSnapshot().catch(() => ""), 8000);
      const text = (await page.evaluate(`document.body ? document.body.innerText : ''`).catch(() => "")) as string;
      const links = (await page.evaluate(`Array.from(document.querySelectorAll('a[href]')).map((a) => (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 80)`).catch(() => [])) as string[];
      const cart = (await page.evaluate(`(${CART_SCAN})(${JSON.stringify(CTA_SRC)})`).catch(() => [])) as CartCandidate[];
      observed.push({ url, cart, price: productPriceKnown(text), ship: SHIP_RE.test(text) });
      corpus += `\n${title}\n${text}\n${outline}\n${links.join("\n")}`;
      let shot: string | null = null;
      if (o.writeShots) {
        const rel = `${dirRel}/step-${String(n).padStart(2, "0")}.png`;
        await writeFile(path.join(o.runDir, rel), await page.screenshot({ animations: "disabled", caret: "hide" }).catch(() => Buffer.alloc(0)));
        shot = path.join(o.runDir, rel);
      }
      return {
        step: n, remaining, url, title, a11y_outline: outline, visible_text: clip(text, 6000), link_texts: links,
        history: decisions.map((d) => ({ action: d.action, target: d.target, reason_summary: d.reason_summary })), screenshot_path: shot,
      };
    };

    // ---- цикл
    let used = 0;
    let invalidInRow = 0;
    if (endReason !== "navigation_failed") {
      for (let n = 0; ; n++) {
        if (closed) { endReason = "driver_error"; failedError = "watchdog"; break; }
        const remaining = maxSteps - used;
        const obs = await observe(n, remaining);
        let d: AgentDecision;
        try {
          d = await o.driver(obs);
        } catch (e) {
          endReason = "driver_error";
          failedError = `driver:${String(e).slice(0, 160)}`;
          break;
        }
        const s = d.step;
        const log: StepLog = { n, url_before: obs.url, url_after: obs.url, decision: s, verdict: "executed", rule: null, detail: null, located: null, element: null, screenshot: obs.screenshot_path ? path.relative(o.runDir, obs.screenshot_path) : null };
        steps.push(log);
        const isStop = s.action === "stop_success" || s.action === "stop_failure";
        decisions.push(s);
        if (isStop) {
          log.verdict = "stop";
          result = d.result;
          endReason = s.action === "stop_success" ? "stop_success" : "stop_failure";
          break;
        }
        if (remaining <= 0) {
          log.verdict = "invalid"; log.rule = "no_actions_left"; log.detail = "ліміт кроків вичерпано";
          endReason = "step_limit";
          break;
        }
        used++;
        const verdict = checkAction(s);
        if (!verdict.ok) {
          log.verdict = "invalid"; log.rule = verdict.rule; log.detail = verdict.detail;
          if (++invalidInRow >= MAX_INVALID_IN_ROW) { endReason = "invalid_decisions"; break; }
          continue;
        }
        invalidInRow = 0;

        if (s.action === "scroll") {
          const js = s.target === "top" ? "window.scrollTo(0,0)" : s.target === "up" ? "window.scrollBy(0,-0.8*innerHeight)" : "window.scrollBy(0,0.8*innerHeight)";
          await page.evaluate(js).catch(() => undefined);
          await page.waitForTimeout(50);
          continue;
        }
        if (s.action === "back") {
          await o.throttle?.wait(page.url());
          const r = await page.goBack({ waitUntil: "load", timeout: 15_000 }).catch(() => null);
          if (!r && page.url() === obs.url) { log.verdict = "noop"; log.detail = "історії немає"; }
          if (filterOn && page.url() !== "about:blank" && !sameOrigin(page.url(), origin)) {
            await page.goto(o.startUrl, { waitUntil: "load", timeout: 30_000 }).catch(() => undefined);
          }
          await settle();
          log.url_after = page.url();
          continue;
        }

        // click / navigate_internal_link
        const t = verdict.target!;
        let loc = locatorFor(page, t, true);
        let count = await loc.count().catch(() => 0);
        if (count === 0) { loc = locatorFor(page, t, false); count = await loc.count().catch(() => 0); }
        if (count === 0) {
          log.verdict = "not_found"; log.detail = "елемент за семантичним локатором не знайдено";
          log.located = { role: t.role, name: t.name, count: 0, picked_visible: false };
          continue;
        }
        let pick = loc.first();
        let pickedVisible = false;
        for (let i = 0; i < Math.min(count, 10); i++) {
          if (await loc.nth(i).isVisible().catch(() => false)) { pick = loc.nth(i); pickedVisible = true; break; }
        }
        log.located = { role: t.role, name: t.name, count, picked_visible: pickedVisible };
        const facts = (await pick.evaluate((n, src) => (0, eval)(src)(n), FACTS).catch(() => null)) as RawFacts | null;
        if (!facts) { log.verdict = "not_found"; log.detail = "елемент зник"; continue; }
        log.element = { tag: facts.tag, text: facts.text.slice(0, 80), href: facts.href };

        if (filterOn) {
          const ev = checkElement(s.action as "click" | "navigate_internal_link", facts, origin);
          if (!ev.ok) {
            log.rule = ev.rule; log.detail = ev.detail;
            log.verdict = ev.rule === "commercial_cta" ? "found_not_clicked" : "blocked";
            continue;
          }
        }
        if (!facts.visible || facts.disabled) {
          log.verdict = "not_actionable"; log.rule = facts.disabled ? "disabled" : "not_visible";
          failures.push({ kind: "not_actionable", selector: `${t.role}:"${t.name}"`, url: obs.url, detail: log.rule });
          continue;
        }
        if (facts.blank) await pick.evaluate((n) => { const a = (n as Element).closest("a"); if (a) a.target = "_self"; }).catch(() => undefined);
        await o.throttle?.wait(facts.href ?? page.url());
        try {
          await pick.click({ timeout: 8_000 });
        } catch (e) {
          log.verdict = "not_actionable"; log.rule = "click_failed"; log.detail = String(e).split("\n")[0]!.slice(0, 160);
          failures.push({ kind: /intercepts pointer/.test(String(e)) ? "obscured" : "not_actionable", selector: `${t.role}:"${t.name}"`, url: obs.url, detail: log.detail });
          continue;
        }
        await settle();
        log.url_after = page.url();
        if (lastStatus !== null && lastStatus >= 400 && page.url() !== obs.url) failures.push({ kind: "http_error", url: page.url(), detail: `HTTP ${lastStatus}` });
      }
    }

    // ---- підсумок: код рахує «кошик», відкидає friction без перевірної цитати
    const cart = cartVerdict(observed);
    const accepted: AgentFriction[] = [];
    const rejected: Array<{ friction: AgentFriction; reason: string }> = [];
    for (const f of result?.frictions ?? []) {
      const v = verifyFrictionEvidence(f, corpus);
      if (v.ok) accepted.push(f); else rejected.push({ friction: f, reason: v.reason });
    }
    const isCartTask = o.task.task_type === "add_to_cart";
    const success: SessionOut["success"] = failedError ? "false" : isCartTask ? cart.success : (result?.success ?? "false");
    const visited = new Set(observed.map((x) => x.url));
    const lastUrl = observed.at(-1)?.url ?? o.startUrl;
    const session: SessionOut = {
      session_id: sessionId, audit_run_id: o.audit_run_id, lens_id: o.lens_id, task_id: o.task.id, level: "journey",
      status: failedError ? "failed" : "done", success, actions_used: used,
      frictions: accepted.map((f) => ({ category: f.category, severity: f.severity, evidence: f.evidence, page_url: visited.has(f.page_url) ? f.page_url : lastUrl })),
      positive_signals: result?.positive_signals ?? [], uncertainties: result?.uncertainties ?? [], final_summary: result?.final_summary ?? "",
      steps: decisions,
    };
    const methodBlocks = o.secure.blocked.slice(methodFrom).filter((b) => b.kind === "method").length;
    const evidence = buildJourneyEvidence({
      session, cart, accepted, steps, failures, banner, methodBlocks, jsErrors, status: firstStatus, vp, startUrl: o.startUrl, lastUrl,
      dirRel, isCartTask,
    });
    const files = { journey: `${dirRel}/journey.json`, session: `${dirRel}/session.json`, evidence: `${dirRel}/evidence.json` };
    const out: JourneyResult = { session, evidence, steps, cart, end_reason: endReason, net_blocks: netBlocks, method_blocks: methodBlocks, rejected_frictions: rejected, dir: dirRel, files };
    await writeFile(path.join(o.runDir, files.journey), JSON.stringify({ session_id: sessionId, start_url: o.startUrl, origin, vp, max_steps: maxSteps, filter: filterOn, end_reason: endReason, error: failedError, cart, steps, net_blocks: netBlocks, recovered_from_blocked_navigation: recovered, method_blocks: methodBlocks, rejected_frictions: rejected, banner }, null, 2) + "\n");
    await writeFile(path.join(o.runDir, files.session), JSON.stringify(session, null, 2) + "\n");
    await writeFile(path.join(o.runDir, files.evidence), JSON.stringify(evidence, null, 2) + "\n");
    return out;
  } finally {
    clearTimeout(watchdog);
    await context.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------- Evidence §23
interface EvInput {
  session: SessionOut; cart: CartVerdict; accepted: AgentFriction[]; steps: StepLog[];
  failures: Array<{ kind: NonNullable<JourneyEvidence["browser_failure"]>["kind"]; selector?: string; url: string; detail: string }>;
  banner: BannerRecord; methodBlocks: number; jsErrors: number; status: number | null; vp: VP; startUrl: string; lastUrl: string; dirRel: string; isCartTask: boolean;
}
/**
 * SYNTHETIC — кожна friction агента з перевіреною цитатою (self_confirming ЗАВЖДИ false; code ніколи не парсить це поле з LLM).
 * OBSERVED (опорний факт, self_confirming=false → ET-SUP, не F-DET і не дає VERIFIED): «кнопка кошика знайдена й доступна».
 * browser_failure (OBSERVED, reproduced_by_replay=false — детермінованого повтору тут не робимо, ET-BRW лише за ≥ 2 журналами): збої взаємодії.
 * «Агент здався» — НЕ browser_failure (SCORING_SPEC §1.2): це SYNTHETIC.
 */
export function buildJourneyEvidence(i: EvInput): JourneyEvidence[] {
  const s = i.session;
  const base = { type: "browser_session" as const, self_confirming: false as const, session_id: s.session_id, lens_id: s.lens_id, task_id: s.task_id, level: "journey" as const, artifact_reference: `${i.dirRel}/journey.json` };
  const out: JourneyEvidence[] = [];
  i.accepted.forEach((f, k) => {
    const pageUrl = s.frictions[k]?.page_url ?? i.lastUrl;
    out.push({
      ...base, id: `ev_${sha12(`${s.session_id}|friction|${k}|${f.evidence}`)}`, source_class: "SYNTHETIC", page_url: pageUrl, page_path: pathOf(pageUrl),
      description: clip(f.evidence, 300), selector_or_region: { selector: "body" }, category: f.category, ...(f.claim_kind ? { claim_kind: f.claim_kind } : {}), excerpt: clip(f.evidence, 300),
    });
  });
  const reasons: string[] = [];
  if (i.methodBlocks > 0) reasons.push(`blocked_requests:${i.methodBlocks}`);
  if (i.jsErrors > 0) reasons.push(`js_errors:${i.jsErrors}`);
  if (i.banner.state === "open") reasons.push("banner_open");
  if (!(i.status !== null && i.status >= 200 && i.status < 300)) reasons.push(`http_status:${i.status}`);
  const ctx = { banner_state: i.banner.state, banner_actions: i.banner.actions, blocked_requests_count: i.methodBlocks, js_error_count: i.jsErrors, scroll_completed: true, layout_stable: true, http_status: i.status };
  if (i.isCartTask && i.cart.button_found && i.cart.page_url) {
    out.push({
      ...base, id: `ev_${sha12(`${s.session_id}|cart|${i.cart.page_url}|${i.cart.button_text}`)}`, source_class: "OBSERVED", page_url: i.cart.page_url, page_path: pathOf(i.cart.page_url),
      description: `Add-to-cart control «${i.cart.button_text}» found; reachable=${i.cart.reachable}; price known before=${i.cart.price_known_before}; shipping known before=${i.cart.shipping_known_before}`,
      selector_or_region: { selector: `button:"${i.cart.button_text}"` }, category: "cta", claim_kind: "general", excerpt: i.cart.button_text ?? undefined,
      detector_id: "journey_cart_reachable", assertion: "presence", viewport: i.vp,
      measurement: { reachable: i.cart.reachable, price_known_before: i.cart.price_known_before, shipping_known_before: i.cart.shipping_known_before, success: i.cart.success },
      capture_complete: reasons.length === 0, ...(reasons.length ? { incomplete_reasons: reasons } : {}), capture_context: ctx,
    });
  }
  i.failures.forEach((f, k) => {
    out.push({
      ...base, id: `ev_${sha12(`${s.session_id}|failure|${k}|${f.kind}|${f.url}`)}`, source_class: "OBSERVED", page_url: f.url, page_path: pathOf(f.url),
      description: `Browser interaction failure: ${f.kind} (${f.detail})`, selector_or_region: { selector: f.selector ?? "body" },
      browser_failure: { kind: f.kind, ...(f.selector ? { selector: f.selector } : {}), reproduced_by_replay: false },
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- пакет журналів
export interface JourneyPlanItem { lens_id: string; task: JourneyTask; driver: AgentDriver; startUrl?: string }
/** 8–16 журналів послідовно (SPEC §19B). Збій одного журналу не валить решту (§48): повертається сесія `failed`. */
export async function runJourneys(o: Omit<JourneyOptions, "lens_id" | "task" | "driver"> & { plan: JourneyPlanItem[] }): Promise<Array<JourneyResult | { session_id: string; error: string }>> {
  const out: Array<JourneyResult | { session_id: string; error: string }> = [];
  for (const p of o.plan) {
    try {
      out.push(await runJourney({ ...o, lens_id: p.lens_id, task: p.task, driver: p.driver, startUrl: p.startUrl ?? o.startUrl }));
    } catch (e) {
      out.push({ session_id: `${safeId(p.lens_id)}__${safeId(p.task.id)}`, error: String(e).slice(0, 200) });
    }
  }
  return out;
}
