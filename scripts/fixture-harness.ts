/**
 * Харнес аудиту фікстур S1a (спільний для `pnpm run audit:fixture` і vitest): піднімає фікстуру на фіксованому порту
 * (щоб page_url у доказах не залежав від запуску), запускає auditSite через secureLaunch (egress-проксі + шар 2,
 * sl-security), робить не-GET тест і перевірку deny-list.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createShopHandler, type Control, type Mutant } from "../fixtures/shop/server.js";
import { createShopCleanHandler } from "../fixtures/shop-clean/server.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/_shared/server.js";
import { auditSite, type AuditResult } from "../packages/browser/src/audit/run-site.js";
import { secureLaunch, type SecureBrowser } from "../packages/browser/src/secure-launch.js";

export type Site = "shop" | "clean";
export interface FixtureCfg { site: Site; mutant?: Mutant | null; control?: Control | null; port: number; logFile?: string }

export async function startFixture(cfg: FixtureCfg): Promise<FixtureServer> {
  const handler = cfg.site === "shop" ? createShopHandler({ mutant: cfg.mutant ?? null, control: cfg.control ?? null }) : createShopCleanHandler();
  return startFixtureServer({ handler, logFile: cfg.logFile, port: cfg.port });
}

/** Захищений браузер для фікстур: дозволені рівно origin-и фікстур (mode fixture, DEV-8/DEV-13). */
export async function launchForFixtures(ports: number[]): Promise<SecureBrowser> {
  return secureLaunch({ mode: "fixture", fixtureOrigins: ports.map((p) => `http://127.0.0.1:${p}`) });
}

export interface AuditRunCfg extends FixtureCfg {
  sb: SecureBrowser;
  runDir: string;
  shots: boolean;
  tiles?: boolean;
  fxMarkers?: boolean;
}
export async function auditFixture(cfg: AuditRunCfg): Promise<{ result: AuditResult; server: FixtureServer }> {
  const server = await startFixture(cfg);
  try {
    const result = await auditSite({
      browser: cfg.sb.browser,
      newContext: (o) => cfg.sb.newContext(o),
      seedUrl: server.origin + "/",
      runDir: cfg.runDir,
      writeShots: cfg.shots,
      tiles: cfg.tiles ?? cfg.shots,
      collectFxMarkers: cfg.fxMarkers ?? false,
      minDelayMs: 0, // локальна фікстура; на живих сайтах ≥ 1500 мс (DEV-18)
    });
    return { result, server };
  } finally {
    await server.close();
  }
}

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface NonGetReport {
  clicked: string[];
  guarded: { fixture_non_get: number; blocked_logged: number; clicked_ok: boolean };
  control_unguarded: { fixture_non_get: number };
  pass: boolean;
}

/** Клік «в кошик» (POST-форма) і «надіслати» (POST-форма) → фікстура 0 не-GET, лог блоків ≥ 1 на спробу; контроль без шару блоку. */
export async function runNonGetTest(sb: SecureBrowser, port: number): Promise<NonGetReport> {
  const attempt = async (guarded: boolean) => {
    const server = await startFixture({ site: "shop", port });
    try {
      const before = sb.blocked.length;
      const ctx = guarded ? await sb.newContext() : await sb.browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
      let clickedOk = true;
      try {
        const page = await ctx.newPage();
        await page.goto(`${server.origin}/product/aquapro-x200`, { waitUntil: "load" });
        await page.getByRole("button", { name: "Додати в кошик" }).click({ timeout: 5000 }).catch(() => (clickedOk = false));
        await page.waitForTimeout(300);
        await page.goto(`${server.origin}/about`, { waitUntil: "load" });
        await page.getByRole("button", { name: "Надіслати" }).click({ timeout: 5000 }).catch(() => (clickedOk = false));
        await page.waitForTimeout(300);
      } finally {
        await ctx.close();
      }
      return { non_get: server.state.non_get, blocked: sb.blocked.length - before, clickedOk };
    } finally {
      await server.close();
    }
  };
  const g = await attempt(true);
  const c = await attempt(false);
  return {
    clicked: ["Додати в кошик (POST /cart)", "Надіслати (POST /contact)"],
    guarded: { fixture_non_get: g.non_get, blocked_logged: g.blocked, clicked_ok: g.clickedOk },
    control_unguarded: { fixture_non_get: c.non_get },
    pass: g.non_get === 0 && g.blocked >= 2 && g.clickedOk && c.non_get >= 2,
  };
}

export interface DenyReport {
  crawl_hits: { add_to_cart_get: number; logout: number; delete_action: number };
  skipped_by_crawl: number;
  control_direct_get: { add_to_cart_get: number; logout: number; delete_action: number };
  pass: boolean;
}

/** GET add-to-cart/logout/delete: crawl 0 звернень; контроль — прямий GET дає по 1. */
export async function runDenyListTest(sb: SecureBrowser, port: number, runDir: string): Promise<DenyReport> {
  const server = await startFixture({ site: "shop", port });
  try {
    const r = await auditSite({ browser: sb.browser, newContext: (o) => sb.newContext(o), seedUrl: server.origin + "/", runDir, writeShots: false, tiles: false, minDelayMs: 0 });
    const crawlHits = { add_to_cart_get: server.state.add_to_cart_get, logout: server.state.logout, delete_action: server.state.delete_action };
    await fetch(`${server.origin}/catalog?add-to-cart=1`);
    await fetch(`${server.origin}/logout`);
    await fetch(`${server.origin}/catalog?action=delete&list=compare`);
    const control = { add_to_cart_get: server.state.add_to_cart_get, logout: server.state.logout, delete_action: server.state.delete_action };
    const skipped = r.crawl.skipped.filter((s) => s.reason === "deny_list").length;
    return {
      crawl_hits: crawlHits,
      skipped_by_crawl: skipped,
      control_direct_get: control,
      pass: Object.values(crawlHits).every((n) => n === 0) && Object.values(control).every((n) => n === 1) && skipped > 0,
    };
  } finally {
    await server.close();
  }
}

export const writeJson = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};
