/** Харнес e2e: піднімає `next dev -H 127.0.0.1` у fixture-режимі (або перевикористовує вже запущений) і дає Playwright-сторінки. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env["SL_WEB_PORT"] ?? 3100);
export const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | null = null;
let log = "";

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/`)).ok;
  } catch {
    return false;
  }
}

export async function startWeb(): Promise<void> {
  if (await up()) return;
  child = spawn(path.join(WEB, "node_modules/.bin/next"), ["dev", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: WEB,
    env: { ...process.env, SITELENS_SOURCE: "fixture", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (log += String(d)));
  child.stderr?.on("data", (d) => (log += String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (await up()) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await up())) throw new Error(`next dev не піднявся:\n${log.slice(-2000)}`);
  // прогрів маршрутів (Turbopack компілює на вимогу)
  for (const p of ["/audit/fx_completed", "/api/dev/audits/fx_completed", "/api/dev/audits/fx_completed/report", "/api/dev/audits/fx_completed/artifacts/pages/catalog/1440x1000/viewport.png"]) await fetch(`${BASE}${p}`).catch(() => null);
  await fetch(`${BASE}/api/dev/audits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://warm.example/static" }) }).catch(() => null);
}

export function stopWeb(): void {
  if (child) child.kill("SIGTERM");
  child = null;
}

/**
 * Критерій 9 (G0-5): сервер слухає лише 127.0.0.1. Основне джерело — `lsof`; під користувачем `sitelens` lsof не бачить чужі сокети
 * (лишається порожнім), тож запасне — /proc/net/tcp (стан LISTEN=0A). Повертає рядки виду `127.0.0.1:3100`.
 */
export function listenAddress(): string {
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  if (out.trim()) return `lsof:\n${out}`;
  const hexPort = PORT.toString(16).toUpperCase().padStart(4, "0");
  const lines: string[] = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const l of fs.readFileSync(f, "utf8").split("\n").slice(1)) {
        const c = l.trim().split(/\s+/);
        const [addr, port] = (c[1] ?? "").split(":");
        if (c[3] === "0A" && port === hexPort && addr) {
          const ip = addr.length === 8 ? (addr.match(/../g) as string[]).reverse().map((h) => parseInt(h, 16)).join(".") : `ipv6:${addr}`;
          lines.push(`${ip}:${PORT}`);
        }
      }
    } catch { /* немає /proc */ }
  }
  return `proc/net/tcp:\n${lines.join("\n")}`;
}

let browser: Browser | null = null;
export async function launch(): Promise<Browser> {
  browser ??= await chromium.launch();
  return browser;
}
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

export interface Env { width: 390 | 1440; theme: "light" | "dark"; lang: "uk" | "en" }
export async function newCtx(env: Env): Promise<BrowserContext> {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width: env.width, height: env.width === 390 ? 844 : 900 }, colorScheme: env.theme, deviceScaleFactor: 1 });
  await ctx.addCookies([
    { name: "sl_lang", value: env.lang, url: BASE },
    { name: "sl_theme", value: env.theme, url: BASE },
  ]);
  return ctx;
}

export async function open(ctx: BrowserContext, p: string): Promise<Page> {
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  (page as Page & { __errs: string[] }).__errs = errs;
  await page.goto(`${BASE}${p}`);
  return page;
}
export const pageErrors = (page: Page): string[] => (page as Page & { __errs?: string[] }).__errs ?? [];

export const TABS = ["overview", "lenses", "journey", "findings", "technical", "experiments", "evidence"] as const;
