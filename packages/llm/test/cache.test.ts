import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LlmClient, MemoryStore, ReplayCache, ReplayMissError, ScriptedFakeProvider, TokenBudget, cacheKey, sha256, type ImagePart, type LlmRequest } from "../src/index.js";
import { CountingProvider, Tiny, liveClient, mockFetch, tinyReq } from "./helpers.js";

const img = (bytes: string): ImagePart => ({ type: "image", media_type: "image/png", sha256: sha256(bytes), data_b64: Buffer.from(bytes).toString("base64") });
const withImg = (bytes: string) => tinyReq({ content: [{ type: "text", text: "hello" }, img(bytes)] });
const ID = { provider: "anthropic", model: "m1" };

describe("ключ E5 (record/replay): 100 % інвалідація", () => {
  const base = withImg("pixels-A");
  const k0 = cacheKey(ID, base);
  const variants: Array<[string, () => string]> = [
    ["зображення: один байт", () => cacheKey(ID, withImg("pixels-B"))],
    ["ID промпту", () => cacheKey(ID, { ...base, prompt_id: "site-profile-v2" })],
    ["system-текст", () => cacheKey(ID, { ...base, system: base.system + "." })],
    ["текстова частина", () => cacheKey(ID, { ...base, content: [{ type: "text", text: "hello!" }, ...base.content.slice(1)] })],
    ["порядок частин", () => cacheKey(ID, { ...base, content: [...base.content].reverse() })],
    ["схема виходу", () => cacheKey(ID, { ...base, output: { ...base.output, json_schema: { type: "object", properties: {} } } })],
    ["модель", () => cacheKey({ ...ID, model: "m2" }, base)],
    ["провайдер", () => cacheKey({ ...ID, provider: "openai" }, base)],
    ["семплінг: max_tokens", () => cacheKey(ID, { ...base, sampling: { max_tokens: 101 } })],
    ["семплінг: temperature", () => cacheKey(ID, { ...base, sampling: { max_tokens: 100, temperature: 0 } })],
  ];
  it.each(variants)("зміна «%s» → інший ключ", (_n, f) => expect(f()).not.toBe(k0));
  it("контроль: ідентичний запит → той самий ключ; logical_key і stage НЕ входять у ключ E5", () => {
    expect(cacheKey(ID, withImg("pixels-A"))).toBe(k0);
    expect(cacheKey(ID, { ...base, logical_key: { prompt_id: "x", step: 9 }, stage: "tasks" })).toBe(k0);
  });
  it("усі десять ключів попарно різні (жодних колізій між варіантами)", () => {
    expect(new Set([k0, ...variants.map(([, f]) => f())]).size).toBe(variants.length + 1);
  });
});

