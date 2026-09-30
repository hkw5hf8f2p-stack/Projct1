import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnthropicProvider, ConfigError, DirStore, OpenAiProvider, ProviderHttpError, ProviderTimeoutError, ReplayCache, createClientFromEnv, createLogger, resolveConfig, countSecretHits, redact,
} from "../src/index.js";
import { REPLAY_DIR, Tiny, mockFetch, noSleep, tinyReq } from "./helpers.js";

const KEY_A = "sk-ant-api03-SECRETSECRETSECRET1234";
const KEY_O = "sk-proj-OPENAISECRETSECRET5678";
const anthropicOk = { content: [{ type: "tool_use", name: "tiny", input: { answer: "hi" } }], usage: { input_tokens: 11, output_tokens: 7 } };
const openaiOk = { output: [{ type: "message", content: [{ type: "output_text", text: '{"answer":"hi"}' }] }], usage: { input_tokens: 12, output_tokens: 8 } };
const mk = (kind: "anthropic" | "openai", replies: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) => {
  const m = mockFetch(replies);
  const cfg = { apiKey: kind === "anthropic" ? KEY_A : KEY_O, model: "model-from-env", fetchImpl: m.fetchImpl, sleep: noSleep, ...extra };
  return { ...m, p: kind === "anthropic" ? new AnthropicProvider(cfg) : new OpenAiProvider(cfg) };
};

