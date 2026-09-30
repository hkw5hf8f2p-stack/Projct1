/**
 * DEV-84: наскрізний BYO AI на РЕАЛЬНОМУ API (не мок API): Chromium → next dev (rewrites) → Fastify → worker (PostgreSQL, pg-boss, справжній createClientFromEnv) →
 * локальний мок-сервер OpenAI-сумісного API (Responses, /v1/responses) у цьому тесті. Потік: UI /settings/ai (kind=openai_compatible, base_url мок-сервера, фейковий ключ) → Зберегти →
 * Перевірити (ok) → аудит fixtures/shop → звіт: Overview показує «openai_compatible/<model>»; audit_runs.llm_provider = openai_compatible.
 * Ключ НЕ у БД (усі таблиці + pgboss), НЕ у звіті, НЕ в логах API/worker/next, НЕ в артефактах/replay-кеші; у сховищі секретів — лише шифротекст.
 * Що це НЕ доводить: сумісність реальних серверів (мок віддає те, що очікує наш адаптер), якість моделі (відповіді — синтетична фікстура shop; ⏭️ живий пас).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, loadConfig, startBoss } from "@sitelens/pipeline";
import { shopLensesResponse, shopProfileResponse, shopTasksResponse } from "../../../packages/llm/src/testing/synthetic-shop.js";
import { buildServer } from "../../api/src/server.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { createShopHandler } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";

const WEB_PORT = 3141;
const API_PORT = 3151;
process.env["SL_WEB_PORT"] = String(WEB_PORT);
const { newCtx, open, pageErrors, closeBrowser } = await import("../../web/test/harness.js");
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const WEB = path.resolve(import.meta.dirname, "../../web");
const KEY = "sk-e2e-FAKEKEY-9f3a71c0d2b8";
const MODEL = "mock-model-1";
const T = 20 * 60_000;

let cluster: TestCluster, shop: FixtureServer, db: FreshDb, boss: PgBoss, rt: Runtime;
let api: FastifyInstance, mock: Server, next: ChildProcess | null = null;
let guard: { stop(): number[] };
let nextLog = "";
const apiLog: string[] = [], workerLog: string[] = [];
const seen: Array<{ auth: string | undefined; model: string; format: string }> = [];
const root = mkdtempSync(path.join(os.tmpdir(), "sl-byo-"));
const art = path.join(root, "artifacts"), secrets = path.join(root, "secrets"), replay = path.join(root, "replay");
let mockUrl = "";

const evalOk = { noticed: ["Заголовок і призначення сторінки видно."], understood: ["Зрозуміло, що це магазин речей для дому."], unclear: [], likely_next_action: "Перейти до сторінки товару.", positive_signals: ["Зрозумілий головний заголовок."], uncertainties: [], verdict: "no_issue", success: "true", final_summary: "Сторінка підходить для задачі.", frictions: [] };
const BY_FORMAT: Record<string, () => unknown> = { ok_check: () => ({ ok: true }), site_profile: shopProfileResponse, customer_tasks: shopTasksResponse, behavioral_lenses: shopLensesResponse, snapshot_evaluation: () => evalOk };

function startMock(): Promise<void> {
  mock = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b || "{}") as { model?: string; text?: { format?: { name?: string } } };
      const fmt = body.text?.format?.name ?? "";
      seen.push({ auth: req.headers["authorization"], model: body.model ?? "", format: fmt });
      const make = BY_FORMAT[fmt];
      if (req.url !== "/v1/responses" || !make) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `mock: ${req.url} ${fmt}` })); return; }
      const out = JSON.stringify(make());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: out }] }], usage: { input_tokens: 100, output_tokens: Math.ceil(out.length / 4) } }));
    });
  });
  return new Promise((r) => mock.listen(0, "127.0.0.1", () => { mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}`; r(); }));
}
const up = async () => { try { return (await fetch(`${BASE}/`)).ok; } catch { return false; } };

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { const p = path.join(dir, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); }
  return out;
}

beforeAll(async () => {
  guard = guardTestProcesses();
  process.env["SITELENS_SECRETS_DIR"] = secrets;
  process.env["REPLAY_DIR"] = replay;
  for (const k of ["LLM_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_MODEL"]) delete process.env[k];
  cluster = await startTestCluster();
  shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }) });
  await startMock();
  db = await freshDatabase(cluster.url);
  boss = createBoss(db.url, { supervise: true, max: 10 });
  await startBoss(boss);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(root, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1" } as unknown as NodeJS.ProcessEnv);
  rt = createRuntime(cfg, db.pool, boss); // llm() — справжній: знімок аудиту + ключ зі сховища → createClientFromEnv
  rt.log = (level: string, msg: string, extra?: object) => { workerLog.push(JSON.stringify({ level, msg, ...extra })); };
  rt.journalRunner = async (i) => ({
    status: "done", calls: [], non_get_blocked: 0,
    session: { session_id: "ses_" + i.scenarioId.slice(3), success: "true", actions_used: 1, frictions: [], positive_signals: ["Шлях пройдено."], uncertainties: [], final_summary: "Журнал пройдено (stub-виконавець браузерного агента).", pages_seen: [new URL(i.startUrl).pathname], steps: [{ action: "stop_success", target: "", reason_summary: "Мету досягнуто.", task_progress: "Готово.", friction_detected: [] }] },
  });
  await registerHandlers(rt);
  const sink = { write: (s: string) => { apiLog.push(s); return true; } } as unknown as NodeJS.WritableStream;
  api = await buildServer({ cfg, pool: db.pool, boss, llmMode: "none", env: process.env, logStream: sink });
  await api.listen({ host: "127.0.0.1", port: API_PORT });
  const env = { ...process.env, SITELENS_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1", SITELENS_NEXT_DIST: `.next-e2e-${WEB_PORT}` } as NodeJS.ProcessEnv;
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
  await new Promise((r) => mock?.close(() => r(null)));
  await cluster?.stop();
  guard?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("BYO AI наскрізно: UI → PUT → check → аудит → звіт (openai_compatible, мок-сервер)", () => {
  it("налаштування в UI, check ok, аудит fixtures/shop, звіт показує провайдера й модель; ключ ніде не витікає", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/settings/ai");
    await page.getByTestId("ai-settings").waitFor({ timeout: 60_000 });
    await page.getByTestId("kind-openai_compatible").click();
    await page.locator("#ai-base").fill(mockUrl);
    await page.locator("#ai-model").fill(MODEL);
    await page.locator("#ai-key").fill(KEY);
    await page.getByTestId("ai-save").click();
    await page.getByTestId("key-saved").waitFor({ timeout: 30_000 });
    // ключ не повернувся в DOM і в GET налаштувань
    expect(await page.content()).not.toContain(KEY);
    const view = await (await fetch(`${BASE}/api/settings/ai`)).json() as Record<string, unknown>;
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view).toMatchObject({ kind: "openai_compatible", model: MODEL, base_url: mockUrl, key_set: true, source: "ui" });

    await page.getByTestId("ai-check").click();
    await page.getByTestId("check-ok").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("check-ok").innerText()).toContain(MODEL);
    expect(seen.find((s) => s.format === "ok_check"), "check дійшов до мок-сервера").toMatchObject({ auth: `Bearer ${KEY}`, model: MODEL });

    // негативний контроль: перевірка вміє впасти (мок-сервер відкидає невідомий формат → 404 → bad_base_url для openai_compatible)
    // (через API, щоб не ламати збережені налаштування: тимчасово інший base_url на порт без сервера)
    await fetch(`${BASE}/api/settings/ai`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "openai_compatible", base_url: "http://127.0.0.1:9", model: MODEL }) });
    const bad = await (await fetch(`${BASE}/api/settings/ai/check`, { method: "POST" })).json() as { ok: boolean; error_class?: string };
    expect(bad.ok).toBe(false);
    expect(["provider_unavailable", "network_blocked", "bad_base_url"]).toContain(bad.error_class);
    const back = await (await fetch(`${BASE}/api/settings/ai`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "openai_compatible", base_url: mockUrl, model: MODEL }) })).json() as { key_set: boolean };
    expect(back.key_set, "ключ збережено після зміни base_url без нового ключа").toBe(true);

    await page.goto(`${BASE}/`);
    await page.getByTestId("url-input").fill(shop.origin + "/");
    await page.getByRole("button", { name: /Аналізувати|Проаналізувати/ }).click();
    await page.getByTestId("progress").waitFor({ timeout: 30_000 });
    const auditId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
    await page.getByTestId("report").waitFor({ timeout: 8 * 60_000 });

    const modelText = await page.getByTestId("ov-model").innerText();
    expect(modelText).toContain(`openai_compatible/${MODEL}`);
    const repText = await (await fetch(`${BASE}/api/audits/${auditId}/report`)).text();
    const rep = JSON.parse(repText) as { audit: { llm_mode: string; llm_provider: string; llm_model: string } };
    expect(rep.audit).toMatchObject({ llm_mode: "live", llm_provider: "openai_compatible", llm_model: MODEL });
    const stageFormats = new Set(seen.filter((s) => s.auth === `Bearer ${KEY}`).map((s) => s.format));
    expect([...stageFormats].sort()).toEqual(["behavioral_lenses", "customer_tasks", "ok_check", "site_profile", "snapshot_evaluation"]);
    const row = (await db.pool.query("SELECT llm_mode, llm_provider, llm_model, config_json FROM audit_runs WHERE id = $1", [auditId])).rows[0];
    expect(row).toMatchObject({ llm_mode: "live", llm_provider: "openai_compatible", llm_model: MODEL });
    expect(row.config_json.ai).toMatchObject({ kind: "openai_compatible", provider: "openai", base_url: mockUrl, model: MODEL });
    const providers = (await db.pool.query("SELECT DISTINCT provider FROM llm_calls WHERE audit_run_id = $1", [auditId])).rows.map((r) => r.provider);
    expect(providers).toEqual(["openai_compatible"]);
    expect(pageErrors(page)).toEqual([]);
    await ctx.close();

    // ---- ключ ніде не витікає (артефакт-перевірка, не exit-код)
    const leaks: string[] = [];
    const tables = (await db.pool.query("SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema IN ('public','pgboss') AND table_type = 'BASE TABLE'")).rows as Array<{ s: string; t: string }>;
    let rowsScanned = 0;
    for (const { s, t } of tables) {
      const r = await db.pool.query(`SELECT x::text AS v FROM "${s}"."${t}" x`);
      rowsScanned += r.rows.length;
      if (r.rows.some((x) => String(x.v).includes(KEY))) leaks.push(`db:${s}.${t}`);
    }
    expect(rowsScanned).toBeGreaterThan(50); // сканування не порожнє
    if (repText.includes(KEY)) leaks.push("report");
    for (const [n, l] of [["api-log", apiLog.join("")], ["worker-log", workerLog.join("\n")], ["next-log", nextLog]] as const) if (l.includes(KEY)) leaks.push(n);
    expect(apiLog.length, "лог API не порожній").toBeGreaterThan(5);
    const files = [...walk(art), ...walk(replay)];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) if (readFileSync(f).includes(KEY)) leaks.push(`file:${path.relative(root, f)}`);
    const enc = walk(secrets).filter((f) => f.endsWith("ai-settings.enc"));
    expect(enc.length).toBe(1);
    expect(readFileSync(enc[0]!, "utf8")).not.toContain(KEY);
    expect(leaks).toEqual([]);
  }, T);
});
