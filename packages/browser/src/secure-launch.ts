/**
 * Захищений запуск Chromium (G0-3, G0-4, G0-11; DEV-8, DEV-12, DEV-13).
 *
 * Шар 1 — egress-проксі як єдиний вихід (`--proxy-server`, `--proxy-bypass-list=<-loopback>`, WebRTC лише через
 * проксі, без QUIC). Шар 2 — у кожному контексті: блок не-GET/HEAD до всіх origin з логом, Service Workers block,
 * WebSocket → close. Процес: `chromiumSandbox: true` (без фолбеку), env — білий список, тимчасові HOME/TMPDIR,
 * тимчасовий профіль (Playwright `launch()` створює свіжий user-data-dir і видаляє його при close).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type LaunchOptions } from "playwright";
import { startEgressProxy, type ClientAuth, type Dialer, type EgressProxy, type ProxyLimits, type ProxyMode, type Resolver } from "./net/egress-proxy.js";
import { loadSiteDenylist, type SiteDenylist } from "./net/site-denylist.js";

export interface BlockedRequest {
  ts: string;
  kind: "method" | "websocket";
  method: string;
  url: string;
  resource_type: string | null;
  reason: string;
}

export interface SecureLaunchOptions {
  /**
   * `prod` — loopback/private заблоковано для всього. `fixture` — плюс явні loopback-origin фікстур
   * (`http://127.0.0.1:PORT` або `host:port`); лише поза NODE_ENV=production.
   */
  mode: "prod" | "fixture";
  fixtureOrigins?: string[];
  /** Явний прапорець fixture-режиму (або env SITELENS_FIXTURE_MODE=1). Без нього `mode:"fixture"` кидає виняток. */
  allowFixtureLoopback?: boolean;
  headless?: boolean;
  /** Ін'єкція резолвера/дайлера проксі (тести). */
  resolver?: Resolver;
  dial?: Dialer;
  /** Ліміти проксі (за замовчуванням DEFAULT_PROXY_LIMITS). */
  limits?: Partial<ProxyLimits>;
  /** За замовчуванням — з env SITELENS_SITE_DENYLIST. */
  siteDenylist?: SiteDenylist;
  /** Автентифікація клієнтів проксі; за замовчуванням peer-or-token. */
  clientAuth?: ClientAuth;
}

/** Режим проксі з опцій secureLaunch (спільне для Playwright і Lighthouse). */
export function proxyModeFrom(opts: Pick<SecureLaunchOptions, "mode" | "fixtureOrigins" | "allowFixtureLoopback">): ProxyMode {
  if (opts.mode === "prod") {
    if (opts.fixtureOrigins?.length) throw new Error("secureLaunch: fixtureOrigins не дозволені в prod-режимі");
    return { kind: "prod" };
  }
  if (opts.mode === "fixture")
    return { kind: "fixture", allow: fixtureAllowList(opts.fixtureOrigins ?? []), allowFixtureLoopback: opts.allowFixtureLoopback };
  throw new Error("secureLaunch: mode має бути 'prod' або 'fixture'");
}

declare const SECURE_BRAND: unique symbol;
const issued = new WeakSet<object>();

export interface SecureBrowser {
  /** Брендований тип: сирий playwright `Browser` не присвоюється (лише результат secureLaunch). */
  readonly [SECURE_BRAND]: true;
  browser: Browser;
  proxy: EgressProxy;
  /** Лог блоків шару 2 (усі контексти цього браузера). */
  blocked: BlockedRequest[];
  /** Env, переданий процесу Chromium (для аудиту/тестів). */
  browserEnv: Record<string, string>;
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}

/** Змінні, які Chromium отримує від батька. Усе інше (ключі, DATABASE_URL, ACCESS_TOKEN, *_PROXY) — відкидається. */
/** Runtime-перевірка: лише об'єкт, створений `secureLaunch`, проходить (сирий Browser/структурна підробка — виняток). */
export function assertSecureBrowser(x: unknown, who = "assertSecureBrowser"): asserts x is SecureBrowser {
  if (typeof x !== "object" || x === null || !issued.has(x))
    throw new Error(`${who}: потрібен SecureBrowser (результат secureLaunch), а не сирий Browser`);
}

export const BROWSER_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ"] as const;

export function buildBrowserEnv(tmpRoot: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BROWSER_ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === "string" && v !== "") env[k] = v;
  }
  env.PATH ??= "/usr/bin:/bin";
  env.HOME = path.join(tmpRoot, "home");
  env.TMPDIR = path.join(tmpRoot, "tmp");
  env.XDG_CONFIG_HOME = path.join(tmpRoot, "home/.config");
  env.XDG_CACHE_HOME = path.join(tmpRoot, "home/.cache");
  return env;
}

