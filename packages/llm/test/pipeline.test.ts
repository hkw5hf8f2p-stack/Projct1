import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuditRun } from "@sitelens/schemas";
import {
  AnthropicProvider, NO_LLM_BANNER, buildNoLlmReportStub, createClientFromEnv, loadPagesFromArtifacts, runLlmStages, toAuditRunRecord, type PageInput,
} from "../src/index.js";
import { NetGuard, noProviderTraffic } from "../src/testing/net-guard.js";
import { SHOP_NAMESPACE } from "../src/testing/synthetic-shop.js";
import { ARTIFACT_DIR, REPLAY_DIR, SHOP_ARTIFACTS, tinyReq } from "./helpers.js";
import { recordShop } from "../../../scripts/llm-replay-record.js";

let pages: PageInput[];
beforeAll(() => { pages = loadPagesFromArtifacts(SHOP_ARTIFACTS); });
const guards: NetGuard[] = [];
afterEach(() => { for (const g of guards.splice(0)) g.uninstall(); });
const REPLAY_ENV = { LLM_PROVIDER: "replay" };

describe("інтеграційний прогін етапів на replay (критерій 1)", () => {
  it("fixtures/shop: 4 етапи done; 100 % LLM-викликів із кешу; 0 звернень до провайдерів за МЕРЕЖЕВИМ ЖУРНАЛОМ", async () => {
    const guard = new NetGuard().install();
    guards.push(guard);
    const { client, config } = createClientFromEnv(REPLAY_ENV, { replayDir: REPLAY_DIR, namespace: SHOP_NAMESPACE });
    const r = await runLlmStages({ audit_run_id: "run_shop", client, pages, llm_mode: config.llm_mode });
    guard.uninstall();
    expect(config.llm_mode).toBe("replay");
    expect(Object.values(r.stage_status).map((s) => s?.status)).toEqual(["done", "done", "done", "done"]);
    expect(r.language).toBe("uk");
    // 100 % з кешу
    expect(client.records).toHaveLength(3);
    expect(client.records.every((c) => c.source === "cache" && c.synthetic)).toBe(true);
    expect(r.budget.billed_tokens).toBe(0);
    expect(r.budget.cache_read_tokens).toBe(r.budget.total_tokens);
    // мережа: журнал, а не прапорець
    expect(noProviderTraffic(guard)).toBe(true);
    expect(guard.providerHits()).toEqual([]);
    expect(guard.nonLoopback()).toEqual([]);
    expect(guard.events.filter((e) => e.kind === "fetch")).toEqual([]);
    // збережені об'єкти
    const st = r.stored as { profile: { prompt_version: string; customer_tasks: unknown[] }; lenses: { lenses: unknown[] }; scenarios: unknown[]; journals: unknown[] };
    expect(st.profile.prompt_version).toBe("site-profile-v1");
    expect(st.profile.customer_tasks.length).toBeGreaterThanOrEqual(4);
    expect(st.lenses.lenses).toHaveLength(12);
    expect(st.scenarios).toHaveLength(30);
    expect(st.journals).toHaveLength(8);
    expect(r.stages.scenario_matrix.flags.filter((f) => f.startsWith("violation:"))).toEqual([]);
    // кожен вихід має prompt_id; llm_calls (§35) валідуються схемою
    for (const c of client.records) expect(client.toLlmCall(c, "run_shop", c.stage as never).prompt_version).toMatch(/-v1$/);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(path.join(ARTIFACT_DIR, "replay-run-network-log.json"), JSON.stringify({
      run: "fixtures/shop на replay (SYNTHETIC відповіді, namespace " + SHOP_NAMESPACE + ")",
      llm_calls: client.records.length, from_cache: client.records.filter((c) => c.source === "cache").length,
      net_events: guard.events, provider_hits: guard.providerHits().length, non_loopback_events: guard.nonLoopback().length,
      hooks: "dns.lookup + net.Socket.connect + globalThis.fetch", budget: r.budget, stage_status: r.stage_status,
      records: client.records.map((c) => ({ call_id: c.call_id, prompt_id: c.prompt_id, source: c.source, synthetic: c.synthetic, request_hash: c.request_hash.slice(0, 16), tokens: c.input_tokens + c.output_tokens })),
    }, null, 2) + "\n");
  });

  it("КОНТРОЛЬ предиката: живий адаптер, що звертається до api.anthropic.com (→ мок-сервер 127.0.0.1) ПОРУШУЄ noProviderTraffic", async () => {
    const server = http.createServer((_q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ content: [{ type: "tool_use", input: { answer: "x" } }], usage: { input_tokens: 1, output_tokens: 1 } })); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const guard = new NetGuard({ "api.anthropic.com": "127.0.0.1" }).install();
    guards.push(guard);
    try {
      const p = new AnthropicProvider({ apiKey: "k-test-1234567", model: "m", baseUrl: `http://api.anthropic.com:${port}`, maxRetries: 0 });
      const res = await p.complete(tinyReq());
      expect(res.json).toEqual({ answer: "x" });
    } finally { guard.uninstall(); server.close(); }
    expect(guard.providerHits().length).toBeGreaterThan(0);
    expect(noProviderTraffic(guard)).toBe(false);
    expect(guard.events.some((e) => e.kind === "dns" && e.host === "api.anthropic.com")).toBe(true);
    writeFileSync(path.join(ARTIFACT_DIR, "net-predicate-control.json"), JSON.stringify({ purpose: "предикат noProviderTraffic має падати на навмисному зверненні до api.anthropic.com (мок-сервер на 127.0.0.1)", events: guard.events, provider_hits: guard.providerHits().length, noProviderTraffic: noProviderTraffic(guard) }, null, 2) + "\n");
  });

  it("replay: зміна вмісту (інша сторінка) → ГУЧНИЙ промах у етапі, не тихий фолбек; жодного мережевого звернення", async () => {
    const guard = new NetGuard().install();
    guards.push(guard);
    const { client } = createClientFromEnv(REPLAY_ENV, { replayDir: REPLAY_DIR, namespace: SHOP_NAMESPACE });
    const changed = pages.map((p) => (p.id === "index" ? { ...p, visible_text: p.visible_text + " змінено" } : p));
    await expect(runLlmStages({ audit_run_id: "run_x", client, pages: changed, llm_mode: "replay" })).rejects.toThrow(/промах кешу/);
    guard.uninstall();
    expect(guard.nonLoopback()).toEqual([]);
  });

  it("зміна ОДНОГО байта скриншота першої сторінки → replay-промах (повний ключ E5 включає хеші зображень)", async () => {
    const { client } = createClientFromEnv(REPLAY_ENV, { replayDir: REPLAY_DIR, namespace: SHOP_NAMESPACE });
    const changed = pages.map((p) => (p.id === "index" && p.image ? { ...p, image: { ...p.image, sha256: "f".repeat(64) } } : p));
    await expect(runLlmStages({ audit_run_id: "run_x", client, pages: changed, llm_mode: "replay" })).rejects.toThrow(/промах кешу/);
  });

  it("детермінізм: два прогони replay дають байт-в-байт однаковий збережений вихід", async () => {
    const run = async () => {
      const { client } = createClientFromEnv(REPLAY_ENV, { replayDir: REPLAY_DIR, namespace: SHOP_NAMESPACE });
      return JSON.stringify((await runLlmStages({ audit_run_id: "run_d", client, pages, llm_mode: "replay" })).stored);
    };
    expect(await run()).toBe(await run());
  });

  it("фікстури не застаріли: повторний запис у tmp дає ті самі файли (імена = ключі E5, вміст ідентичний)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "rec-"));
    await recordShop(tmp);
    const list = (d: string) => readdirSync(path.join(d, SHOP_NAMESPACE)).sort();
    expect(list(tmp)).toEqual(list(REPLAY_DIR));
    const h = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    for (const f of list(REPLAY_DIR)) expect(h(path.join(tmp, SHOP_NAMESPACE, f))).toBe(h(path.join(REPLAY_DIR, SHOP_NAMESPACE, f)));
    expect(h(path.join(tmp, "hostile/cases.json"))).toBe(h(path.join(REPLAY_DIR, "hostile/cases.json")));
  });

  it("усі записи фікстур позначені synthetic:true (replay доводить сантехніку, не якість моделі)", () => {
    const dir = path.join(REPLAY_DIR, SHOP_NAMESPACE);
    const files = readdirSync(dir);
    expect(files.length).toBe(3);
    for (const f of files) expect(JSON.parse(readFileSync(path.join(dir, f), "utf8")).synthetic).toBe(true);
  });
});