describe("record/replay-кеш (б): use / bypass / namespace / промах", () => {
  it("однаковий запит → влучання, 0 викликів провайдера; токени рахуються", async () => {
    const p = new CountingProvider();
    const { client, cache } = liveClient(p);
    await client.call(withImg("A"), Tiny);
    await client.call(withImg("A"), Tiny);
    expect(p.calls).toBe(1);
    expect(cache.counters()).toMatchObject({ hits: 1, misses: 1, writes: 1 });
    expect(client.records.map((r) => r.source)).toEqual(["provider", "cache"]);
  });
  it("зміна ОДНОГО байта скриншота → ПРОМАХ, провайдера викликано знову", async () => {
    const p = new CountingProvider();
    const { client, cache } = liveClient(p);
    await client.call(withImg("pixels-A"), Tiny);
    await client.call(withImg("pixels-B"), Tiny);
    expect(p.calls).toBe(2);
    expect(cache.counters().hits).toBe(0);
  });
  it("cache_mode=bypass → 0 читань кешу (лічильник), провайдер щоразу; кеш не наповнюється", async () => {
    const p = new CountingProvider();
    const { client, cache } = liveClient(p, new MemoryStore(), "t", "bypass");
    for (let i = 0; i < 3; i++) await client.call(withImg("A"), Tiny);
    expect(cache.reads).toBe(0);
    expect(cache.writes).toBe(0);
    expect(p.calls).toBe(3);
    expect(client.budget.cache_read_tokens).toBe(0);
  });
  it("контроль bypass: той самий сценарій у режимі use ДАЄ читання (лічильник уміє бути ≠ 0)", async () => {
    const { client, cache } = liveClient(new CountingProvider());
    await client.call(withImg("A"), Tiny);
    expect(cache.reads).toBeGreaterThan(0);
  });
  it("namespace: запис в одному прогоні не видно з іншого (E2 / G0-8)", async () => {
    const store = new MemoryStore();
    const p = new CountingProvider();
    await liveClient(p, store, "run1").client.call(withImg("A"), Tiny);
    await liveClient(p, store, "run1").client.call(withImg("A"), Tiny);
    expect(p.calls).toBe(1);
    await liveClient(p, store, "run2").client.call(withImg("A"), Tiny);
    expect(p.calls).toBe(2);
  });
  it("replay: промах = ReplayMissError, живий провайдер/мережа НЕ викликаються ніколи", async () => {
    const store = new MemoryStore();
    const cache = new ReplayCache(store, "t");
    const client = new LlmClient({ mode: "replay", cache, cache_identity: ID, budget: new TokenBudget(10_000) });
    const m = mockFetch([{ status: 200, body: {} }]);
    await expect(client.call(tinyReq(), Tiny)).rejects.toBeInstanceOf(ReplayMissError);
    expect(m.calls).toHaveLength(0);
    expect(client.records).toHaveLength(0);
  });
  it("replay + cache_mode=bypass — конфігураційна помилка, не тихе «ніщо»", () => {
    expect(() => new LlmClient({ mode: "replay", cache: new ReplayCache(new MemoryStore(), "t"), cache_mode: "bypass", budget: new TokenBudget(10) })).toThrow(/bypass/);
  });
  it("НЕвалідна відповідь не потрапляє в кеш (лише валідована); повтор іде в провайдера знову", async () => {
    const bad = new CountingProvider("anthropic", "m", { wrong: 1 });
    const { client, cache, store } = liveClient(bad);
    await expect(client.call(tinyReq(), Tiny)).rejects.toThrow(/invalid/);
    expect(bad.calls).toBe(2); // основний + один repair
    expect(cache.writes).toBe(0);
    expect((store as MemoryStore).data.size).toBe(0);
  });
  it("repair: перша відповідь погана, друга добра → 2 виклики, у кеші лише добра, значення повертається", async () => {
    let n = 0;
    const p = new CountingProvider();
    p.complete = async () => { n++; return { json: n === 1 ? { nope: 1 } : { answer: "fixed" }, input_tokens: 5, output_tokens: 5, provider: "anthropic", model: "m", latency_ms: 1 }; };
    const { client, cache } = liveClient(p);
    const r = await client.call(tinyReq(), Tiny);
    expect(r.value.answer).toBe("fixed");
    expect(r.calls.map((c) => c.status)).toEqual(["invalid", "ok"]);
    expect(cache.writes).toBe(1);
  });
  it("токени з кешу входять у лічильник бюджету, але не в billed", async () => {
    const { client } = liveClient(new CountingProvider());
    await client.call(withImg("A"), Tiny);
    await client.call(withImg("A"), Tiny);
    const b = client.budget;
    expect(b.used).toBe(30);
    expect(b.billed_tokens).toBe(15);
    expect(b.cache_read_tokens).toBe(15);
  });
  it("секрет, який модель «відлунила» у валідній відповіді, вилучається із запису кешу й CallRecord", async () => {
    const KEY = "sk-ant-api03-ECHOECHOECHO9999";
    const p = new CountingProvider("anthropic", "m", { answer: `key is ${KEY}` });
    const store = new MemoryStore();
    const client = new LlmClient({ mode: "live", provider: p, cache: new ReplayCache(store, "t"), budget: new TokenBudget(1e6), secrets: [KEY] });
    await client.call(tinyReq(), Tiny);
    expect(JSON.stringify([...store.data.values()])).not.toContain(KEY);
    expect(JSON.stringify(client.records)).not.toContain(KEY);
  });
});

