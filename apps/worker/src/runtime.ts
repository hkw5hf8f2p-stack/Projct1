/** Стан процесу worker: пул БД, pg-boss, єдиний захищений браузер (перезапускається після краху), HostGate, фікстурні/тестові гачки. */
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { secureLaunch, type SecureBrowser } from "@sitelens/browser";
import { HostGate, HONEST_USER_AGENT, type Resolver, type Dialer } from "./browser-api.js";
import net from "node:net";
import dns from "node:dns";
import type { AppConfig } from "@sitelens/pipeline";
import { ensureChromeWrapper } from "./chrome-wrapper.js";

export interface Runtime {
  cfg: AppConfig;
  pool: Pool;
  boss: PgBoss;
  gate: HostGate;
  userAgent: string | undefined;
  getBrowser(): Promise<SecureBrowser>;
  /** закрити й забути браузер (після краху) — наступний getBrowser() запустить новий */
  resetBrowser(): Promise<void>;
  /** режим і ін'єкції, з якими запускається браузер/Lighthouse */
  netOptions(): { mode: "prod" | "fixture"; fixtureOrigins?: string[]; allowFixtureLoopback?: boolean; resolver?: Resolver; dial?: Dialer };
  hasFault(name: string, url?: string): boolean;
  /** обгортка Chrome Lighthouse з обліком PID до exec (chrome-launcher не прив'язує Chrome до батька) */
  chromeWrapper: { script: string; spawnLog: string };
  /** збої навігаційних запитів і краші вкладок усіх контекстів цього браузера (потрібні, коли captureViewport кидає виняток і власних даних не лишає) */
  nav: { failures: Array<{ url: string; failure: string }>; crashes: number };
  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** Тестовий резолвер: host→IP з SITELENS_TEST_RESOLVER_MAP (лише не-production); решта — справжній DNS. */
function testResolver(map: Record<string, string>): Resolver | undefined {
  if (Object.keys(map).length === 0) return undefined;
  return async (hostname) => {
    const ip = map[hostname.toLowerCase()];
    if (ip) return [{ address: ip, family: ip.includes(":") ? 6 : 4 }];
    const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return r.map((x) => ({ address: x.address, family: x.family === 6 ? 6 : 4 }));
  };
}
/** Тестовий дайлер: "ip:port" → "host:port" (симульований інтернет: публічна IP веде на локальний сервер). Отримує лише ПЕРЕВІРЕНУ IP. */
function testDialer(map: Record<string, string>): Dialer | undefined {
  if (Object.keys(map).length === 0) return undefined;
  return (ip, port) => {
    const to = map[`${ip}:${port}`];
    if (!to) return net.connect({ host: ip, port });
    const [h, p] = to.split(":");
    return net.connect({ host: h!, port: Number(p) });
  };
}

export function createRuntime(cfg: AppConfig, pool: Pool, boss: PgBoss): Runtime {
  let browser: SecureBrowser | null = null;
  let launching: Promise<SecureBrowser> | null = null;
  const fixture = cfg.fixtureMode;
  const gate = fixture ? new HostGate(0, { fixture: true }) : new HostGate();
  const resolver = testResolver(cfg.testResolverMap);
  const dial = testDialer(cfg.testDialMap);
  const netOptions = () => (fixture
    ? { mode: "fixture" as const, fixtureOrigins: cfg.fixtureOrigins, allowFixtureLoopback: true, resolver, dial }
    : { mode: "prod" as const, resolver, dial });
  const nav: Runtime["nav"] = { failures: [], crashes: 0 };
  const chromeWrapper = ensureChromeWrapper(cfg.pidDir);
  const instrument = (sb: SecureBrowser): SecureBrowser => {
    const orig = sb.newContext.bind(sb);
    sb.newContext = async (options) => {
      const ctx = await orig(options);
      ctx.on("requestfailed", (r) => {
        if (r.isNavigationRequest() && nav.failures.length < 500) nav.failures.push({ url: r.url(), failure: r.failure()?.errorText ?? "unknown" });
      });
      ctx.on("page", (p) => p.on("crash", () => void nav.crashes++));
      return ctx;
    };
    return sb;
  };
  const rt: Runtime = {
    cfg, pool, boss, gate, nav, chromeWrapper,
    userAgent: fixture ? undefined : HONEST_USER_AGENT,
    async getBrowser() {
      if (browser && browser.browser.isConnected()) return browser;
      if (browser) await rt.resetBrowser();
      launching ??= secureLaunch(netOptions()).then((b) => (browser = instrument(b))).finally(() => (launching = null));
      return launching;
    },
    async resetBrowser() {
      const b = browser;
      browser = null;
      if (b) await b.close().catch(() => undefined);
    },
    netOptions,
    hasFault(name, url) {
      return cfg.faults.some((f) => f === name || (url !== undefined && f.startsWith(name + ":") && url.includes(f.slice(name.length + 1))));
    },
    log(level, msg, extra = {}) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
    },
    async close() {
      await rt.resetBrowser();
    },
  };
  return rt;
}
