/** API S2 (SPEC §42) на справжніх PostgreSQL + pg-boss (fastify.inject): вхід, токен, ліміти, атомарність, повтор, видалення. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ApiError, AuditStatusResponse, CreateAuditResponse } from "@sitelens/schemas";
import { createBoss, loadConfig, startBoss, upsertPage, insertEvidence, type AppConfig } from "@sitelens/pipeline";
import type { PgBoss } from "pg-boss";
import { buildServer, tokenOk } from "../src/server.js";
import { freshDatabase, type FreshDb } from "../../../scripts/test-db.js";

process.env["LOG_LEVEL"] = "silent";
const base = inject("dbUrl");
const art = mkdtempSync(path.join(os.tmpdir(), "sl-api-art-"));
let db: FreshDb;
let boss: PgBoss;
const apps: FastifyInstance[] = [];

const mkApp = async (env: Record<string, string> = {}, llmMode: "none" | "replay" | "live" = "none"): Promise<{ app: FastifyInstance; cfg: AppConfig }> => {
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, ...env } as NodeJS.ProcessEnv);
  const app = await buildServer({ cfg, pool: db.pool, boss, llmMode });
  apps.push(app);
  return { app, cfg };
};
const post = (app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/audits", payload: body as object, headers });
const count = async (sql: string, args: unknown[] = []) => Number((await db.pool.query(sql, args)).rows[0].n);

beforeAll(async () => {
  if (!base) throw new Error(`тестова БД недоступна: ${inject("dbError")}`); // гучно, не skip
  db = await freshDatabase(base);
  boss = createBoss(db.url, { supervise: false, max: 3 });
  await startBoss(boss);
});
afterAll(async () => {
  for (const a of apps) await a.close();
  await boss?.stop({ graceful: false, close: true }).catch(() => undefined);
  await db?.drop();
  rmSync(art, { recursive: true, force: true });
});

describe("tokenOk", () => {
  it("порівняння сталого часу: рівні → true; різні/порожні/undefined → false", () => {
    expect(tokenOk("abc", "abc")).toBe(true);
    expect(tokenOk("abd", "abc")).toBe(false);
    expect(tokenOk("", "abc")).toBe(false);
    expect(tokenOk(undefined, "abc")).toBe(false);
    expect(tokenOk("abc ", "abc")).toBe(false);
  });
});

describe("POST /api/audits", () => {
  it("валідний URL → 202 {auditId}; рядок audit_runs (queued) І задача crawl_site з'являються разом (одна транзакція)", async () => {
    const { app } = await mkApp();
    const r = await post(app, { url: "https://example.com/shop" });
    expect(r.statusCode).toBe(202);
    const body = CreateAuditResponse.parse(r.json());
    expect(r.headers["location"]).toBe(`/api/audits/${body.auditId}`);
    const row = (await db.pool.query("SELECT status, llm_mode, language, normalized_url, artifact_expires_at > now() + interval '29 days' AS ttl_ok FROM audit_runs WHERE id = $1", [body.auditId])).rows[0];
    expect(row).toMatchObject({ status: "queued", llm_mode: "none", language: "uk", normalized_url: "https://example.com/shop", ttl_ok: true });
    expect(await count("SELECT count(*) AS n FROM pgboss.job WHERE name = 'crawl_site' AND data->>'auditRunId' = $1", [body.auditId])).toBe(1);
  });

  const invalid = ["http://127.0.0.1:4199/", "http://localhost/", "http://169.254.169.254/latest/", "file:///etc/passwd", "http://[::1]/", "http://2130706433/", "http://user:p@example.com/", "not a url", "ftp://example.com/"];
  it("недозволені/некоректні URL → 400 invalid_url з людським повідомленням; 0 рядків у БД, 0 задач у черзі", async () => {
    const { app } = await mkApp();
    const rows0 = await count("SELECT count(*) AS n FROM audit_runs");
    const jobs0 = await count("SELECT count(*) AS n FROM pgboss.job");
    for (const url of invalid) {
      const r = await post(app, { url });
      expect(r.statusCode, url).toBe(400);
      const e = ApiError.parse(r.json());
      expect(e.error.class).toBe("invalid_url");
      expect(e.error.message).toMatch(/Некоректна або заборонена адреса/);
    }
    expect(await count("SELECT count(*) AS n FROM audit_runs")).toBe(rows0);
    expect(await count("SELECT count(*) AS n FROM pgboss.job")).toBe(jobs0);
  });

  it("тіло: без url, зайві поля, не JSON-об'єкт → 400 bad_request", async () => {
    const { app } = await mkApp();
    for (const b of [{}, { url: 5 }, { url: "https://example.com", extra: 1 }, { url: "" }]) expect((await post(app, b)).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: "/api/audits", payload: "{oops", headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/at .*\.ts|node_modules/); // без стеку
  });

  it("language=en зберігається; повтор того самого URL → НОВИЙ AuditRun (§55.12), старий не змінено", async () => {
    const { app } = await mkApp();
    const a = CreateAuditResponse.parse((await post(app, { url: "https://repeat.example.org/", language: "en" })).json()).auditId;
    const snapshot = JSON.stringify((await db.pool.query("SELECT * FROM audit_runs WHERE id = $1", [a])).rows[0]);
    const b = CreateAuditResponse.parse((await post(app, { url: "https://repeat.example.org/" })).json()).auditId;
    expect(b).not.toBe(a);
    expect(JSON.stringify((await db.pool.query("SELECT * FROM audit_runs WHERE id = $1", [a])).rows[0])).toBe(snapshot);
    expect((await db.pool.query("SELECT language FROM audit_runs WHERE id = $1", [a])).rows[0].language).toBe("en");
    expect(await count("SELECT count(*) AS n FROM pgboss.job WHERE name = 'crawl_site' AND data->>'auditRunId' = ANY($1)", [[a, b]])).toBe(2);
  });

  it("≤ N аудитів на сайт за добу (DEV-18): N+1-й → 429 і жодного рядка; інший сайт — ок", async () => {
    const { app } = await mkApp({ DOMAIN_LIMIT_PER_DAY: "2" });
    for (let i = 0; i < 2; i++) expect((await post(app, { url: "https://limited.example.net/" })).statusCode).toBe(202);
    const n0 = await count("SELECT count(*) AS n FROM audit_runs WHERE domain = 'limited.example.net'");
    const r = await post(app, { url: "https://limited.example.net/other" });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("86400");
    expect(await count("SELECT count(*) AS n FROM audit_runs WHERE domain = 'limited.example.net'")).toBe(n0);
    expect((await post(app, { url: "https://free.example.net/" })).statusCode).toBe(202);
  });
});

describe("ACCESS_TOKEN і ліміт на годину (B2)", () => {
  const TOKEN = "correct-horse-battery-staple";
  it("без токена 401, із хибним 401, із правильним 202 (Bearer і x-access-token); health відкритий; 401 не створює аудит", async () => {
    const { app } = await mkApp({ ACCESS_TOKEN: TOKEN, RATE_LIMIT_PER_HOUR: "1000" });
    const n0 = await count("SELECT count(*) AS n FROM audit_runs");
    expect((await post(app, { url: "https://tok.example.com/" })).statusCode).toBe(401);
    expect((await post(app, { url: "https://tok.example.com/" }, { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await post(app, { url: "https://tok.example.com/" }, { authorization: TOKEN })).statusCode).toBe(401); // без схеми Bearer
    expect(await count("SELECT count(*) AS n FROM audit_runs")).toBe(n0);
    const ok1 = await post(app, { url: "https://tok.example.com/a" }, { authorization: `Bearer ${TOKEN}` });
    expect(ok1.statusCode).toBe(202);
    const ok2 = await post(app, { url: "https://tok2.example.com/a" }, { "x-access-token": TOKEN });
    expect(ok2.statusCode).toBe(202);
    const id = CreateAuditResponse.parse(ok1.json()).auditId;
    expect((await app.inject({ method: "GET", url: `/api/audits/${id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/audits/${id}`, headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/audits/${id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect(await count("SELECT count(*) AS n FROM audit_runs WHERE id = $1", [id])).toBe(1); // DELETE без токена не видалив
  });

  it("ліміт/год спрацьовує лише коли токен задано; лічильник у БД (переживає рестарт API)", async () => {
    // окрема БД: лічильник рахує ВСІ аудити за годину
    const d2 = await freshDatabase(base!);
    const b2 = createBoss(d2.url, { supervise: false, max: 2 });
    await startBoss(b2);
    try {
      const mk = async (env: Record<string, string>) => {
        const cfg = loadConfig({ DATABASE_URL: d2.url, ARTIFACT_DIR: art, DOMAIN_LIMIT_PER_DAY: "100", ...env } as NodeJS.ProcessEnv);
        const app = await buildServer({ cfg, pool: d2.pool, boss: b2 });
        apps.push(app);
        return app;
      };
      const hdr = { authorization: `Bearer ${TOKEN}` };
      let app = await mk({ ACCESS_TOKEN: TOKEN, RATE_LIMIT_PER_HOUR: "3" });
      for (let i = 0; i < 3; i++) expect((await post(app, { url: `https://h${i}.example.com/` }, hdr)).statusCode).toBe(202);
      const r = await post(app, { url: "https://h9.example.com/" }, hdr);
      expect(r.statusCode).toBe(429);
      expect(ApiError.parse(r.json()).error.class).toBe("rate_limited");
      expect(r.headers["retry-after"]).toBe("3600");
      // «рестарт API»: новий екземпляр бачить той самий лічильник
      app = await mk({ ACCESS_TOKEN: TOKEN, RATE_LIMIT_PER_HOUR: "3" });
      expect((await post(app, { url: "https://h8.example.com/" }, hdr)).statusCode).toBe(429);
      // контроль: без токена ліміт не діє
      const open = await mk({ RATE_LIMIT_PER_HOUR: "1" });
      expect((await post(open, { url: "https://free1.example.com/" })).statusCode).toBe(202);
      expect((await post(open, { url: "https://free2.example.com/" })).statusCode).toBe(202);
      // аудитів рівно 3 + 2 (429 нічого не створили)
      expect(Number((await d2.pool.query("SELECT count(*) AS n FROM audit_runs")).rows[0].n)).toBe(5);
    } finally {
      await b2.stop({ graceful: false, close: true }).catch(() => undefined);
      await d2.drop();
    }
  });
});

describe("секрети не потрапляють у лог", () => {
  it("ACCESS_TOKEN (Authorization і x-access-token), і в тілі 401-відповіді, і в логах Fastify — відсутній; контроль: сам лог не порожній", async () => {
    process.env["LOG_LEVEL"] = "info";
    const chunks: string[] = [];
    const { Writable } = await import("node:stream");
    const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const TOKEN = "log-canary-token-9f8e7d6c5b4a";
    const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, ACCESS_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    const app = await buildServer({ cfg, pool: db.pool, boss, logStream: stream });
    apps.push(app);
    const a = await post(app, { url: "https://logs.example.com/" }, { authorization: `Bearer ${TOKEN}` });
    const b = await app.inject({ method: "GET", url: "/api/audits/aud_0000000000000000", headers: { "x-access-token": TOKEN } });
    const c = await app.inject({ method: "GET", url: "/api/audits/aud_0000000000000000", headers: { authorization: "Bearer wrong-value-123" } });
    process.env["LOG_LEVEL"] = "silent";
    const log = chunks.join("");
    expect(log.length).toBeGreaterThan(200); // контроль: логи є
    expect(log).toContain("/api/audits"); // і містять запити
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("wrong-value-123");
    expect(a.body + b.body + c.body).not.toContain(TOKEN);
    expect(a.statusCode).toBe(202);
    expect(c.statusCode).toBe(401);
  });
});

describe("GET/DELETE", () => {
  it("статус: форма за Zod, 404 для невідомого й небезпечного id", async () => {
    const { app } = await mkApp();
    const id = CreateAuditResponse.parse((await post(app, { url: "https://status.example.com/" })).json()).auditId;
    const r = await app.inject({ method: "GET", url: `/api/audits/${id}` });
    expect(r.statusCode).toBe(200);
    const s = AuditStatusResponse.parse(r.json());
    expect(s).toMatchObject({ id, status: "queued", llm_mode: "none", error: null, artifacts_deleted: false, progress: { pages_captured: 0, pages_failed: 0 } });
    for (const bad of ["aud_0000000000000000", "nope", "..%2F..%2Fetc", "aud_' OR 1=1--"]) {
      const x = await app.inject({ method: "GET", url: `/api/audits/${bad}` });
      expect(x.statusCode, bad).toBe(404);
      expect(ApiError.parse(x.json()).error.class).toBe("not_found");
    }
  });

  it("pages/evidence: повертає збережене; збійна сторінка видима з класом і повідомленням; 404 для чужого доказу", async () => {
    const { app } = await mkApp();
    const id = CreateAuditResponse.parse((await post(app, { url: "https://pages.example.com/" })).json()).auditId;
    const other = CreateAuditResponse.parse((await post(app, { url: "https://pages2.example.com/" })).json()).auditId;
    await upsertPage(db.pool, id, { id: "index", url: "https://pages.example.com/", page_type: "homepage", page_type_reason: null, title: "T", http_status: 200, desktop_screenshot: "pages/index/d.png", mobile_screenshot: "pages/index/m.png", dom_text: null, aria_snapshot: null, visible_text: "x", metadata_json: {}, links_json: [], technical_json: { page_error: null } });
    await upsertPage(db.pool, id, { id: "broken", url: "https://pages.example.com/broken", page_type: "unknown", page_type_reason: "capture", title: null, http_status: 500, desktop_screenshot: null, mobile_screenshot: null, dom_text: null, aria_snapshot: null, visible_text: null, metadata_json: {}, links_json: [], technical_json: { capture_error: { class: "unsupported_site", message: "m", detail: "HTTP 500", attempts: 1 } } });
    await insertEvidence(db.pool, id, [{ id: "ev_0123456789ab", type: "dom", source_class: "OBSERVED", page_url: "https://pages.example.com/", description: "d", artifact_reference: "pages/index/x.json", selector_or_region: { region: { x: 0, y: 0, w: 1, h: 1 } }, detector_id: "d", claim_kind: "horizontal_overflow", assertion: "presence", viewport: "D", category: "mobile_usability", self_confirming: true, capture_complete: true, capture_context: { banner_state: "none", banner_actions: [], blocked_requests_count: 0, js_error_count: 0, scroll_completed: true, layout_stable: true, http_status: 200 } }]);
    const p = (await app.inject({ method: "GET", url: `/api/audits/${id}/pages` })).json();
    expect(p.pages).toHaveLength(2);
    const broken = p.pages.find((x: { id: string }) => x.id === "broken");
    expect(broken).toMatchObject({ capture_ok: false, capture_error: { class: "unsupported_site" } });
    expect(p.pages.find((x: { id: string }) => x.id === "index")).toMatchObject({ capture_ok: true, evidence_count: 1, screenshots: { desktop: "pages/index/d.png" } });
    const st = AuditStatusResponse.parse((await app.inject({ method: "GET", url: `/api/audits/${id}` })).json());
    expect(st.progress).toMatchObject({ pages_captured: 1, pages_failed: 1 });
    const e = await app.inject({ method: "GET", url: `/api/audits/${id}/evidence/ev_0123456789ab` });
    expect(e.statusCode).toBe(200);
    expect(e.json().evidence).toMatchObject({ id: "ev_0123456789ab", source_class: "OBSERVED", artifact_reference: "pages/index/x.json" });
    expect((await app.inject({ method: "GET", url: `/api/audits/${other}/evidence/ev_0123456789ab` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/audits/${id}/evidence/not-an-id` })).statusCode).toBe(404);
  });

  it("DELETE: видаляє аудит цілком (БД, черга, диск); повторний → 404; після TTL сторінки без скриншотів", async () => {
    const { app, cfg } = await mkApp();
    const id = CreateAuditResponse.parse((await post(app, { url: "https://del.example.com/" })).json()).auditId;
    mkdirSync(path.join(cfg.artifactDir, id, "pages"), { recursive: true });
    writeFileSync(path.join(cfg.artifactDir, id, "pages", "a.json"), "{}");
    const r = await app.inject({ method: "DELETE", url: `/api/audits/${id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ deleted: true, auditId: id, files_removed: 1, queue_jobs_removed: 1 });
    expect(existsSync(path.join(cfg.artifactDir, id))).toBe(false);
    expect(await count("SELECT count(*) AS n FROM audit_runs WHERE id = $1", [id])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM pgboss.job WHERE data->>'auditRunId' = $1", [id])).toBe(0);
    expect((await app.inject({ method: "DELETE", url: `/api/audits/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/audits/${id}` })).statusCode).toBe(404);
  });

  it("невідомий маршрут → 404 у єдиному форматі; внутрішні помилки не витікають", async () => {
    const { app } = await mkApp();
    const r = await app.inject({ method: "GET", url: "/api/nope" });
    expect(r.statusCode).toBe(404);
    expect(ApiError.parse(r.json()).error.class).toBe("not_found");
  });
});
