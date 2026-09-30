import { z } from "zod";
import { BehavioralLens, LENS_VARIABLES } from "@sitelens/schemas";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LlmClient, MemoryStore, ReplayCache, TokenBudget, zodToJsonSchema, type FetchLike, type LlmRequest, type LlmProvider, type ProviderResult } from "../src/index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SHOP_ARTIFACTS = path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix/shop");
export const REPLAY_DIR = path.join(ROOT, "fixtures/replay");
export const ARTIFACT_DIR = path.join(ROOT, "planning/qa/artifacts/sprint-3");

export const Tiny = z.object({ answer: z.string().min(1) }).strict();
export const tinyReq = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  stage: "site_profile", prompt_id: "site-profile-v1", system: "system text", content: [{ type: "text", text: "hello" }],
  output: { name: "tiny", description: "d", json_schema: zodToJsonSchema(Tiny) }, sampling: { max_tokens: 100 },
  logical_key: { prompt_id: "site-profile-v1", step: 0 }, ...over,
});

export interface MockCall { url: string; headers: Record<string, string>; body: Record<string, unknown> }
export type MockReply = { status: number; body: unknown; headers?: Record<string, string> } | { throw: { name: string; message?: string } } | ((c: MockCall) => { status: number; body: unknown } | { throw: { name: string } });
export function mockFetch(replies: MockReply[]): { fetchImpl: FetchLike; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const call: MockCall = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    let r = replies[Math.min(i++, replies.length - 1)] as MockReply;
    if (typeof r === "function") r = r(call);
    if ("throw" in r) throw Object.assign(new Error(r.throw.message ?? r.throw.name), { name: r.throw.name });
    const h = r.headers ?? {};
    return { status: r.status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fetchImpl, calls };
}
export const noSleep = async () => {};

/** провайдер-лічильник: повертає задану відповідь і рахує виклики */
export class CountingProvider implements LlmProvider {
  calls = 0;
  constructor(readonly name: "anthropic" | "openai" | "fake" = "anthropic", readonly model = "test-model", private readonly json: unknown = { answer: "ok" }) {}
  async complete(): Promise<ProviderResult> {
    this.calls++;
    return { json: this.json, input_tokens: 10, output_tokens: 5, provider: this.name, model: this.model, latency_ms: 1 };
  }
}
export const liveClient = (provider: LlmProvider, store = new MemoryStore(), ns = "t", cache_mode: "use" | "bypass" = "use", max = 1_000_000) => {
  const cache = new ReplayCache(store, ns);
  return { client: new LlmClient({ mode: "live", provider, cache, cache_mode, budget: new TokenBudget(max) }), cache, store };
};

export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r2 = (x: number) => Math.round(x * 100) / 100;

/** випадковий набір кандидатів; вигадані цілі різні, щоб дедуплікація не з'їдала набір */
export function randomLenses(seed: number, n = 18): BehavioralLens[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => BehavioralLens.parse({
    id: `l${String(i + 1).padStart(2, "0")}`, audit_run_id: "run_test", name: `Лінза ${i + 1}`, description: `Опис ${i + 1}`,
    ...Object.fromEntries(LENS_VARIABLES.map((k) => [k, r2(r())])), primary_goal: `Мета ${seed} ${i} ${Math.floor(r() * 1e6)}`, likely_questions: [], likely_objections: [],
  }));
}

/** набір, де генератор виконав вимогу промпту: усі сім полюсів присутні серед кандидатів (лінзи 1–7 — представники полюсів) */
export function poleSeededLenses(seed: number): BehavioralLens[] {
  const base = randomLenses(seed, 18);
  const r = rng(seed * 31 + 7);
  const patch: Array<Record<string, number>> = [
    { category_knowledge: r2(r() * 0.3) }, { category_knowledge: r2(0.7 + r() * 0.3) }, { price_sensitivity: r2(0.7 + r() * 0.3) }, { price_sensitivity: r2(r() * 0.3) },
    { decision_speed: r2(0.7 + r() * 0.3), detail_preference: r2(r() * 0.5) }, { decision_speed: r2(r() * 0.3), detail_preference: r2(0.6 + r() * 0.4) }, { trust_requirement: r2(0.7 + r() * 0.3) },
  ];
  return base.map((l, i) => (i < 7 ? BehavioralLens.parse({ ...l, ...patch[i] }) : l));
}

