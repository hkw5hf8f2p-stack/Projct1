/**
 * S4/S5: e2e через РЕАЛЬНИЙ API (SITELENS_SOURCE=api, без /api/dev): UI (next dev) → rewrites → Fastify → worker (PostgreSQL, pg-boss, Chromium) → GET /report → знахідка → доказ зі скриншотом
 * (GET /api/audits/:id/artifacts/…). Аудит — fixtures/shop. 3 прогони: (1) none/uk, (2) none/en, (3) scripted-fake LLM (replay-режим) з вкладками лінз і журналів.
 * Файл лежить у apps/worker/test (а не apps/web/test), бо потребує API/worker/БД, яких немає в залежностях apps/web (його tsconfig ізольований). НЕ змінює apps/web. Якість LLM-частини не перевіряє (fake — SYNTHETIC, ⏭️ живий пас, OQ-1). Артефакти — лише з SL_WRITE_ARTIFACTS=1.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, loadConfig, startBoss } from "@sitelens/pipeline";
import { buildServer } from "../../api/src/server.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { DynamicFake, useFakeLlm } from "./helpers/fake-llm.js";
import { createShopHandler } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { artifactDir, writeArtifacts } from "../../../scripts/artifact-dir.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";

const WEB_PORT = 3101;
const API_PORT = 3111;
process.env["SL_WEB_PORT"] = String(WEB_PORT);
const { newCtx, open, pageErrors, closeBrowser } = await import("../../web/test/harness.js");
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const WEB = path.resolve(import.meta.dirname, "../../web");
const OUT = artifactDir("sprint-4");
const summary: Record<string, unknown> = { web: `next dev, SITELENS_SOURCE api, ${BASE} → ${`http://127.0.0.1:${API_PORT}`}` };

let cluster: TestCluster;
let shop: FixtureServer;
let db: FreshDb;
let boss: PgBoss;
let rt: Runtime;
let api: FastifyInstance | null = null;
let next: ChildProcess | null = null;
let nextLog = "";
let guard: { stop(): number[] };
const art = mkdtempSync(path.join(os.tmpdir(), "sl-web-api-"));
const T = 20 * 60_000;

async function listenApi(llmMode: "none" | "replay"): Promise<void> {
  await api?.close();
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1" } as unknown as NodeJS.ProcessEnv);
  api = await buildServer({ cfg, pool: db.pool, boss, llmMode });
  await api.listen({ host: "127.0.0.1", port: API_PORT });
}
const up = async () => { try { return (await fetch(`${BASE}/`)).ok; } catch { return false; } };

beforeAll(async () => {
  guard = guardTestProcesses();
  cluster = await startTestCluster();
  shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }) });
  db = await freshDatabase(cluster.url);
  boss = createBoss(db.url, { supervise: true, max: 10 });
  await startBoss(boss);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1" } as unknown as NodeJS.ProcessEnv);
  rt = createRuntime(cfg, db.pool, boss);
  rt.log = () => undefined;
  useFakeLlm(rt, new DynamicFake({ frictionLensIds: ["l01", "l03", "l05"] }));
  rt.journalRunner = async (i) => ({
    status: "done", calls: [], non_get_blocked: 0,
    session: { session_id: "ses_" + i.scenarioId.slice(3), success: "true", actions_used: 1, frictions: [], positive_signals: ["Шлях пройдено."], uncertainties: [], final_summary: "Журнал пройдено (fake-виконавець).", pages_seen: [new URL(i.startUrl).pathname], steps: [{ action: "stop_success", target: "", reason_summary: "Мету досягнуто.", task_progress: "Готово.", friction_detected: [] }] },
  });
  await registerHandlers(rt);
  await listenApi("none");
  // next dev в api-режимі: SITELENS_SOURCE НЕ задано (за замовчуванням api), rewrites /api/* → Fastify
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
  await rt?.close();
  await db?.drop().catch(() => undefined);
  await shop?.close();
  await cluster?.stop();
  guard?.stop();
  rmSync(art, { recursive: true, force: true });
  if (writeArtifacts()) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, "e2e-web-api-summary.json"), JSON.stringify(summary, null, 2)); }
});

describe("режим api: жодного фікстурного маршруту", () => {
  it("UI у api-режимі: лендінг без плашки fixture-mode; /api/dev/* не існує (404), /api/health проходить через rewrite до Fastify", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/");
    await page.getByTestId("url-input").waitFor();
    expect(await page.getByTestId("fixture-mode").count()).toBe(0);
    await ctx.close();
    expect((await fetch(`${BASE}/api/dev/audits/fx_completed`)).status).toBe(404);
    const h = await fetch(`${BASE}/api/health`);
    expect(h.status).toBe(200);
    expect((await h.json()) as { ok: boolean }).toMatchObject({ ok: true, db: true });
  }, 120_000);
});

const RUNS: Array<{ n: number; lang: "uk" | "en"; llm: "none" | "replay" }> = [{ n: 1, lang: "uk", llm: "none" }, { n: 2, lang: "en", llm: "none" }, { n: 3, lang: "uk", llm: "replay" }];
describe("e2e §54 через API: лендінг → прогрес → звіт → знахідка → доказ зі скриншотом (fixtures/shop)", () => {
  for (const run of RUNS) {
    it(`прогін ${run.n}/3 (${run.llm}, ${run.lang})`, async () => {
      if (run.n === 3) await listenApi("replay");
      const ctx = await newCtx({ width: 1440, theme: "light", lang: run.lang });
      const page = await open(ctx, "/");
      const artifactResponses: Array<{ url: string; status: number; type: string }> = [];
      page.on("response", (r) => { if (r.url().includes("/artifacts/")) artifactResponses.push({ url: r.url(), status: r.status(), type: r.headers()["content-type"] ?? "" }); });
      await page.getByTestId("url-input").fill(shop.origin + "/");
      await page.getByRole("button", { name: run.lang === "en" ? "Analyze website" : /Аналізувати|Проаналізувати/ }).click();
      await page.getByTestId("progress").waitFor({ timeout: 30_000 });
      expect(await page.locator("[data-step]").count()).toBe(8);
      const auditId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
      expect(auditId).toMatch(/^aud_[0-9a-f]{16}$/);
      await page.getByTestId("report").waitFor({ timeout: 8 * 60_000 });
      const rep = await (await fetch(`${BASE}/api/audits/${auditId}/report`)).json() as { audit: { llm_mode: string; language: string }; findings: unknown[] };
      expect(rep.audit.llm_mode).toBe(run.llm);
      expect(rep.audit.language).toBe(run.lang);
      await page.getByTestId("tab-findings").click();
      await page.getByTestId("panel-findings").waitFor();
      const first = page.getByTestId("finding").first();
      await first.locator("[data-confidence]").first().waitFor({ state: "visible" });
      expect(await first.getAttribute("data-priority")).toMatch(/^\d+$/);
      await first.getByTestId("toggle-details").click();
      await first.getByTestId("open-evidence").first().click();
      await page.getByTestId("lightbox").waitFor();
      await page.locator('[data-testid="lightbox"][data-state="loaded"]').waitFor({ timeout: 20_000 });
      await page.getByTestId("region").waitFor({ state: "visible" });
      const nat = await page.locator(".shot img").evaluate((i: HTMLImageElement) => i.naturalWidth);
      expect(nat).toBeGreaterThan(300);
      // скриншот прийшов із РЕАЛЬНОГО маршруту артефактів API, а не з фікстури
      const shot = artifactResponses.find((r) => r.url.includes(`/api/audits/${auditId}/artifacts/`) && /\.png$/.test(r.url));
      expect(shot, JSON.stringify(artifactResponses)).toBeDefined();
      expect(shot!.status).toBe(200);
      expect(shot!.type).toBe("image/png");
      if (run.n === 1 && writeArtifacts()) { fs.mkdirSync(path.join(OUT, "screens"), { recursive: true }); await page.screenshot({ path: path.join(OUT, "screens", "e2e-api-lightbox-1440-light-uk.png") }); }
      await page.keyboard.press("Escape");
      if (run.llm === "replay") {
        await page.getByTestId("tab-lenses").click();
        await page.getByTestId("panel-lenses").waitFor();
        expect(await page.getByTestId("lens").count()).toBeGreaterThan(5);
        await page.getByTestId("tab-journey").click();
        await page.getByTestId("panel-journey").waitFor();
        expect(await page.getByTestId("session").count()).toBeGreaterThan(0);
      }
      expect(pageErrors(page)).toEqual([]);
      summary[`run_${run.n}`] = { audit_id: auditId, llm: run.llm, lang: run.lang, findings: rep.findings.length, screenshot_request: { status: shot!.status, type: shot!.type }, natural_width: nat };
      await ctx.close();
    }, T);
  }
  it("3/3: усі прогони пройшли (підсумок записано)", () => {
    expect(Object.keys(summary).filter((k) => k.startsWith("run_")).length).toBe(3);
    summary["non_get_to_shop"] = { ...shop.state };
    expect(shop.state.non_get).toBe(0);
  });
});