/** Прапорці шару 1. Порядок і склад перевіряє тест (контроль (в) прибирає `<-loopback>`). */
export function secureChromiumArgs(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    // Chromium за замовчуванням обходить проксі для loopback; `<-loopback>` прибирає це неявне правило.
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
  ];
}

/** Повні launch-опції. Експортовано, щоб контрольні прогони в тестах відрізнялись рівно одним елементом. */
export function buildLaunchOptions(proxyUrl: string, env: Record<string, string>, headless = true): LaunchOptions {
  return {
    headless,
    chromiumSandbox: true,
    args: secureChromiumArgs(proxyUrl),
    env,
    // Не використовуємо Playwright `proxy`: він сам дописує bypass-правила; тут прапорці явні й перевірювані.
  };
}

export const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Шар 2 на контексті: не-GET/HEAD → abort + лог; WebSocket → close + лог. */
export async function applyContextGuards(context: BrowserContext, blocked: BlockedRequest[]): Promise<void> {
  await context.route("**/*", async (route, request) => {
    const method = request.method().toUpperCase();
    if (SAFE_METHODS.has(method)) return route.fallback();
    blocked.push({
      ts: new Date().toISOString(),
      kind: "method",
      method,
      url: request.url(),
      resource_type: request.resourceType(),
      reason: "не-GET/HEAD заблоковано (G0-11, DEV-12)",
    });
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (ws) => {
    blocked.push({ ts: new Date().toISOString(), kind: "websocket", method: "GET", url: ws.url(), resource_type: "websocket", reason: "WebSocket заблоковано (DEV-8)" });
    void ws.close({ code: 1008, reason: "blocked by SiteLens" }).catch(() => {});
  });
}

export const SECURE_CONTEXT_DEFAULTS: BrowserContextOptions = {
  acceptDownloads: false,
  serviceWorkers: "block",
  permissions: [],
};

export function fixtureAllowList(origins: string[]): string[] {
  return origins.map((o) => {
    if (/^[^/]+:\d+$/.test(o)) return o;
    const u = new URL(o);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`fixtureOrigins: лише http(s) origin, отримано ${o}`);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  });
}

export async function secureLaunch(opts: SecureLaunchOptions): Promise<SecureBrowser> {
  const mode = proxyModeFrom(opts);

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "sl-browser-"));
  const cleanup: Array<() => Promise<void>> = [() => rm(tmpRoot, { recursive: true, force: true })];
  try {
    await mkdir(path.join(tmpRoot, "home/.config"), { recursive: true });
    await mkdir(path.join(tmpRoot, "home/.cache"), { recursive: true });
    await mkdir(path.join(tmpRoot, "tmp"), { recursive: true });

    const proxy = await startEgressProxy({
      mode,
      resolver: opts.resolver,
      dial: opts.dial,
      limits: opts.limits,
      clientAuth: opts.clientAuth,
      siteDenylist: opts.siteDenylist ?? loadSiteDenylist(),
    });
    cleanup.unshift(() => proxy.close());
    const browserEnv = buildBrowserEnv(tmpRoot);
    const launchOptions = buildLaunchOptions(proxy.url, browserEnv, opts.headless ?? true);
    // Інваріанти перед запуском — жодного тихого фолбеку на --no-sandbox.
    if (launchOptions.chromiumSandbox !== true || launchOptions.args?.some((a) => a.startsWith("--no-sandbox")))
      throw new Error("secureLaunch: пісочниця Chromium вимкнена — відмова");
    const browser = await chromium.launch(launchOptions); // якщо пісочниця недоступна — кидає, і ми не ловимо
    cleanup.unshift(() => browser.close());

    const blocked: BlockedRequest[] = [];
    const sb = {
      browser,
      proxy,
      blocked,
      browserEnv,
      async newContext(options: BrowserContextOptions = {}) {
        if (options.acceptDownloads === true) throw new Error("secureLaunch: acceptDownloads=true заборонено");
        if (options.serviceWorkers === "allow") throw new Error("secureLaunch: serviceWorkers=allow заборонено");
        if (options.proxy) throw new Error("secureLaunch: proxy на контексті заборонено (єдиний вихід — egress-проксі)");
        const ctx = await browser.newContext({ ...options, ...SECURE_CONTEXT_DEFAULTS });
        await applyContextGuards(ctx, blocked);
        return ctx;
      },
      async close() {
        for (const c of cleanup) await c().catch(() => {});
      },
    } as SecureBrowser;
    issued.add(sb);
    return sb;
  } catch (e) {
    for (const c of cleanup) await c().catch(() => {});
    throw e;
  }
}
