/**
 * openai_compatible → Chat Completions (DEV-89). Контракт на мок-HTTP у стилі Ollama/LM Studio: форма запиту, structured output
 * (json_schema → json_object → prompted), Zod у LlmClient як остаточний суддя, конфіг/вибір режиму.
 * ЩО ДОВЕДЕНО: формат запиту/розбору відповіді проти мока. НЕ доведено (⏭️ live pass): реальні Ollama/LM Studio/vLLM, їх strict-json_schema, vision-моделі.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, LlmClient, MemoryStore, OpenAiChatProvider, OpenAiProvider, OutputInvalidError, ProviderHttpError, ReplayCache, TokenBudget, createClientFromEnv, openAiEndpoint, parseJsonLoose, resolveConfig, sha256 } from "../src/index.js";
import { REPLAY_DIR, Tiny, mockFetch, noSleep, tinyReq } from "./helpers.js";

const KEY = "sk-local-SECRETKEY-9999";
const ollamaOk = (content: unknown, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1", object: "chat.completion", created: 1, model: "qwen-local",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 }, ...extra,
});
const mk = (replies: Parameters<typeof mockFetch>[0], baseUrl = "http://127.0.0.1:11434/v1") => {
  const m = mockFetch(replies);
  return { ...m, p: new OpenAiChatProvider({ apiKey: KEY, model: "model-from-env", baseUrl, fetchImpl: m.fetchImpl, sleep: noSleep }) };
};
const rejectSchema = { status: 400, body: { error: { message: "'response_format.type' must be 'json_object' or 'text'; json_schema is not supported" } } };
const rejectAnyFormat = { status: 400, body: { error: { message: "response_format is not supported by this server" } } };

describe("Chat Completions: форма запиту (Ollama-стиль)", () => {
  it("URL: /v1 у базі не дублюється; без /v1 — додається; ключ у Authorization; system+user; json_schema strict; max_tokens; без temperature/top_p", async () => {
    for (const [base, want] of [["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/chat/completions"], ["http://localhost:1234", "http://localhost:1234/v1/chat/completions"], ["http://h:8000/v1/", "http://h:8000/v1/chat/completions"]] as const) {
      const { p, calls } = mk([{ status: 200, body: ollamaOk('{"answer":"hi"}') }], base);
      const r = await p.complete(tinyReq());
      const c = calls[0]!;
      expect(c.url).toBe(want);
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(c.body.model).toBe("model-from-env");
      expect(c.body.messages).toEqual([{ role: "system", content: "system text" }, { role: "user", content: [{ type: "text", text: "hello" }] }]);
      expect(c.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "tiny", strict: true } });
      expect(c.body.max_tokens).toBe(100);
      expect("temperature" in c.body || "top_p" in c.body).toBe(false);
      expect(r.json).toEqual({ answer: "hi" });
      expect(r).toMatchObject({ input_tokens: 21, output_tokens: 9, provider: "openai", model: "model-from-env", temperature_dropped: false });
      expect(r.provenance).toMatchObject({ api: "chat_completions", response_format: "json_schema", finish_reason: "stop" });
    }
  });
  it("зображення — image_url data URI з перевіркою sha256 (підміна байтів → ConfigError, запиту немає)", async () => {
    const b64 = Buffer.from("png-bytes").toString("base64");
    const { p, calls } = mk([{ status: 200, body: ollamaOk('{"answer":"hi"}') }]);
    await p.complete(tinyReq({ content: [{ type: "text", text: "x" }, { type: "image", media_type: "image/png", sha256: sha256("png-bytes"), data_b64: b64 }] }));
    const user = (calls[0]!.body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[1]!;
    expect(user.content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
    const bad = mk([{ status: 200, body: ollamaOk("{}") }]);
    await expect(bad.p.complete(tinyReq({ content: [{ type: "image", media_type: "image/png", sha256: "0".repeat(64), path: path.join(REPLAY_DIR, "hostile/cases.json") }] }))).rejects.toThrow(ConfigError);
    expect(bad.calls).toHaveLength(0);
  });
});

describe("Chat Completions: structured output і фолбеки", () => {
  it("сервер відхиляє json_schema → json_object + схема в system; огорожа ```json розбирається; щабель запам'ятовується (наступний виклик — одразу json_object)", async () => {
    const { p, calls } = mk([rejectSchema, { status: 200, body: ollamaOk('Sure!\n```json\n{"answer":"hi"}\n```') }, { status: 200, body: ollamaOk('{"answer":"again"}') }]);
    const r1 = await p.complete(tinyReq());
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.response_format).toMatchObject({ type: "json_schema" });
    expect(calls[1]!.body.response_format).toEqual({ type: "json_object" });
    const sys1 = (calls[1]!.body.messages as Array<{ content: string }>)[0]!.content;
    expect(sys1).toContain("system text");
    expect(sys1).toContain('"answer"');   // схема потрапила в промпт
    expect(r1.json).toEqual({ answer: "hi" });
    expect(r1.provenance).toMatchObject({ response_format: "json_object" });
    await p.complete(tinyReq());
    expect(calls).toHaveLength(3);        // без повторної спроби json_schema
    expect(calls[2]!.body.response_format).toEqual({ type: "json_object" });
  });
  it("сервер не знає й json_object → лише схема в промпті, без response_format", async () => {
    const { p, calls } = mk([rejectSchema, rejectAnyFormat, { status: 200, body: ollamaOk('{"answer":"hi"}') }]);
    const r = await p.complete(tinyReq());
    expect(calls).toHaveLength(3);
    expect("response_format" in calls[2]!.body).toBe(false);
    expect(r.provenance).toMatchObject({ response_format: "prompted" });
    expect(r.json).toEqual({ answer: "hi" });
  });
  it("400, що не про формат (модель не знайдено), і 401 НЕ спускають щабель і не ховаються", async () => {
    const nf = mk([{ status: 400, body: { error: { message: "model 'model-from-env' not found, try pulling it first" } } }]);
    await expect(nf.p.complete(tinyReq())).rejects.toBeInstanceOf(ProviderHttpError);
    expect(nf.calls).toHaveLength(1);
    expect(nf.p.formatMode).toBe("json_schema");
    const un = mk([{ status: 401, body: { error: { message: `bad key ${KEY}` } } }]);
    const e = await un.p.complete(tinyReq()).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect((e as Error).message).not.toContain(KEY);          // секрет редагується
  });
  it("temperature-400 → повтор без temperature (G0-27) і не плутається з відхиленням формату", async () => {
    const { p, calls } = mk([{ status: 400, body: { error: { message: "temperature is not supported" } } }, { status: 200, body: ollamaOk('{"answer":"hi"}') }]);
    const r = await p.complete(tinyReq({ sampling: { max_tokens: 100, temperature: 0.2 } }));
    expect(calls[0]!.body.temperature).toBe(0.2);
    expect("temperature" in calls[1]!.body).toBe(false);
    expect(calls[1]!.body.response_format).toMatchObject({ type: "json_schema" });
    expect(r.temperature_dropped).toBe(true);
  });
  it("429/5xx повторюються (спільний postJson)", async () => {
    const { p, calls } = mk([{ status: 503, body: "busy" }, { status: 200, body: ollamaOk('{"answer":"hi"}') }]);
    expect((await p.complete(tinyReq())).json).toEqual({ answer: "hi" });
    expect(calls).toHaveLength(2);
  });
});

describe("Chat Completions: розбір відповіді", () => {
  it("немає usage → оцінка за символами + tokens_estimated (не нулі)", async () => {
    const { p } = mk([{ status: 200, body: { choices: [{ message: { content: '{"answer":"hi"}' }, finish_reason: "stop" }] } }]);
    const r = await p.complete(tinyReq());
    expect(r.tokens_estimated).toBe(true);
    expect(r.input_tokens).toBeGreaterThan(0);
    expect(r.output_tokens).toBeGreaterThan(0);
  });
  it("content як масив частин; refusal/порожній/не-JSON → json=null + raw_text; форма без choices → помилка", async () => {
    expect((await mk([{ status: 200, body: ollamaOk([{ type: "text", text: '{"answer":' }, { type: "text", text: '"hi"}' }]) }]).p.complete(tinyReq())).json).toEqual({ answer: "hi" });
    const bad = await mk([{ status: 200, body: ollamaOk("{oops") }]).p.complete(tinyReq());
    expect(bad).toMatchObject({ json: null, raw_text: "{oops" });
    const refusal = await mk([{ status: 200, body: { choices: [{ message: { content: null, refusal: "cannot" }, finish_reason: "stop" }] } }]).p.complete(tinyReq());
    expect(refusal).toMatchObject({ json: null, raw_text: "cannot" });
    await expect(mk([{ status: 200, body: { error: "x" } }]).p.complete(tinyReq())).rejects.toThrow(/unexpected response shape/);
  });
  it("parseJsonLoose: строгий, огорожа, префікс/суфікс із дужками у рядках; безнадійне → undefined", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('text {"a":"}{"} tail')).toEqual({ a: "}{" });
    expect(parseJsonLoose("no json here")).toBeUndefined();
    expect(parseJsonLoose('{"a":')).toBeUndefined();
  });
});

describe("Chat Completions + LlmClient: остаточний суддя — Zod", () => {
  const client = (p: OpenAiChatProvider) => new LlmClient({ mode: "live", provider: p, cache: new ReplayCache(new MemoryStore(), "t"), budget: new TokenBudget(1_000_000) });
  it("json_object-відповідь НЕ тієї форми → repair → OutputInvalidError (контроль: схема справді перевіряється, сервер json_object її не гарантує)", async () => {
    const { p, calls } = mk([rejectSchema, { status: 200, body: ollamaOk('{"wrong":1}') }, { status: 200, body: ollamaOk('{"wrong":2}') }]);
    await expect(client(p).call(tinyReq(), Tiny)).rejects.toBeInstanceOf(OutputInvalidError);
    expect(calls).toHaveLength(3);        // 1 відхилений формат + 2 виклики (основний + один repair)
  });
  it("невалідний JSON → repair-повтор → валідна відповідь проходить", async () => {
    const { p, calls } = mk([{ status: 200, body: ollamaOk("{oops") }, { status: 200, body: ollamaOk('{"answer":"fixed"}') }]);
    const r = await client(p).call(tinyReq(), Tiny);
    expect(r.value).toEqual({ answer: "fixed" });
    expect(calls).toHaveLength(2);
  });
});

describe("вибір режиму: конфіг і фабрика", () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), "rp-"));
  it("openai_compatible → chat (потрібні OPENAI_BASE_URL і LLM_MODEL; ключ необов'язковий)", () => {
    expect(resolveConfig({ LLM_PROVIDER: "openai_compatible", OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", LLM_MODEL: "m" })).toMatchObject({ provider: "openai", openai_api_mode: "chat", llm_mode: "live" });
    expect(() => resolveConfig({ LLM_PROVIDER: "openai_compatible", LLM_MODEL: "m" })).toThrow(/OPENAI_BASE_URL/);
    expect(() => resolveConfig({ LLM_PROVIDER: "openai_compatible", OPENAI_BASE_URL: "http://h/v1" })).toThrow(/LLM_MODEL/);
  });
  it("openai: без бази або api.openai.com → responses; чужа база (так приходить BYO openai_compatible) → chat; OPENAI_API_MODE перемагає; сміття → ConfigError", () => {
    const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: KEY, LLM_MODEL: "m" };
    expect(resolveConfig(base).openai_api_mode).toBe("responses");
    expect(resolveConfig({ ...base, OPENAI_BASE_URL: "https://api.openai.com/v1" }).openai_api_mode).toBe("responses");
    expect(resolveConfig({ ...base, OPENAI_BASE_URL: "http://localhost:1234/v1" }).openai_api_mode).toBe("chat");
    expect(resolveConfig({ ...base, OPENAI_BASE_URL: "http://localhost:1234/v1", OPENAI_API_MODE: "responses" }).openai_api_mode).toBe("responses");
    expect(resolveConfig({ ...base, OPENAI_API_MODE: "chat" }).openai_api_mode).toBe("chat");
    expect(resolveConfig({ LLM_PROVIDER: "openai_compatible", OPENAI_BASE_URL: "http://h/v1", LLM_MODEL: "m", OPENAI_API_MODE: "responses" }).openai_api_mode).toBe("responses");
    expect(() => resolveConfig({ ...base, OPENAI_API_MODE: "grpc" })).toThrow(ConfigError);
    expect(resolveConfig({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", LLM_MODEL: "m" }).openai_api_mode).toBeUndefined();
  });
  it("createClientFromEnv: BYO-оверлей (openai + base + local-no-key) іде на /v1/chat/completions; явний responses — на /v1/responses без дубля /v1", async () => {
    const m1 = mockFetch([{ status: 200, body: ollamaOk('{"answer":"hi"}') }]);
    const { client } = createClientFromEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "local-no-key", OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", LLM_MODEL: "qwen-local" }, { fetchImpl: m1.fetchImpl, replayDir: dir(), sleep: noSleep });
    await client.call(tinyReq(), Tiny);
    expect(m1.calls[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(m1.calls[0]!.headers.authorization).toBe("Bearer local-no-key");
    const m2 = mockFetch([{ status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text: '{"answer":"hi"}' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }]);
    const r = createClientFromEnv({ LLM_PROVIDER: "openai_compatible", OPENAI_BASE_URL: "http://gw:9000/v1", OPENAI_API_MODE: "responses", LLM_MODEL: "m" }, { fetchImpl: m2.fetchImpl, replayDir: dir(), sleep: noSleep });
    await r.client.call(tinyReq(), Tiny);
    expect(m2.calls[0]!.url).toBe("http://gw:9000/v1/responses");
    expect(m2.calls[0]!.headers.authorization).toBe("Bearer local-no-key");   // без ключа — заглушка, не "undefined"
  });
  it("openAiEndpoint і Responses-адаптер: api.openai.com за замовчуванням незмінний", () => {
    expect(openAiEndpoint(undefined, "responses")).toBe("https://api.openai.com/v1/responses");
    expect(openAiEndpoint("http://h/v1/", "chat/completions")).toBe("http://h/v1/chat/completions");
    expect(new OpenAiProvider({ apiKey: "k", model: "m" }).name).toBe("openai");
  });
});