describe.each(["anthropic", "openai"] as const)("адаптер %s: контракт на мок-HTTP", (kind) => {
  const ok = kind === "anthropic" ? anthropicOk : openaiOk;
  it("форма запиту: модель з конфігу, ключ у заголовку, схема виходу, без temperature за замовчуванням", async () => {
    const { p, calls } = mk(kind, [{ status: 200, body: ok }]);
    const r = await p.complete(tinyReq());
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.body.model).toBe("model-from-env");
    expect("temperature" in c.body).toBe(false);
    expect("top_p" in c.body).toBe(false);
    if (kind === "anthropic") {
      expect(c.url).toBe("https://api.anthropic.com/v1/messages");
      expect(c.headers["x-api-key"]).toBe(KEY_A);
      expect(c.headers["anthropic-version"]).toBeTruthy();
      expect(c.body.tool_choice).toEqual({ type: "tool", name: "tiny" });
      expect((c.body.tools as Array<{ input_schema: { additionalProperties: boolean } }>)[0]!.input_schema.additionalProperties).toBe(false);
      expect(c.body.max_tokens).toBe(100);
    } else {
      expect(c.url).toBe("https://api.openai.com/v1/responses");
      expect(c.headers.authorization).toBe(`Bearer ${KEY_O}`);
      expect((c.body.text as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: "json_schema", strict: true });
      expect(c.body.max_output_tokens).toBe(100);
    }
    expect(r.json).toEqual({ answer: "hi" });
    expect(r.input_tokens).toBeGreaterThan(0);
    expect(r.output_tokens).toBeGreaterThan(0);
    expect(r.model).toBe("model-from-env");
    expect(r.temperature_dropped).toBe(false);
  });

  it("зображення йдуть як base64 з перевіркою хешу (підміна байтів → помилка)", async () => {
    const { p, calls } = mk(kind, [{ status: 200, body: ok }]);
    const { sha256 } = await import("../src/index.js");
    const b64 = Buffer.from("png-bytes").toString("base64");
    await p.complete(tinyReq({ content: [{ type: "text", text: "x" }, { type: "image", media_type: "image/png", sha256: sha256("png-bytes"), data_b64: b64 }] }));
    expect(JSON.stringify(calls[0]!.body)).toContain(b64);
    const bad = mk(kind, [{ status: 200, body: ok }]);
    await expect(bad.p.complete(tinyReq({ content: [{ type: "image", media_type: "image/png", sha256: "0".repeat(64), path: path.join(REPLAY_DIR, "hostile/cases.json") }] }))).rejects.toThrow(ConfigError);
    expect(bad.calls).toHaveLength(0);
  });

  it("429 → повтор із паузою → успіх (Retry-After поважається)", async () => {
    const sleeps: number[] = [];
    const { p, calls } = mk(kind, [{ status: 429, body: "rate", headers: { "retry-after": "2" } }, { status: 200, body: ok }], { sleep: async (ms: number) => { sleeps.push(ms); } });
    const r = await p.complete(tinyReq());
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(r.json).toEqual({ answer: "hi" });
  });

  it("5xx стабільно → після maxRetries помилка retriable, кількість спроб = 1 + maxRetries", async () => {
    const { p, calls } = mk(kind, [{ status: 503, body: "down" }], { maxRetries: 2 });
    const e = await p.complete(tinyReq()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(e.status).toBe(503);
    expect(e.retriable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("4xx (не 429, не temperature) не повторюється", async () => {
    const { p, calls } = mk(kind, [{ status: 401, body: "bad key" }]);
    const e = await p.complete(tinyReq()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(e.retriable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("таймаут: реальний AbortSignal.timeout → ProviderTimeoutError після повторів", async () => {
    const hang = async (_u: string, init: { signal?: AbortSignal }) => new Promise<never>((_res, rej) => { init.signal?.addEventListener("abort", () => rej(init.signal?.reason)); });
    const p = kind === "anthropic"
      ? new AnthropicProvider({ apiKey: KEY_A, model: "m", fetchImpl: hang as never, timeoutMs: 20, maxRetries: 1, sleep: noSleep })
      : new OpenAiProvider({ apiKey: KEY_O, model: "m", fetchImpl: hang as never, timeoutMs: 20, maxRetries: 1, sleep: noSleep });
    await expect(p.complete(tinyReq())).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("мережева помилка → ProviderHttpError без повтору, ключ відредаговано", async () => {
    const { p } = mk(kind, [{ throw: { name: "Error", message: `connect ECONNREFUSED with key ${kind === "anthropic" ? KEY_A : KEY_O}` } }]);
    const e = await p.complete(tinyReq()).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(String(e.message)).not.toContain(kind === "anthropic" ? KEY_A : KEY_O);
  });

  it("temperature задано, провайдер відповів 400 «temperature» → повтор БЕЗ temperature, прапорець temperature_dropped", async () => {
    const { p, calls } = mk(kind, [
      (c) => ("temperature" in c.body ? { status: 400, body: { error: { message: "`temperature` is not supported for this model" } } } : { status: 200, body: ok }),
    ]);
    const r = await p.complete(tinyReq({ sampling: { max_tokens: 100, temperature: 0 } }));
    expect(calls).toHaveLength(2);
    expect("temperature" in calls[0]!.body).toBe(true);
    expect("temperature" in calls[1]!.body).toBe(false);
    expect(r.temperature_dropped).toBe(true);
  });

  it("temperature задано, провайдер його ПРИЙМАЄ → надсилається, повтору немає (обидва варіанти поведінки)", async () => {
    const { p, calls } = mk(kind, [{ status: 200, body: ok }]);
    const r = await p.complete(tinyReq({ sampling: { max_tokens: 100, temperature: 0 } }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.temperature).toBe(0);
    expect(r.temperature_dropped).toBe(false);
  });

  it("400 БЕЗ згадки temperature при заданому temperature — не маскується повтором", async () => {
    const { p, calls } = mk(kind, [{ status: 400, body: { error: { message: "invalid image" } } }]);
    const e = await p.complete(tinyReq({ sampling: { max_tokens: 100, temperature: 0 } })).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(calls).toHaveLength(1);
  });

  it("невалідна форма відповіді → гучна помилка, а не порожній результат", async () => {
    const { p } = mk(kind, [{ status: 200, body: { unexpected: true } }]);
    await expect(p.complete(tinyReq())).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

it("anthropic: текст замість tool_use → json=null + raw_text (піде в repair, не в тихий успіх)", async () => {
  const { p } = mk("anthropic", [{ status: 200, body: { content: [{ type: "text", text: "sorry" }], usage: { input_tokens: 1, output_tokens: 1 } } }]);
  const r = await p.complete(tinyReq());
  expect(r.json).toBeNull();
  expect(r.raw_text).toBe("sorry");
});
it("openai: невалідний JSON у output_text → json=null + raw_text", async () => {
  const { p } = mk("openai", [{ status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text: "{oops" }] }], usage: {} } }]);
  const r = await p.complete(tinyReq());
  expect(r.json).toBeNull();
  expect(r.raw_text).toBe("{oops");
});

describe("конфіг: модель і провайдер лише з env, без хардкоду", () => {
  it("LLM_MODEL іде в запит дослівно; без LLM_MODEL при живому провайдері — ConfigError", async () => {
    const m = mockFetch([{ status: 200, body: anthropicOk }]);
    const { client, config } = createClientFromEnv({ ANTHROPIC_API_KEY: KEY_A, LLM_MODEL: "zzz-model-42" }, { fetchImpl: m.fetchImpl, replayDir: mkdtempSync(path.join(os.tmpdir(), "rp-")), sleep: noSleep });
    expect(config).toMatchObject({ llm_mode: "live", provider: "anthropic", model: "zzz-model-42" });
    await client.call(tinyReq(), Tiny);
    expect(m.calls[0]!.body.model).toBe("zzz-model-42");
    expect(() => resolveConfig({ ANTHROPIC_API_KEY: KEY_A })).toThrow(/LLM_MODEL/);
  });
  it("провайдер за замовчуванням = той, чий ключ є; обидва → anthropic; жодного → none; явний без ключа → помилка", () => {
    expect(resolveConfig({ OPENAI_API_KEY: KEY_O, LLM_MODEL: "m" }).provider).toBe("openai");
    expect(resolveConfig({ OPENAI_API_KEY: KEY_O, ANTHROPIC_API_KEY: KEY_A, LLM_MODEL: "m" }).provider).toBe("anthropic");
    expect(resolveConfig({}).llm_mode).toBe("none");
    expect(() => resolveConfig({ LLM_PROVIDER: "openai", LLM_MODEL: "m" })).toThrow(ConfigError);
    expect(() => resolveConfig({ LLM_PROVIDER: "gpt" })).toThrow(ConfigError);
  });
  it("replay заборонено в production (G0-2), дозволено в dev/test", () => {
    expect(() => resolveConfig({ LLM_PROVIDER: "replay", NODE_ENV: "production" })).toThrow(/production/);
    expect(resolveConfig({ LLM_PROVIDER: "replay" }).llm_mode).toBe("replay");
  });
  it("у коді пакета немає жодного імені моделі (claude-*, gpt-*, o1/o3…)", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "test") walk(f); } else if (f.endsWith(".ts")) files.push(f); } };
    walk(path.resolve(REPLAY_DIR, "../../packages/llm"));
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => /(?<![\w-])(claude-(?!cli\b)[a-z0-9]|gpt-[0-9a-z]|gemini-|opus-?[0-9]|sonnet-?[0-9]|haiku-?[0-9])/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("секрети: 0 у логах, помилках, записах, кеші", () => {
  it("ключ, який провайдер «луною» повертає в тілі помилки й у мережевій помилці, не потрапляє в лог/помилку/кеш/records", async () => {
    const lines: string[] = [];
    const logger = createLogger((l) => lines.push(l), [KEY_A]);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sec-"));
    const bad = mockFetch([{ status: 401, body: `invalid x-api-key ${KEY_A}` }]);
    const env = { ANTHROPIC_API_KEY: KEY_A, LLM_MODEL: "m" };
    const one = createClientFromEnv(env, { fetchImpl: bad.fetchImpl, replayDir: dir, logger, sleep: noSleep });
    const err = (await one.client.call(tinyReq(), Tiny).catch((e) => e)) as Error;
    expect(String(err.message)).not.toContain(KEY_A);
    expect(JSON.stringify(err)).not.toContain(KEY_A);
    // невалідний вихід → repair → warn у лог; у виході ключ теж «луною»
    const echo = mockFetch([{ status: 200, body: { content: [{ type: "tool_use", name: "tiny", input: { wrong: KEY_A } }], usage: { input_tokens: 1, output_tokens: 1 } } }]);
    const two = createClientFromEnv(env, { fetchImpl: echo.fetchImpl, replayDir: dir, logger, sleep: noSleep });
    await two.client.call(tinyReq(), Tiny).catch(() => undefined);
    logger.warn("ключ у діагностиці", { hdr: `x-api-key: ${KEY_A}`, auth: `Bearer ${KEY_O}` });
    expect(lines.length).toBeGreaterThan(0);
    expect(countSecretHits(lines.join("\n"), [KEY_A, KEY_O])).toBe(0);
    expect(lines.join("\n")).toContain("[REDACTED]");
    // артефакти кешу на диску
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of all(dir)) expect(countSecretHits(readFileSync(f, "utf8"), [KEY_A])).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
  it("запис кешу успішного виклику не містить ні ключа, ні заголовків, ні байтів зображень", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sec2-"));
    const m = mockFetch([{ status: 200, body: anthropicOk }]);
    const { client } = createClientFromEnv({ ANTHROPIC_API_KEY: KEY_A, LLM_MODEL: "m" }, { fetchImpl: m.fetchImpl, replayDir: dir });
    const { sha256 } = await import("../src/index.js");
    const b64 = Buffer.from("secret-pixels").toString("base64");
    await client.call(tinyReq({ content: [{ type: "text", text: "x" }, { type: "image", media_type: "image/png", sha256: sha256("secret-pixels"), data_b64: b64 }] }), Tiny);
    const files = readdirSync(path.join(dir, "default"));
    expect(files).toHaveLength(1);
    const txt = readFileSync(path.join(dir, "default", files[0]!), "utf8");
    expect(txt).not.toContain(KEY_A);
    expect(txt).not.toContain(b64);
    expect(txt.toLowerCase()).not.toContain("x-api-key");
    rmSync(dir, { recursive: true, force: true });
  });
  it("redact: шаблони sk-ant-/sk-/Bearer знищуються навіть без знання ключа (контроль, що фільтр уміє спрацювати)", () => {
    expect(redact("k=sk-ant-abcdef123456 and Bearer abcdefghij123 and sk-proj-abcdefghijkl12")).not.toMatch(/abcdef123456|abcdefghij123|abcdefghijkl12/);
    expect(redact("звичайний текст без ключів")).toBe("звичайний текст без ключів");
  });
  it("у коді немає читання process.env поза scripts (ключі йдуть лише параметром env)", () => {
    const src = readFileSync(path.resolve(REPLAY_DIR, "../../packages/llm/src/config.ts"), "utf8");
    expect(src).not.toMatch(/process\.env/);
  });
});

it("DirStore read-only (replay) не дозволяє запис", () => {
  const c = new ReplayCache(new DirStore(REPLAY_DIR, true), "x");
  expect(() => c.put("k", { key: "k" } as never)).toThrow(/read-only/);
});
