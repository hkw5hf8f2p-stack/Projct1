import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditRun } from "@sitelens/schemas";
import {
  BudgetExceededError, LlmClient, TokenBudget, createClientFromEnv, loadPagesFromArtifacts, runLlmStages, toAuditRunRecord, type PageInput,
} from "../src/index.js";
import { SHOP_NAMESPACE, shopFakeProvider } from "../src/testing/synthetic-shop.js";
import { ARTIFACT_DIR, CountingProvider, REPLAY_DIR, SHOP_ARTIFACTS, Tiny, tinyReq } from "./helpers.js";

let pages: PageInput[];
beforeAll(() => { pages = loadPagesFromArtifacts(SHOP_ARTIFACTS); });
const replayRun = async (max: number | undefined) => {
  const { client, config } = createClientFromEnv({ LLM_PROVIDER: "replay", ...(max ? { MAX_AUDIT_TOKENS: String(max) } : {}) }, { replayDir: REPLAY_DIR, namespace: SHOP_NAMESPACE });
  const r = await runLlmStages({ audit_run_id: "run_b", client, pages, llm_mode: config.llm_mode });
  return { client, r };
};
const sumTokens = (c: LlmClient) => c.records.reduce((a, x) => a + x.input_tokens + x.output_tokens, 0);

describe("бюджет E4 (MAX_AUDIT_TOKENS)", () => {
  let needed = 0;
  it("повний бюджет: потрібно N токенів; лічильник = сума по викликах (розбіжність 0)", async () => {
    const { client, r } = await replayRun(undefined);
    needed = r.budget.total_tokens;
    expect(needed).toBeGreaterThan(1000);
    expect(r.budget.total_tokens).toBe(sumTokens(client));
    expect(client.budget.calls.reduce((a, e) => a + e.input_tokens + e.output_tokens, 0)).toBe(needed);
    expect(r.budget.exhausted).toBe(false);
  });

  it("MAX = 10 % від потрібного → етап зупинено з позначкою «обмежено бюджетом», аудит completed, лічильник = сума по викликах", async () => {
    const max = Math.floor(needed * 0.1);
    const { client, r } = await replayRun(max);
    expect(r.stage_status.site_profile?.status).toBe("budget_limited");
    expect(r.stage_status.site_profile?.reason).toContain("обмежено бюджетом");
    expect(r.stage_status.tasks?.status).toBe("skipped"); // залежні етапи не запускались
    expect(r.budget.exhausted).toBe(true);
    expect(r.budget.total_tokens).toBe(sumTokens(client));
    expect(r.budget.total_tokens).toBeLessThanOrEqual(max);
    const run = toAuditRunRecord({ id: "run_b", url: "http://127.0.0.1:4210/", llm_mode: "replay", stage_status: r.stage_status, config_json: { max_audit_tokens: max } });
    expect(AuditRun.parse(run).status).toBe("completed");
  });

  it("частковий бюджет (60 %): перші етапи done, потім budget_limited; used ≤ max; лічильник = Σ викликів", async () => {
    const { client, r } = await replayRun(Math.floor(needed * 0.6));
    const st = Object.fromEntries(Object.entries(r.stage_status).map(([k, v]) => [k, v?.status]));
    expect(st).toMatchObject({ site_profile: "done", tasks: "done", lenses: "budget_limited" });
    expect(st.scenario_matrix).toBe("skipped");
    expect(r.budget.total_tokens).toBe(sumTokens(client));
    expect(r.budget.total_tokens).toBeLessThanOrEqual(Math.floor(needed * 0.6));
  });

  it("розгортка 1…99 % потрібного: у КОЖНОМУ прогоні є зупинка з позначкою, used ≤ max, розбіжність лічильника 0; на 100 % зупинки немає", async () => {
    const rows: Array<Record<string, unknown>> = [];
    let limited = 0, mismatch = 0, over = 0;
    for (let pct = 1; pct <= 100; pct++) {
      const max = pct === 100 ? needed : Math.floor((needed * pct) / 100);
      const { client, r } = await replayRun(max);
      const marked = Object.values(r.stage_status).some((s) => s?.status === "budget_limited");
      const diff = Math.abs(r.budget.total_tokens - sumTokens(client));
      if (pct < 100) { if (marked) limited++; } else expect(marked).toBe(false);
      if (diff !== 0) mismatch++;
      if (r.budget.total_tokens > max) over++;
      rows.push({ pct, max, used: r.budget.total_tokens, marked, diff, statuses: Object.values(r.stage_status).map((s) => s?.status) });
    }
    expect({ limited, mismatch, over }).toEqual({ limited: 99, mismatch: 0, over: 0 });
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(path.join(ARTIFACT_DIR, "budget-sweep.json"), JSON.stringify({ needed_tokens: needed, runs: rows.length, underfunded_runs_marked: limited, counter_mismatch_tokens: mismatch, over_budget_runs: over, rows, note: "replay: токени = із записів фікстури (SYNTHETIC); реальна вартість — ⏭️ live pass" }, null, 2) + "\n");
  });

  it("живий шлях (fake-провайдер): передперевірка входу+max_tokens зупиняє ДО виклику провайдера (0 викликів), помилка BudgetExceededError", async () => {
    const p = new CountingProvider();
    const client = new LlmClient({ mode: "live", provider: p, budget: new TokenBudget(50) });
    await expect(client.call(tinyReq({ sampling: { max_tokens: 100 } }), Tiny)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(p.calls).toBe(0);
    expect(client.budget.used).toBe(0);
  });
  it("живий шлях: етапи на fake з малим бюджетом → budget_limited, нічого не збережено, провайдера не викликано", async () => {
    const fake = shopFakeProvider(pages);
    const client = new LlmClient({ mode: "fake", provider: fake, budget: new TokenBudget(3000) });
    const r = await runLlmStages({ audit_run_id: "run_f", client, pages, llm_mode: "replay" });
    expect(r.stage_status.site_profile?.status).toBe("budget_limited");
    expect(fake.received).toEqual([]);
    expect(r.stored.profile).toBeUndefined();
  });
  it("лічильник: input/output/billed/cache розділено; невалідні значення MAX_AUDIT_TOKENS відхиляються", () => {
    const b = new TokenBudget(100);
    b.record({ call_id: "1", stage: "s", source: "provider", input_tokens: 10, output_tokens: 5 });
    b.record({ call_id: "2", stage: "s", source: "cache", input_tokens: 20, output_tokens: 1 });
    expect(b.snapshot()).toMatchObject({ input_tokens: 30, output_tokens: 6, total_tokens: 36, billed_tokens: 15, cache_read_tokens: 21, calls: 2 });
    expect(() => new TokenBudget(0)).toThrow();
    expect(() => createClientFromEnv({ MAX_AUDIT_TOKENS: "abc" })).toThrow(/MAX_AUDIT_TOKENS/);
    expect(() => createClientFromEnv({ MAX_AUDIT_TOKENS: "-5" })).toThrow(/MAX_AUDIT_TOKENS/);
  });
});
