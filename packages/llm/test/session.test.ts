/**
 * Транспорт `session` (S7 без API, DEV-81). БЕЗ справжніх відповідей моделі: фейковий responses/ пишеться тестом у tmp.
 * Доводить ПЛУМБІНГ: промах → запит у requests/ + статус awaiting_session_model; валідна відповідь → кеш E5 із provenance; невалідна → запит attempt=2 і
 * запис відхиленої відповіді (щоб replay відтворив repair-гілку); промах у replay → гучна помилка; 0 мережевих подій. Якість моделі тут не перевіряється.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BehavioralLens } from "@sitelens/schemas";
import {
  ConfigError, DirStore, LlmClient, ReplayCache, ReplayMissError, SessionProvider, TokenBudget, createClientFromEnv, evaluateSnapshot, requestId, resolveConfig,
  type CacheEntry, type PageInput, type SessionRequestFile,
} from "../src/index.js";
import { NetGuard } from "../src/testing/net-guard.js";

const MODEL = "claude-in-session-test";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const lens = BehavioralLens.parse({
  id: "lens_s", audit_run_id: "aud", name: "Обережний", description: "Перевіряє все перед покупкою", category_knowledge: 0.3, price_sensitivity: 0.7, trust_requirement: 0.8, decision_speed: 0.3,
  detail_preference: 0.7, visual_sensitivity: 0.5, comparison_tendency: 0.6, risk_aversion: 0.8, convenience_priority: 0.5, social_proof_need: 0.5, primary_goal: "Знати повну ціну", likely_questions: [], likely_objections: [],
});
const task = { id: "t1", name: "Find delivery terms", goal: "Find delivery terms before adding to cart", task_type: "delivery" };
const good = (over: Record<string, unknown> = {}) => ({ verdict: "no_issue", noticed: ["Price and add-to-cart control are visible."], understood: ["A glass kettle is sold."], unclear: [], likely_next_action: "Open the delivery page.", frictions: [], positive_signals: [], uncertainties: [], success: "true", final_summary: "The page serves the task.", ...over });

const dirs: string[] = [];
function setup(opts: { withImage?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "s7-test-"));
  dirs.push(root);
  const imgPath = path.join(root, "shot.png");
  writeFileSync(imgPath, PNG);
  const image = opts.withImage === false ? { type: "image" as const, media_type: "image/png" as const, sha256: "0".repeat(64) } : { type: "image" as const, media_type: "image/png" as const, sha256: sha(PNG), path: imgPath, label: "first viewport" };
  const page: PageInput = { id: "p1", url: "http://site-a.test:4213/", page_type: "product", title: "Glass kettle", meta_description: "", headings: ["Glass kettle"], visible_text: "Glass kettle\nPrice 1299 UAH\nAdd to cart", link_texts: [], image };
  const tile = { id: "t0", y_css: 0, height_css: 1000, image };
  const mk = (namespace = "s7", scenario = "unit") => {
    const provider = new SessionProvider({ root, model: MODEL, namespace, scenario, language: "en" });
    const cache = new ReplayCache(new DirStore(path.join(root, "cache")), namespace);
    const client = new LlmClient({ mode: "live", provider, cache, cache_mode: "use", budget: new TokenBudget(5_000_000), record_rejected: true });
    return { provider, cache, client, ctx: { audit_run_id: "a", language: "en" as const, client } };
  };
  const run = (ctx: ReturnType<typeof mk>["ctx"]) => evaluateSnapshot(ctx, { page, lens, task, tiles: [tile], tiles_total: 1, a11y_outline: "main" });
  const reqFiles = () => (existsSync(path.join(root, "requests")) ? readdirSync(path.join(root, "requests")).filter((f) => f.endsWith(".json")).sort() : []);
  const readReq = (f: string) => JSON.parse(readFileSync(path.join(root, "requests", f), "utf8")) as SessionRequestFile;
  const answer = (id: string, text: string) => { mkdirSync(path.join(root, "responses"), { recursive: true }); writeFileSync(path.join(root, "responses", `${id}.json`), text); };
  const replayClient = (namespace = "s7") => new LlmClient({ mode: "replay", cache: new ReplayCache(new DirStore(path.join(root, "cache"), true), namespace), budget: new TokenBudget(5_000_000), cache_identity: { provider: "session", model: MODEL } });
  return { root, page, mk, run, reqFiles, readReq, answer, replayClient };
}
afterEach(() => { dirs.length = 0; });

describe("фаза export: промах → запит у requests/, статус awaiting_session_model", () => {
  it("на порожньому кеші не «падає тихо» і не completed: статус, файл запиту з усіма полями, зображення скопійовано, 0 мережевих подій", async () => {
    const s = setup();
    const guard = new NetGuard().install();
    try {
      const r = await s.run(s.mk().ctx);
      expect(r.status).toBe("awaiting_session_model");
      expect(r.output).toBeNull();
      expect(r.reason).toMatch(/^awaiting_session_model: /);
    } finally { guard.uninstall(); }
    expect(guard.events).toEqual([]);
    const files = s.reqFiles();
    expect(files).toHaveLength(1);
    const q = s.readReq(files[0] as string);
    expect(q.key).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]).toBe(`${q.key}.json`);
    expect(q).toMatchObject({ schema: "sitelens-s7-request/v1", attempt: 1, prompt_id: "snapshot-evaluator-v1", prompt_version: "v1", language: "en", max_tokens: 1800, output_name: "snapshot_evaluation" });
    expect(q.system.length).toBeGreaterThan(200);
    expect(q.user).toContain("<<<PAGE_DATA");
    expect(q.user).toContain(`[image: img/${sha(PNG)}.png`);
    expect(q.images).toEqual([`img/${sha(PNG)}.png`]);
    expect(readFileSync(path.join(s.root, "requests", q.images[0] as string)).equals(PNG)).toBe(true);
    expect((q.response_json_schema as { type: string }).type).toBe("object");
    // сліпота: жодних міток сценарію/namespace у файлі запиту (вони лише в index.json)
    expect(JSON.stringify(q)).not.toMatch(/unit|namespace|scenario/);
    const idx = JSON.parse(readFileSync(path.join(s.root, "index.json"), "utf8")) as { requests: Record<string, { scenarios: string[] }> };
    expect(idx.requests[q.key]?.scenarios).toEqual(["unit"]);
    expect(existsSync(path.join(s.root, "cache"))).toBe(false); // нічого не «запечено» в кеш
  });

  it("контроль: зображення без байтів (заглушка) → гучна ConfigError, а не тихий експорт без картинки", async () => {
    const s = setup({ withImage: false });
    await expect(s.run(s.mk().ctx)).rejects.toBeInstanceOf(ConfigError);
    expect(s.reqFiles()).toHaveLength(0);
  });

  it("namespace ≠ типового → окремий id запиту (E2: три прогони мають три різні файли відповідей), ключ E5 той самий", async () => {
    const s = setup();
    await s.run(s.mk("s7").ctx);
    await s.run(s.mk("s7-e2-run1").ctx);
    await s.run(s.mk("s7-e2-run2").ctx);
    const files = s.reqFiles();
    expect(files).toHaveLength(3);
    const keys = new Set(files.map((f) => s.readReq(f).key));
    expect(keys.size).toBe(1);
    expect(new Set(files).size).toBe(3);
    const key = [...keys][0] as string;
    expect(files).toContain(`${requestId(key, "s7-e2-run1")}.json`);
  });
});

describe("фаза import: відповідь → та сама обробка, що й API → кеш E5 із provenance", () => {
  it("валідна відповідь: done, запис у кеш {provider:session, model, answered_by:blind-subagent, synthetic:false}, токени estimated; replay віддає з кешу без провайдера", async () => {
    const s = setup();
    await s.run(s.mk().ctx);
    const q = s.readReq(s.reqFiles()[0] as string);
    s.answer(q.request_id, JSON.stringify(good()));
    const m = s.mk();
    const r = await s.run(m.ctx);
    expect(r.status).toBe("done");
    expect(r.output?.verdict).toBe("no_issue");
    const rec = r.calls[0]!;
    expect(rec).toMatchObject({ provider: "session", model: MODEL, source: "provider", synthetic: false, tokens_estimated: true });
    expect(rec.input_tokens).toBeGreaterThan(0);
    const e = new DirStore(path.join(s.root, "cache")).get("s7", q.key) as CacheEntry;
    expect(e).toMatchObject({ provider: "session", model: MODEL, synthetic: false, tokens_estimated: true });
    expect(e.provenance).toMatchObject({ provider: "session", model: MODEL, answered_by: "blind-subagent", synthetic: false, tokens_estimated: true });
    expect(e.rejected).toBeUndefined();
    // replay: лише кеш
    const rc = s.replayClient();
    const rr = await evaluateSnapshot({ audit_run_id: "a", language: "en", client: rc }, { page: s.page, lens, task, tiles: [{ id: "t0", y_css: 0, height_css: 1000, image: s.page.image! }], tiles_total: 1, a11y_outline: "main" });
    expect(rr.status).toBe("done");
    expect(rr.calls[0]).toMatchObject({ source: "cache", provider: "session", tokens_estimated: true });
    expect(rr.output).toEqual(r.output);
  });

  it("невалідна відповідь (порушує Zod) → НЕ в кеш як валідна; новий запит attempt=2 у requests/ із переліком порушень; етап awaiting", async () => {
    const s = setup();
    await s.run(s.mk().ctx);
    const q1 = s.readReq(s.reqFiles()[0] as string);
    s.answer(q1.request_id, JSON.stringify({ verdict: "maybe" }));
    const r = await s.run(s.mk().ctx);
    expect(r.status).toBe("awaiting_session_model");
    const files = s.reqFiles();
    expect(files).toHaveLength(2);
    const q2 = files.map((f) => s.readReq(f)).find((q) => q.attempt === 2)!;
    expect(q2).toBeDefined();
    expect(q2.key).not.toBe(q1.key);
    expect(q2.user).toContain(q1.user);
    expect(q2.user).toMatch(/schema:|missing_field:|extra_field:/); // REPAIR_TEMPLATE із порушеннями
    const st = new DirStore(path.join(s.root, "cache"));
    const rej = st.get("s7", q1.key) as CacheEntry;
    expect(rej.rejected).toBe(true);
    expect(rej.issues?.length).toBeGreaterThan(0);
    expect(st.get("s7", q2.key)).toBeUndefined();
  });

  it("repair проходить повністю: валідна відповідь на attempt=2 → done; replay відтворює ОБИДВІ спроби (відхилену з кешу й валідну)", async () => {
    const s = setup();
    await s.run(s.mk().ctx);
    const q1 = s.readReq(s.reqFiles()[0] as string);
    s.answer(q1.request_id, "Sure! Here is the analysis: no issues.");   // не JSON → invalid_json
    await s.run(s.mk().ctx);
    const q2 = s.reqFiles().map((f) => s.readReq(f)).find((q) => q.attempt === 2)!;
    s.answer(q2.request_id, JSON.stringify(good()));
    const r = await s.run(s.mk().ctx);
    expect(r.status).toBe("done");
    expect(r.calls.map((c) => [c.attempt, c.status])).toEqual([[0, "invalid"], [1, "ok"]]);
    const rc = s.replayClient();
    const rr = await evaluateSnapshot({ audit_run_id: "a", language: "en", client: rc }, { page: s.page, lens, task, tiles: [{ id: "t0", y_css: 0, height_css: 1000, image: s.page.image! }], tiles_total: 1, a11y_outline: "main" });
    expect(rr.status).toBe("done");
    expect(rr.calls.map((c) => [c.attempt, c.status, c.source])).toEqual([[0, "invalid", "cache"], [1, "ok", "cache"]]);
  });

  it("невалідно двічі → етап failed (частковий), не awaiting і не done; жодної валідної відповіді в кеші", async () => {
    const s = setup();
    await s.run(s.mk().ctx);
    const q1 = s.readReq(s.reqFiles()[0] as string);
    s.answer(q1.request_id, JSON.stringify({ verdict: "maybe" }));
    await s.run(s.mk().ctx);
    const q2 = s.reqFiles().map((f) => s.readReq(f)).find((q) => q.attempt === 2)!;
    s.answer(q2.request_id, "{not json");
    const r = await s.run(s.mk().ctx);
    expect(r.status).toBe("failed");
    expect(r.output).toBeNull();
    expect(readdirSync(path.join(s.root, "cache", "s7")).every((f) => (JSON.parse(readFileSync(path.join(s.root, "cache", "s7", f), "utf8")) as CacheEntry).rejected === true)).toBe(true);
  });

  it("семантичне порушення (guard/verdict) теж веде до attempt=2, а не мовчазного прийняття", async () => {
    const s = setup();
    await s.run(s.mk().ctx);
    const q1 = s.readReq(s.reqFiles()[0] as string);
    s.answer(q1.request_id, JSON.stringify(good({ verdict: "no_issue", frictions: [{ category: "cta", claim_kind: "general", severity: "low", evidence: "NOT_FOUND: x", tile_id: "t0" }] })));
    const r = await s.run(s.mk().ctx);
    expect(r.status).toBe("awaiting_session_model");
    expect(s.reqFiles().map((f) => s.readReq(f).attempt).sort()).toEqual([1, 2]);
  });
});

describe("replay: промах кешу — гучна помилка", () => {
  it("порожній кеш → ReplayMissError (не статус, не тихий пропуск)", async () => {
    const s = setup();
    await expect(evaluateSnapshot({ audit_run_id: "a", language: "en", client: s.replayClient() }, { page: s.page, lens, task, tiles: [{ id: "t0", y_css: 0, height_css: 1000, image: s.page.image! }], tiles_total: 1, a11y_outline: "main" })).rejects.toBeInstanceOf(ReplayMissError);
  });
  it("зміна SESSION_MODEL_NAME → інший ключ E5 → промах (запис іншої моделі не підсовується)", async () => {
    const s = setup();
    await s.run(s.mk().ctx);
    const q = s.readReq(s.reqFiles()[0] as string);
    s.answer(q.request_id, JSON.stringify(good()));
    await s.run(s.mk().ctx);
    const other = new LlmClient({ mode: "replay", cache: new ReplayCache(new DirStore(path.join(s.root, "cache"), true), "s7"), budget: new TokenBudget(5_000_000), cache_identity: { provider: "session", model: "інша-модель" } });
    await expect(evaluateSnapshot({ audit_run_id: "a", language: "en", client: other }, { page: s.page, lens, task, tiles: [{ id: "t0", y_css: 0, height_css: 1000, image: s.page.image! }], tiles_total: 1, a11y_outline: "main" })).rejects.toBeInstanceOf(ReplayMissError);
  });
});

describe("конфіг LLM_PROVIDER=session", () => {
  it("SESSION_MODEL_NAME обов'язкова; production і bypass заборонені; коректний конфіг → transport=session", () => {
    expect(() => resolveConfig({ LLM_PROVIDER: "session" })).toThrow(ConfigError);
    expect(() => resolveConfig({ LLM_PROVIDER: "session", SESSION_MODEL_NAME: "m", NODE_ENV: "production" })).toThrow(/production/);
    expect(() => resolveConfig({ LLM_PROVIDER: "session", SESSION_MODEL_NAME: "m", LLM_CACHE_MODE: "bypass" })).toThrow(/NAMESPACE/);
    const c = resolveConfig({ LLM_PROVIDER: "session", SESSION_MODEL_NAME: "m" });
    expect(c).toMatchObject({ provider: "session", model: "m", transport: "session", llm_mode: "replay" });
    expect(resolveConfig({ LLM_PROVIDER: "replay", REPLAY_AS: "session:m" }).transport).toBe("session");
    expect(resolveConfig({ LLM_PROVIDER: "replay" }).transport).toBeNull();
  });
  it("createClientFromEnv: session на порожньому кеші → awaiting (запит у S7_SESSION_DIR), replay на тому самому кеші після відповіді → done", async () => {
    const s = setup();
    const env = { LLM_PROVIDER: "session", SESSION_MODEL_NAME: MODEL, S7_SESSION_DIR: s.root };
    const { client } = createClientFromEnv(env);
    const r = await s.run({ audit_run_id: "a", language: "en", client });
    expect(r.status).toBe("awaiting_session_model");
    const q = s.readReq(s.reqFiles()[0] as string);
    s.answer(q.request_id, JSON.stringify(good()));
    const r2 = await s.run({ audit_run_id: "a", language: "en", client: createClientFromEnv(env).client });
    expect(r2.status).toBe("done");
    const rp = createClientFromEnv({ LLM_PROVIDER: "replay", REPLAY_AS: `session:${MODEL}`, REPLAY_DIR: path.join(s.root, "cache") }).client;
    const r3 = await s.run({ audit_run_id: "a", language: "en", client: rp });
    expect(r3.status).toBe("done");
    expect(r3.calls[0]?.source).toBe("cache");
  });
});
