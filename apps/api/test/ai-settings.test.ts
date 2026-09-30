/** BYO AI: шифроване сховище, 4 маршрути /api/settings/ai, redaction ключа, ACCESS_TOKEN, знімок в AuditRun. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_CHECK_ERROR_CLASSES, AiSettingsInput, AiSettingsView } from "@sitelens/schemas";
import { AiSettingsError, aiEnvOverlay, createBoss, loadConfig, readStoredAiSettings, resolveEffectiveAi, saveAiSettings, startBoss } from "@sitelens/pipeline";
import { ConfigError, OutputInvalidError, ProviderAuthError, ProviderHttpError, ProviderTimeoutError, type LlmProvider } from "@sitelens/llm";
import { buildServer } from "../src/server.js";
import { classifyAiError } from "../src/ai-errors.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";

const KEY = "sk-test-SECRET123";
const dirs: string[] = [];
const mkEnv = (extra: Record<string, string> = {}) => { const d = mkdtempSync(path.join(os.tmpdir(), "sl-ai-")); dirs.push(d); return { SITELENS_SECRETS_DIR: d, ...extra } as Record<string, string>; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("сховище: AES-256-GCM", () => {
  it("round-trip; файли 0600; у файлі немає відкритого ключа", () => {
    const env = mkEnv();
    saveAiSettings({ kind: "anthropic", model: "m-1", api_key: KEY }, env);
    expect(readStoredAiSettings(env)?.api_key).toBe(KEY);
    const enc = readFileSync(path.join(env.SITELENS_SECRETS_DIR!, "ai-settings.enc"), "utf8");
    expect(enc).not.toContain(KEY);
    expect(enc).not.toContain("anthropic");
    expect(statSync(path.join(env.SITELENS_SECRETS_DIR!, "master.key")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(env.SITELENS_SECRETS_DIR!, "ai-settings.enc")).mode & 0o777).toBe(0o600);
  });
  it("SITELENS_MASTER_KEY з env: master.key не створюється; інший ключ не розшифровує", () => {
    const k1 = "a".repeat(64), env = mkEnv({ SITELENS_MASTER_KEY: k1 });
    saveAiSettings({ kind: "openai", model: "m", api_key: KEY }, env);
    expect(existsSync(path.join(env.SITELENS_SECRETS_DIR!, "master.key"))).toBe(false);
    expect(readStoredAiSettings(env)?.api_key).toBe(KEY);
    expect(() => readStoredAiSettings({ ...env, SITELENS_MASTER_KEY: "b".repeat(64) })).toThrow(/не розшифровується/);
    expect(() => readStoredAiSettings({ ...env, SITELENS_MASTER_KEY: "abc" })).toThrow(AiSettingsError);
  });
  it("пошкоджений файл → чітка помилка (не JSON, підмінений ct, невідомий формат)", () => {
    const env = mkEnv();
    saveAiSettings({ kind: "openai", model: "m", api_key: KEY }, env);
    const f = path.join(env.SITELENS_SECRETS_DIR!, "ai-settings.enc");
    const good = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, "garbage"); expect(() => readStoredAiSettings(env)).toThrow(/пошкоджено \(не JSON\)/);
    writeFileSync(f, JSON.stringify({ ...good, ct: Buffer.from("xxxxxxxxxxxxxxxxxxxx").toString("base64") })); expect(() => readStoredAiSettings(env)).toThrow(/не розшифровується/);
    writeFileSync(f, JSON.stringify({ v: 2 })); expect(() => readStoredAiSettings(env)).toThrow(/невідомий формат/);
  });
  it("відсутній майстер-ключ при наявному файлі → master_key_missing; без файлу → null", () => {
    const env = mkEnv();
    expect(readStoredAiSettings(env)).toBeNull();
    saveAiSettings({ kind: "openai", model: "m", api_key: KEY }, env);
    rmSync(path.join(env.SITELENS_SECRETS_DIR!, "master.key"));
    expect(() => readStoredAiSettings(env)).toThrow(/Майстер-ключ відсутній/);
  });
  it("пріоритет UI > env > none; overlay не тягне ключ із env", () => {
    const env = mkEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-env-KEY00000000", LLM_MODEL: "env-m" });
    expect(resolveEffectiveAi(env)).toMatchObject({ source: "env", kind: "openai", model: "env-m" });
    saveAiSettings({ kind: "anthropic", model: "ui-m", api_key: KEY }, env);
    const e = resolveEffectiveAi(env);
    expect(e).toMatchObject({ source: "ui", kind: "anthropic", model: "ui-m" });
    const o = aiEnvOverlay(e, env);
    expect(o).toMatchObject({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY, LLM_MODEL: "ui-m" });
    expect(o["OPENAI_API_KEY"]).toBeUndefined();
    expect(resolveEffectiveAi(mkEnv())).toMatchObject({ source: "none", kind: "none" });
  });
});

describe("схема Input", () => {
  it("userinfo / не-http / base_url не для openai_compatible / ключ для claude_cli → відхилено; локальна адреса для openai_compatible → ок", () => {
    const bad = (o: unknown) => expect(AiSettingsInput.safeParse(o).success).toBe(false);
    bad({ kind: "openai_compatible", base_url: "http://user:pw@127.0.0.1:11434" });
    bad({ kind: "openai_compatible", base_url: "http://user@127.0.0.1" });
    bad({ kind: "openai_compatible", base_url: "ftp://x.y" });
    bad({ kind: "openai_compatible" });
    bad({ kind: "openai", base_url: "http://127.0.0.1:1" });
    bad({ kind: "claude_cli", api_key: KEY });
    bad({ kind: "none", api_key: KEY });
    bad({ kind: "openai", max_audit_tokens: 9_999 });
    bad({ kind: "openai", max_audit_tokens: 5_000_001 });
    bad({ kind: "openai", extra: 1 });
    expect(AiSettingsInput.safeParse({ kind: "openai_compatible", base_url: "http://127.0.0.1:11434", model: "llama" }).success).toBe(true);
  });
});

const sink = () => { const lines: string[] = []; return { lines, stream: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) }; };
const stubs = { pool: {} as never, boss: {} as never };
const mk = async (env: Record<string, string>, extra: Record<string, unknown> = {}, cfgEnv: Record<string, string> = {}) => {
  const cfg = loadConfig({ DATABASE_URL: ["postgres", "://", "u", ":", "p", "@127.0.0.1:1/z"].join(""), ...cfgEnv } as NodeJS.ProcessEnv);
  return buildServer({ cfg, ...stubs, env, ...extra });
};

describe("API /api/settings/ai", () => {
  it("4 маршрути: ключ ніколи не в JSON відповідей і не в логах; key_hint = останні 4", async () => {
    const env = mkEnv(), log = sink();
    const fake: LlmProvider = { name: "openai", model: "reported-m", complete: async () => ({ json: { ok: true }, input_tokens: 1, output_tokens: 1, provider: "openai", model: "reported-m", latency_ms: 1 }) };
    const app = await mk(env, { logStream: log.stream, providerFactory: () => fake });
    process.env["LOG_LEVEL"] = "info";
    const bodies: string[] = [];
    const call = async (method: "GET" | "PUT" | "DELETE" | "POST", url: string, payload?: object) => { const r = await app.inject({ method, url, ...(payload ? { payload } : {}) }); bodies.push(r.body); return r; };
    const g0 = await call("GET", "/api/settings/ai");
    expect(AiSettingsView.parse(g0.json())).toMatchObject({ kind: "none", key_set: false, source: "none", updated_at: null });
    const put = await call("PUT", "/api/settings/ai", { kind: "openai", model: "gpt-x", api_key: KEY, max_audit_tokens: 100000 });
    expect(put.statusCode).toBe(200);
    expect(AiSettingsView.parse(put.json())).toMatchObject({ kind: "openai", model: "gpt-x", key_set: true, key_hint: "…T123", max_audit_tokens: 100000, source: "ui" });
    expect(put.json().key_hint).toBe("…" + KEY.slice(-4));
    expect(put.json()).not.toHaveProperty("api_key");
    const chk = await call("POST", "/api/settings/ai/check");
    expect(chk.json()).toMatchObject({ ok: true, model_reported: "reported-m" });
    const g1 = await call("GET", "/api/settings/ai");
    expect(g1.json().last_check).toMatchObject({ ok: true, model_reported: "reported-m" });
    // PUT без ключа зберігає старий
    const put2 = await call("PUT", "/api/settings/ai", { kind: "openai", model: "gpt-y" });
    expect(put2.json()).toMatchObject({ model: "gpt-y", key_set: true });
    const del = await call("DELETE", "/api/settings/ai/key");
    expect(del.json()).toMatchObject({ key_set: false, kind: "openai" });
    expect(del.json()).not.toHaveProperty("key_hint");
    expect((await call("POST", "/api/settings/ai/check")).json()).toMatchObject({ ok: false, error_class: "no_key" });
    await app.close();
    for (const b of bodies) expect(b).not.toContain("SECRET123");
    expect(log.lines.join("")).not.toContain("SECRET123");
    expect(log.lines.length).toBeGreaterThan(0); // логер справді щось писав — перевірка не порожня
  });
  it("помилка провайдера з ключем у тексті: у відповіді лише error_class; у лозі ключ редаговано", async () => {
    const env = mkEnv(), log = sink();
    const bad: LlmProvider = { name: "openai", model: "m", complete: async () => { throw new ProviderHttpError(`bad key ${KEY}`, 401, false); } };
    const app = await mk(env, { logStream: log.stream, providerFactory: () => bad });
    await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "openai", model: "m", api_key: KEY } });
    const r = await app.inject({ method: "POST", url: "/api/settings/ai/check" });
    expect(r.json()).toMatchObject({ ok: false, error_class: "auth_failed" });
    expect(r.body).not.toContain("SECRET123");
    expect(log.lines.join("")).not.toContain("SECRET123");
    await app.close();
  });
  it("classifyAiError: мапінг помилок провайдерів на закритий перелік (позитив і негатив)", () => {
    const h = (st: number | null, m = "x") => new ProviderHttpError(m, st, false);
    const cases: Array<[unknown, string, Parameters<typeof classifyAiError>[1]?]> = [
      [h(401), "auth_failed"], [h(403), "auth_failed"], [new ProviderAuthError("x"), "not_logged_in"], [h(429), "rate_limited"], [h(404), "model_not_found", "openai"],
      [h(404), "bad_base_url", "openai_compatible"], [h(400, "unknown model x"), "model_not_found"], [h(400, "bad thing"), "unknown"], [h(500), "provider_unavailable"], [h(503), "provider_unavailable"],
      [h(null, "network error: fetch failed"), "provider_unavailable"], [h(null, "network error: getaddrinfo ENOTFOUND h"), "bad_base_url", "openai_compatible"],
      [h(null, "network error: getaddrinfo ENOTFOUND h"), "network_blocked", "openai"], [h(null, "network error: self-signed CERT_ error"), "network_blocked"],
      [h(200, "openai: unexpected response shape"), "invalid_response"], [new OutputInvalidError("x", [], null), "invalid_response"], [new ProviderTimeoutError("t"), "timeout"],
      [new ConfigError("claude-cli: бінарник не знайдено"), "provider_not_available"], [new Error("boom"), "unknown"], ["str", "unknown"], [null, "unknown"],
    ];
    for (const [e, want, kind] of cases) expect(classifyAiError(e, kind), `${String(e)} → ${want}`).toBe(want);
    for (const [e, , kind] of cases) expect(AI_CHECK_ERROR_CLASSES as readonly string[]).toContain(classifyAiError(e, kind)); // ніколи не поза переліком
  });
  it("PUT: userinfo у base_url → 400 без ехо значення; відсутня model → 400", async () => {
    const env = mkEnv();
    const app = await mk(env);
    const r = await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "openai_compatible", base_url: "http://u:PASSWD9@127.0.0.1:11434", model: "m" } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("PASSWD9");
    expect((await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "anthropic", api_key: KEY } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "openai_compatible", base_url: "http://127.0.0.1:11434", model: "llama" } })).statusCode).toBe(200);
    await app.close();
  });
  it("check: provider_not_available, коли провайдера немає; none → no_provider", async () => {
    const env = mkEnv();
    const app = await mk(env, { providerFactory: () => undefined });
    expect((await app.inject({ method: "POST", url: "/api/settings/ai/check" })).json()).toMatchObject({ ok: false, error_class: "no_provider" });
    await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "claude_cli" } });
    const r = await app.inject({ method: "POST", url: "/api/settings/ai/check" });
    expect(r.json()).toMatchObject({ ok: false, error_class: "provider_not_available" });
    expect(typeof r.json().latency_ms).toBe("number");
    await app.close();
  });
  it("пошкоджений файл → 503 ai_settings_unavailable з чітким повідомленням", async () => {
    const env = mkEnv();
    const app = await mk(env);
    await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "openai", model: "m", api_key: KEY } });
    writeFileSync(path.join(env.SITELENS_SECRETS_DIR!, "ai-settings.enc"), "garbage");
    const r = await app.inject({ method: "GET", url: "/api/settings/ai" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.class).toBe("ai_settings_unavailable");
    await app.close();
  });
  it("ACCESS_TOKEN: без токена 401 на всіх 4 маршрутах; з токеном 200", async () => {
    const env = mkEnv();
    const app = await mk(env, {}, { ACCESS_TOKEN: "t".repeat(24) });
    for (const [m, u] of [["GET", "/api/settings/ai"], ["PUT", "/api/settings/ai"], ["DELETE", "/api/settings/ai/key"], ["POST", "/api/settings/ai/check"]] as const) {
      expect((await app.inject({ method: m, url: u, payload: m === "PUT" ? { kind: "none" } : undefined })).statusCode, `${m} ${u}`).toBe(401);
      expect((await app.inject({ method: m, url: u, headers: { authorization: "Bearer wrong-token-value-xxxx" }, payload: m === "PUT" ? { kind: "none" } : undefined })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/api/settings/ai", headers: { authorization: `Bearer ${"t".repeat(24)}` } })).statusCode).toBe(200);
    await app.close();
  });
});

describe("data/ ігнорується git", () => {
  it("git check-ignore: data/secrets/master.key і ai-settings.enc", () => {
    const out = execFileSync("git", ["-c", `safe.directory=${path.resolve(import.meta.dirname, "../../..")}`, "check-ignore", "data/secrets/master.key", "data/secrets/ai-settings.enc"], { cwd: path.resolve(import.meta.dirname, "../../..") }).toString();
    expect(out).toContain("master.key");
    expect(out).toContain("ai-settings.enc");
  });
});

describe("знімок в AuditRun (справжній PostgreSQL)", () => {
  let cluster: TestCluster, db: FreshDb, boss: PgBoss;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => { cluster = await startTestCluster(); db = await freshDatabase(cluster.url); boss = createBoss(db.url, { supervise: false, max: 3 }); await startBoss(boss); });
  afterAll(async () => { for (const a of apps) await a.close(); await boss?.stop({ graceful: false, close: true }).catch(() => undefined); await db?.drop(); await cluster?.stop(); });
  it("POST /api/audits знімає provider+model (без ключа); зміна налаштувань після — на аудит не діє", async () => {
    const env = mkEnv();
    const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: mkdtempSync(path.join(os.tmpdir(), "sl-art-")), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: "http://127.0.0.1:9" } as NodeJS.ProcessEnv);
    const app = await buildServer({ cfg, pool: db.pool, boss, llmMode: "none", env });
    apps.push(app);
    await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "anthropic", model: "snap-model", api_key: KEY } });
    const r = await app.inject({ method: "POST", url: "/api/audits", payload: { url: "http://127.0.0.1:9/" } });
    expect(r.statusCode, r.body).toBe(202);
    const id = r.json().auditId as string;
    await app.inject({ method: "PUT", url: "/api/settings/ai", payload: { kind: "openai", model: "other", api_key: ["sk", "other", "0".repeat(12)].join("-") } });
    const row = (await db.pool.query("SELECT llm_mode, llm_provider, llm_model, config_json FROM audit_runs WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ llm_mode: "live", llm_provider: "anthropic", llm_model: "snap-model" });
    expect(row.config_json.ai).toMatchObject({ source: "ui", kind: "anthropic", provider: "anthropic", model: "snap-model" });
    expect(JSON.stringify(row)).not.toContain("SECRET123");
    expect(JSON.stringify((await db.pool.query("SELECT * FROM audit_runs")).rows)).not.toContain("other-000");
  });
  it("DEV-84: llm_provider у БД для openai_compatible і claude_cli (раніше NULL); none → NULL", async () => {
    const env = mkEnv();
    const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: mkdtempSync(path.join(os.tmpdir(), "sl-art-")), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: "http://127.0.0.1:9" } as NodeJS.ProcessEnv);
    const app = await buildServer({ cfg, pool: db.pool, boss, llmMode: "none", env });
    apps.push(app);
    const run = async (payload: object) => {
      await app.inject({ method: "PUT", url: "/api/settings/ai", payload });
      const r = await app.inject({ method: "POST", url: "/api/audits", payload: { url: "http://127.0.0.1:9/" } });
      expect(r.statusCode, r.body).toBe(202);
      return (await db.pool.query("SELECT llm_mode, llm_provider, llm_model FROM audit_runs WHERE id = $1", [r.json().auditId])).rows[0];
    };
    expect(await run({ kind: "openai_compatible", base_url: "http://127.0.0.1:11434", model: "llama3", api_key: KEY })).toEqual({ llm_mode: "live", llm_provider: "openai_compatible", llm_model: "llama3" });
    expect(await run({ kind: "claude_cli" })).toEqual({ llm_mode: "live", llm_provider: "claude_cli", llm_model: null });
    expect(await run({ kind: "none" })).toEqual({ llm_mode: "none", llm_provider: null, llm_model: null });
  });
});