describe("розрізнення механізмів (G0-16, критерій 9): scripted fake ≠ record/replay", () => {
  const script = () => ScriptedFakeProvider.from([[{ prompt_id: "site-profile-v1", step: 0 }, { response: { answer: "scripted" } }]]);
  it("той самий запит зі зміненим байтом скриншота: fake ВЛУЧАЄ (відповідь та сама), record/replay ПРОМАХУЄ", async () => {
    // (а) scripted fake: логічний ключ, пікселі не впливають
    const fake = script();
    const fc = new LlmClient({ mode: "fake", provider: fake, budget: new TokenBudget(1e6) });
    const a1 = await fc.call(withImg("pixels-A"), Tiny);
    const a2 = await fc.call(withImg("pixels-B"), Tiny);
    expect(a1.value).toEqual(a2.value);
    expect(a2.calls[0]!.source).toBe("fake");
    expect(a2.calls[0]!.synthetic).toBe(true);
    // (б) record/replay: повний ключ E5
    const p = new CountingProvider();
    const { client } = liveClient(p);
    await client.call(withImg("pixels-A"), Tiny);
    await client.call(withImg("pixels-B"), Tiny);
    expect(p.calls).toBe(2);
    expect(client.records.map((r) => r.source)).toEqual(["provider", "provider"]);
    // і в replay-режимі зміна байта → гучний промах, у fake — ні
    const store = new MemoryStore();
    await liveClient(new CountingProvider(), store, "t").client.call(withImg("pixels-A"), Tiny);
    const rc = new LlmClient({ mode: "replay", cache: new ReplayCache(store, "t"), cache_identity: { provider: "anthropic", model: "test-model" }, budget: new TokenBudget(1e6) });
    await expect(rc.call(withImg("pixels-B"), Tiny)).rejects.toBeInstanceOf(ReplayMissError);
    await expect(rc.call(withImg("pixels-A"), Tiny)).resolves.toBeTruthy();
  });
  it("fake: відсутній логічний ключ → гучна помилка (жодного фолбеку); інший lens_id/task_id/step = інший ключ", async () => {
    const fc = new LlmClient({ mode: "fake", provider: script(), budget: new TokenBudget(1e6) });
    for (const lk of [{ step: 1 }, { lens_id: "l1" }, { task_id: "t1" }, { page_url: "http://x/" }]) {
      await expect(fc.call(tinyReq({ logical_key: { prompt_id: "site-profile-v1", step: 0, ...lk } }), Tiny)).rejects.toBeInstanceOf(ReplayMissError);
    }
  });
  it("fake не пише й не читає кеш E5 (немає ключа E5 → немає влучань)", async () => {
    const cache = new ReplayCache(new MemoryStore(), "t");
    const fc = new LlmClient({ mode: "fake", provider: script(), cache, budget: new TokenBudget(1e6) });
    await fc.call(tinyReq(), Tiny);
    expect(cache.reads).toBe(0);
    expect(cache.writes).toBe(0);
  });
  it("0 тестів у (а) залежать від пікселів: код scripted fake не читає ImagePart (ні sha256, ні байтів, ні path)", () => {
    const src = readFileSync(new URL("../src/providers/scripted-fake.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/sha256|data_b64|readFile|\.path\b|type === "image"|ImagePart/);
    // і файл тестів, що ганяє fake на етапах, не імпортує helper-и зображень
  });
  it("логічний ключ включає repair-спробу: #r1 відрізняється від основного виклику", async () => {
    const fake = ScriptedFakeProvider.from([
      [{ prompt_id: "site-profile-v1", step: 0 }, { response: { bad: true } }],
      [{ prompt_id: "site-profile-v1", step: 0, attempt: 1 }, { response: { answer: "repaired" } }],
    ]);
    const r = await new LlmClient({ mode: "fake", provider: fake, budget: new TokenBudget(1e6) }).call(tinyReq(), Tiny);
    expect(r.value.answer).toBe("repaired");
    expect(fake.received).toEqual(["site-profile-v1||||0", "site-profile-v1||||0#r1"]);
  });
});
export type { LlmRequest };
