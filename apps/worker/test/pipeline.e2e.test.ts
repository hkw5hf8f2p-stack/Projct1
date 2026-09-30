/**
 * Наскрізний конвеєр S2 у процесі тесту (справжні: PostgreSQL, pg-boss, Chromium, Lighthouse, API через fastify.inject; фікстура збоїв):
 * completed, часткові збої (критерій 2), збій сіда (контроль: «failed» існує), повтор (критерій 4), нуль аналізу при збої (критерій 3).
 * Killи процесів (критерії 1, 8) — окремо, справжніми процесами: scripts/s2-scenarios.ts.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildServer } from "../../api/src/server.js";
import { AuditStatusResponse, CreateAuditResponse } from "@sitelens/schemas";
import { auditDir, createBoss, loadConfig, startBoss } from "@sitelens/pipeline";
import { startErrorsFixture, type ErrorsFixture } from "../../../fixtures/errors/server.js";
import { freshDatabase, type FreshDb } from "../../../scripts/test-db.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

const base = inject("dbUrl");
process.env["LOG_LEVEL"] = "silent";
const art = mkdtempSync(path.join(os.tmpdir(), "sl-e2e-art-"));
let fx: ErrorsFixture;
interface Stack { db: FreshDb; boss: PgBoss; rt: Runtime; api: FastifyInstance; stop(): Promise<void> }
const stacks: Stack[] = [];

async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  if (!base) throw new Error(`тестова БД недоступна: ${inject("dbError")}`);
  const db = await freshDatabase(base);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: fx.origin, LIGHTHOUSE_MAX_PAGES: "1", CAPTURE_ATTEMPTS: "1", ...env } as NodeJS.ProcessEnv);
  const boss = createBoss(db.url, { supervise: true, max: 8 });
  await startBoss(boss);
  const rt = createRuntime(cfg, db.pool, boss);
  rt.log = () => undefined;
  await registerHandlers(rt);
  const api = await buildServer({ cfg, pool: db.pool, boss, llmMode: "none" });
  const s: Stack = {
    db, boss, rt, api,
    async stop() {
      await api.close();
      await boss.stop({ graceful: false, close: true, timeout: 3000 }).catch(() => undefined);
      await rt.close();
      await db.drop();
    },
  };
  stacks.push(s);
  return s;
}
const submit = async (s: Stack, url: string) => CreateAuditResponse.parse((await s.api.inject({ method: "POST", url: "/api/audits", payload: { url } })).json()).auditId;
const status = async (s: Stack, id: string) => AuditStatusResponse.parse((await s.api.inject({ method: "GET", url: `/api/audits/${id}` })).json());
async function waitDone(s: Stack, id: string, ms = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await status(s, id);
    if (st.status === "completed" || st.status === "failed") return st;
    if (Date.now() - t0 > ms) throw new Error(`аудит ${id} не завершився за ${ms} мс; статус ${st.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const q = async (s: Stack, sql: string, a: unknown[] = []) => (await s.db.pool.query(sql, a)).rows;
const digest = async (s: Stack, id: string) => {
  const parts = await Promise.all([
    q(s, "SELECT id, url, page_type, title, http_status, technical_json FROM page_artifacts WHERE audit_run_id = $1 ORDER BY id", [id]),
    q(s, "SELECT id, type, page_url, description, measurement FROM evidence WHERE audit_run_id = $1 ORDER BY id", [id]),
    q(s, "SELECT job_key, status, error_class FROM audit_jobs WHERE audit_run_id = $1 ORDER BY job_key", [id]),
  ]);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
};

beforeAll(async () => {
  fx = await startErrorsFixture();
});
afterAll(async () => {
  for (const s of stacks) await s.stop().catch(() => undefined);
  await fx?.close();
  rmSync(art, { recursive: true, force: true });
});

describe("конвеєр S2 наскрізно", () => {
  it("нормальний сайт (3 сторінки): completed; crawl/capture/lighthouse/accessibility done; LLM-етапи skipped (none); докази й артефакти є", async () => {
    const s = await startStack();
    const id = await submit(s, fx.origin + "/ok");
    const st = await waitDone(s, id);
    expect(st.status).toBe("completed");
    expect(st.error).toBeNull();
    expect(st.warnings).toEqual([]);
    expect(st.progress).toMatchObject({ pages_captured: 3, pages_failed: 0, lighthouse_done: 1, lighthouse_failed: 0 });
    for (const k of ["crawl", "capture", "lighthouse", "accessibility", "aggregate"]) expect(st.stage_status[k], k).toMatchObject({ status: "done" });
    for (const k of ["site_profile", "tasks", "lenses", "scenario_matrix"]) expect(st.stage_status[k], k).toMatchObject({ status: "skipped", reason: "no LLM provider" });
    expect(st.llm_mode).toBe("none");
    const types = await q(s, "SELECT type, count(*)::int AS n FROM evidence WHERE audit_run_id = $1 GROUP BY 1", [id]);
    const by = Object.fromEntries(types.map((r) => [r.type, r.n]));
    expect(by["lighthouse"]).toBe(2); // performance + accessibility
    expect(by["axe"]).toBeGreaterThan(0);
    const dir = auditDir(art, id);
    for (const f of ["crawl.json", "evidence.json", "pages/index/page-capture.json", "pages/index/1440x1000/fullpage.png", "pages/index/lighthouse-desktop.json"]) expect(existsSync(path.join(dir, f)), f).toBe(true);
    // API: сторінки й доказ
    const pages = (await s.api.inject({ method: "GET", url: `/api/audits/${id}/pages` })).json();
    expect(pages.pages).toHaveLength(3);
    const evId = (await q(s, "SELECT id FROM evidence WHERE audit_run_id = $1 AND type = 'axe' LIMIT 1", [id]))[0].id;
    const ev = (await s.api.inject({ method: "GET", url: `/api/audits/${id}/evidence/${evId}` })).json();
    expect(ev.evidence).toMatchObject({ id: evId, type: "axe", source_class: "BENCHMARKED" });
  }, 240_000);

  it("КРИТЕРІЙ 2 — частковий збій: одна сторінка з HTTP 500 + зламаний Lighthouse → аудит completed з позначками, 0 доказів зі збійної сторінки", async () => {
    const s = await startStack({ SITELENS_FAULTS: "lighthouse_broken" });
    const id = await submit(s, fx.origin + "/partial");
    const st = await waitDone(s, id);
    expect(st.status).toBe("completed"); // НЕ failed
    expect(st.error).toBeNull();
    expect(st.progress).toMatchObject({ pages_captured: 3, pages_failed: 1, lighthouse_done: 0, lighthouse_failed: 1 });
    expect(st.stage_status["capture"]).toMatchObject({ status: "done" });
    expect(String((st.stage_status["capture"] as { reason?: string }).reason)).toMatch(/1 з 4 сторінок не захоплено/);
    expect(st.stage_status["lighthouse"]).toMatchObject({ status: "failed" });
    const w = st.warnings;
    expect(w.find((x) => x.stage === "capture")).toMatchObject({ class: "unsupported_site", page_url: fx.origin + "/e/500" });
    expect(w.find((x) => x.stage === "lighthouse")?.message).toMatch(/Lighthouse \(desktop\) не виконано/);
    // §48: жодного аналізу збійної сторінки
    expect(await q(s, "SELECT count(*)::int AS n FROM evidence WHERE audit_run_id = $1 AND page_url = $2", [id, fx.origin + "/e/500"])).toEqual([{ n: 0 }]);
    expect(await q(s, "SELECT count(*)::int AS n FROM evidence WHERE audit_run_id = $1 AND type = 'lighthouse'", [id])).toEqual([{ n: 0 }]);
    const pages = (await s.api.inject({ method: "GET", url: `/api/audits/${id}/pages` })).json().pages as Array<{ url: string; capture_ok: boolean; capture_error: { class: string; message: string } | null }>;
    const bad = pages.find((p) => p.url.endsWith("/e/500"))!;
    expect(bad).toMatchObject({ capture_ok: false, capture_error: { class: "unsupported_site" } });
    expect(bad.capture_error!.message).toMatch(/Аналізу немає/);
    // контроль: та сама система БЕЗ фаулту має Lighthouse-докази (предикат «lighthouse_failed» уміє бути 0)
  }, 240_000);

  it("контроль критерію 2: збій САМОГО сіда → аудит failed з класом і повідомленням, 0 доказів (сайт-рівневий збій, не пропущений)", async () => {
    const s = await startStack();
    const id = await submit(s, fx.origin + "/e/500");
    const st = await waitDone(s, id);
    expect(st.status).toBe("failed");
    expect(st.error).toMatchObject({ class: "unsupported_site" });
    expect(st.error!.message).toMatch(/Аналізу немає/);
    expect(await q(s, "SELECT count(*)::int AS n FROM evidence WHERE audit_run_id = $1", [id])).toEqual([{ n: 0 }]);
    expect(st.stage_status["crawl"]).toMatchObject({ status: "failed" });
    expect(st.stage_status["lighthouse"]).toBeUndefined(); // далі не йшли
  }, 120_000);

  it("КРИТЕРІЙ 4 — повтор: 2 прогони одного URL → 2 незалежні AuditRun; дані першого незмінні (хеш до/після)", async () => {
    const s = await startStack({ LIGHTHOUSE_ENABLED: "0" });
    const a = await submit(s, fx.origin + "/ok");
    await waitDone(s, a);
    const before = await digest(s, a);
    const b = await submit(s, fx.origin + "/ok");
    const sb = await waitDone(s, b);
    expect(b).not.toBe(a);
    expect(sb.status).toBe("completed");
    expect(await digest(s, a)).toBe(before); // дані першого прогону не змінились
    expect((await q(s, "SELECT count(DISTINCT audit_run_id)::int AS n FROM page_artifacts"))[0].n).toBe(2);
    expect(existsSync(auditDir(art, a))).toBe(true);
    expect(auditDir(art, a)).not.toBe(auditDir(art, b));
    // ті самі сторінки, окремі рядки
    const pa = (await q(s, "SELECT id FROM page_artifacts WHERE audit_run_id = $1 ORDER BY id", [a])).map((r) => r.id);
    const pb = (await q(s, "SELECT id FROM page_artifacts WHERE audit_run_id = $1 ORDER BY id", [b])).map((r) => r.id);
    expect(pb).toEqual(pa);
    expect((await status(s, a)).stage_status["lighthouse"]).toMatchObject({ status: "skipped" });
  }, 240_000);
});