describe("режим без LLM (критерій 8, G0-2, DEV-11)", () => {
  it("нема ключів → llm_mode=none; 4 етапи skipped «no LLM provider»; AuditRun completed", async () => {
    const guard = new NetGuard().install();
    guards.push(guard);
    const { client, config } = createClientFromEnv({});
    expect(config.llm_mode).toBe("none");
    const r = await runLlmStages({ audit_run_id: "run_none", client, pages, llm_mode: config.llm_mode });
    guard.uninstall();
    for (const s of Object.values(r.stage_status)) expect(s).toEqual({ status: "skipped", reason: "no LLM provider" });
    expect(Object.keys(r.stage_status).sort()).toEqual(["lenses", "scenario_matrix", "site_profile", "tasks"]);
    expect(r.stored).toEqual({ profile: undefined, tasks: undefined, lenses: undefined, scenarios: undefined, journals: undefined });
    expect(client.records).toHaveLength(0);
    expect(guard.events).toEqual([]);
    const run = toAuditRunRecord({ id: "run_none", url: "http://127.0.0.1:4210/", llm_mode: "none", stage_status: r.stage_status });
    expect(AuditRun.parse(run).status).toBe("completed");
    expect(run.llm_mode).toBe("none");
    expect(run.llm_provider ?? null).toBeNull();
  });
  it("звіт без LLM: лише детерміновані знахідки з артефактів shop + банер (uk/en); 8 знахідок F-DET", () => {
    const s = buildNoLlmReportStub(SHOP_ARTIFACTS, "uk");
    expect(s.banner).toBe(NO_LLM_BANNER.uk);
    expect(s.banner).toContain("Синтетичний аналіз не виконувався");
    expect(s.findings).toHaveLength(8);
    expect(s.excluded_non_deterministic).toBe(0);
    expect(s.findings.every((f) => f.evidence_families.every((x) => x === "F-DET"))).toBe(true);
    expect(buildNoLlmReportStub(SHOP_ARTIFACTS, "en").banner).toBe(NO_LLM_BANNER.en);
  });
  it("контроль фільтра: знахідка з SYNTHETIC/LLM-родиною у входах НЕ потрапляє у звіт без LLM", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "nollm-"));
    const all = JSON.parse(readFileSync(path.join(SHOP_ARTIFACTS, "findings.json"), "utf8")) as Array<Record<string, unknown>>;
    writeFileSync(path.join(tmp, "findings.json"), JSON.stringify([...all, { ...all[0]!, finding_key: "cta|product|synthetic_fake", evidence_families: ["F-SYN"] }, { ...all[1]!, finding_key: "x|y|z", evidence_families: ["F-DET", "F-LLM"] }]));
    const s = buildNoLlmReportStub(tmp, "uk");
    expect(s.findings).toHaveLength(8);
    expect(s.excluded_non_deterministic).toBe(2);
    expect(s.findings.some((f) => f.finding_key.includes("synthetic"))).toBe(false);
  });
  it("бюджет/none: кожен виклик LLM без провайдера — LlmDisabledError, а не мережа", async () => {
    const { client } = createClientFromEnv({});
    const { Tiny } = await import("./helpers.js");
    await expect(client.call(tinyReq(), Tiny)).rejects.toThrow(/no LLM provider/);
  });
});
