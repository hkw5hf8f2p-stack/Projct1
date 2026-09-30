/**
 * S8 (DEV-80): скриншоти в UI при заданому ACCESS_TOKEN — наскрізно в справжньому Chromium: next dev → rewrites → Fastify з ACCESS_TOKEN.
 * `<img>` не шле Authorization, тож UI бере короткоживучий підписаний `?st=`. Перевіряється: (а) з токеном у sessionStorage усі thumb-и
 * завантажені (naturalWidth>0, відповіді /artifacts/ = 200 з `st=`, ACCESS_TOKEN у жодному URL); (б) КОНТРОЛЬ: прямий GET артефакту без `st` = 401.
 * Звіт — exampleReport (S1a), PNG підкладено за screenshot_reference першого доказу. Якість LLM не перевіряє.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditDir, completeAudit, createBoss, insertAudit, loadConfig, newAuditId, saveReport, startBoss } from "@sitelens/pipeline";
import { exampleReport } from "../../../packages/reporting/src/testing/example-report.js";
import { buildServer } from "../../api/src/server.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";

process.env["LOG_LEVEL"] = "silent";
const WEB_PORT = 3141, API_PORT = 3142;
process.env["SL_WEB_PORT"] = String(WEB_PORT);
const { newCtx, closeBrowser } = await import("../../web/test/harness.js");
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const WEB = path.resolve(import.meta.dirname, "../../web");
const TOKEN = "e2e-access-token-0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let cluster: TestCluster, db: FreshDb, boss: PgBoss, api: FastifyInstance, next: ChildProcess, guard: { stop(): number[] };
let nextLog = "";
const art = mkdtempSync(path.join(os.tmpdir(), "sl-web-token-"));
let auditId = "";
let shotRef = "";

const up = async () => { try { return (await fetch(`${BASE}/`)).ok; } catch { return false; } };
beforeAll(async () => {
  guard = guardTestProcesses();
  cluster = await startTestCluster();
  db = await freshDatabase(cluster.url);
  boss = createBoss(db.url, { supervise: false, max: 3 });
  await startBoss(boss);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, ACCESS_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv);
  api = await buildServer({ cfg, pool: db.pool, boss, llmMode: "none" });
  await api.listen({ host: "127.0.0.1", port: API_PORT });
  auditId = newAuditId();
  await insertAudit(db.pool, { id: auditId, input_url: "https://example.com/", normalized_url: "https://example.com/", domain: "example.com", language: "uk", llm_mode: "none", ttl_days: 30, config_json: {} });
  await completeAudit(db.pool, auditId);
  const report = exampleReport();
  report.audit.id = auditId;
  const refs = [...new Set(report.evidence.map((e) => e.screenshot_reference).filter((r): r is string => !!r && /\.png$/.test(r)))];
  shotRef = refs[0] ?? "";
  for (const r of refs) { mkdirSync(path.dirname(path.join(auditDir(art, auditId), r)), { recursive: true }); writeFileSync(path.join(auditDir(art, auditId), r), PNG); }
  await saveReport(db.pool, auditId, { report, sha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"), schema_version: "x", scoring_version: "y", guard_version: null, guard_events: 0, rejected: [], generated_at: new Date().toISOString() });
  const env = { ...process.env, SITELENS_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" } as NodeJS.ProcessEnv;
  delete env["SITELENS_SOURCE"];
  next = spawn(path.join(WEB, "node_modules/.bin/next"), ["dev", "-H", "127.0.0.1", "-p", String(WEB_PORT)], { cwd: WEB, env, stdio: ["ignore", "pipe", "pipe"] });
  next.stdout?.on("data", (d) => (nextLog += String(d)));
  next.stderr?.on("data", (d) => (nextLog += String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000 && !(await up())) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) throw new Error(`next dev не піднявся:\n${nextLog.slice(-1500)}`);
}, 240_000);
afterAll(async () => {
  await closeBrowser();
  next?.kill("SIGTERM");
  await api?.close().catch(() => undefined);
  await boss?.stop({ graceful: false, close: true, timeout: 3000 }).catch(() => undefined);
  await db?.drop().catch(() => undefined);
  await cluster?.stop();
  guard?.stop();
  rmSync(art, { recursive: true, force: true });
});

describe("скриншоти в UI при ACCESS_TOKEN (DEV-80)", () => {
  it("контроль: прямий GET артефакту без st і без заголовка = 401 (як робить <img> без виправлення)", async () => {
    expect(shotRef).not.toBe("");
    const r = await fetch(`${BASE}/api/audits/${auditId}/artifacts/${shotRef}`);
    expect(r.status).toBe(401);
  });
  it("з токеном у sessionStorage усі thumb-и завантажені; у URL-ах немає ACCESS_TOKEN; сторінка без токена просить його й не показує скриншотів", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await ctx.newPage();
    await page.addInitScript((t) => { try { sessionStorage.setItem("sl_access_token", t); } catch { /* */ } }, TOKEN);
    const seen: Array<{ url: string; status: number }> = [];
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    page.on("response", (r) => { if (r.url().includes("/artifacts/")) seen.push({ url: r.url(), status: r.status() }); });
    await page.goto(`${BASE}/audit/${auditId}?tab=evidence`);
    await page.getByTestId("report").waitFor({ timeout: 60_000 });
    await page.getByTestId("evidence").waitFor();
    await page.locator('[data-testid="thumb"] img').first().waitFor({ state: "attached", timeout: 30_000 });
    for (const im of await page.locator('[data-testid="thumb"] img').all()) await im.scrollIntoViewIfNeeded(); // loading="lazy": догружаємо кожен
    await page.waitForFunction(() => { const im = Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="thumb"] img')); return im.length > 0 && im.every((i) => i.complete); }, undefined, { timeout: 30_000 });
    const imgs = await page.$$eval('[data-testid="thumb"] img', (els) => els.map((e) => ({ w: (e as HTMLImageElement).naturalWidth, src: (e as HTMLImageElement).src })));
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.every((i) => i.w > 0), JSON.stringify(seen)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.status === 200 && /[?&]st=\d+\.[0-9a-f]{64}$/.test(s.url))).toBe(true);
    expect(urls.some((u) => u.includes(TOKEN))).toBe(false); // ACCESS_TOKEN в жодному URL
    await ctx.close();
    // без токена в sessionStorage: UI просить токен (401), жодного thumb
    const ctx2 = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/audit/${auditId}?tab=evidence`);
    await p2.getByTestId("token-prompt").waitFor({ timeout: 60_000 });
    expect(await p2.locator('[data-testid="thumb"]').count()).toBe(0);
    await ctx2.close();
  }, 180_000);
});
