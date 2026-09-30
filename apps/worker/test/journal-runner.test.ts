/**
 * Адаптер журналів (DEV-70): справжній Chromium (secureLaunch) + runJourney (packages/browser) + agentTurn (packages/llm) на fixtures/shop,
 * агент — scripted fake (SYNTHETIC: плумбінг, не якість моделі). Перевіряє: код фільтрує дію «Вийти» (GET /logout НЕ доходить до сайту), 0 не-GET, сесія й файли журналу є.
 * Контроль: той самий сценарій із вимкненим кодовим фільтром (`__controlNoFilter`) — GET /logout доходить (лічильник фікстури > 0), тож перевірка вміє впасти.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJourney, type AgentDriver } from "@sitelens/browser";
import { LlmClient, ScriptedFakeProvider, TokenBudget } from "@sitelens/llm";
import { auditDir, loadConfig } from "@sitelens/pipeline";
import { BehavioralLens, Task } from "@sitelens/schemas";
import { createShopHandler } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";
import { browserJournalRunner } from "../src/journal-runner.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

let shop: FixtureServer;
let rt: Runtime;
let guard: { stop(): number[] };
const art = mkdtempSync(path.join(os.tmpdir(), "sl-journal-"));
const lens = BehavioralLens.parse({
  id: "l01", audit_run_id: "aud_0123456789abcdef", name: "Обережний", description: "Перевіряє умови перед дією", category_knowledge: 0.4, price_sensitivity: 0.8, trust_requirement: 0.7, decision_speed: 0.3, detail_preference: 0.6,
  visual_sensitivity: 0.5, comparison_tendency: 0.5, risk_aversion: 0.8, convenience_priority: 0.5, social_proof_need: 0.5, primary_goal: "Знати умови доставки", likely_questions: [], likely_objections: [],
});
const task = Task.parse({ task_id: "t1", audit_run_id: "aud_0123456789abcdef", name: "Умови доставки", goal: "Знайти умови й вартість доставки", success_conditions: ["Умови знайдено"], failure_conditions: [], recommended_start_page: "http://x/", max_actions: 4, task_type: "delivery" });

beforeAll(async () => {
  guard = guardTestProcesses();
  shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }) });
  const cfg = loadConfig({ DATABASE_URL: "postgres://x@127.0.0.1:1/x", ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin } as unknown as NodeJS.ProcessEnv);
  rt = createRuntime(cfg, {} as never, {} as never);
  rt.log = () => undefined;
}, 60_000);
afterAll(async () => {
  await rt?.close();
  await shop?.close();
  guard?.stop();
  rmSync(art, { recursive: true, force: true });
});

const turn = (o: Record<string, unknown>, result: unknown = null) => ({ step: { action: "click", target: 'link:"Вийти"', reason_summary: "Шукаю потрібну сторінку.", task_progress: "Перевіряю навігацію.", friction_detected: [], confidence: 0.5, ...o }, result });
const RESULT = { success: "partial", frictions: [], positive_signals: [], uncertainties: ["Умов доставки не знайдено."], final_summary: "Журнал завершено без результату." };

describe("run_browser_scenario: адаптер runJourney + agentTurn", () => {
  it("дія «Вийти» (GET /logout) відхиляється кодом; журнал завершується; 0 не-GET; сесія й файли є; LLM-виклики враховані", async () => {
    const start = shop.origin + "/";
    const provider = ScriptedFakeProvider.from([
      [{ prompt_id: "browser-agent-v1", page_url: start, lens_id: "l01", task_id: "t1", step: 0 }, { response: turn({}) }],
      [{ prompt_id: "browser-agent-v1", page_url: start, lens_id: "l01", task_id: "t1", step: 1 }, { response: turn({ action: "stop_failure", target: "", reason_summary: "Умов доставки не знайшов.", task_progress: "Зупиняюсь." }, RESULT) }],
      [{ prompt_id: "browser-agent-v1", page_url: start, lens_id: "l01", task_id: "t1", step: 2 }, { response: turn({ action: "stop_failure", target: "", reason_summary: "Умов доставки не знайшов.", task_progress: "Зупиняюсь." }, RESULT) }],
    ]);
    const client = new LlmClient({ mode: "fake", provider, budget: new TokenBudget(500_000) });
    const out = await browserJournalRunner({ auditRunId: "aud_0123456789abcdef", scenarioId: "sc_x", lens, task, startUrl: start, browser: () => rt.getBrowser(), gate: rt.gate, userAgent: rt.userAgent, client, language: "uk", artifactDir: art });
    expect(out.status, out.reason).toBe("done");
    expect(out.session!.steps.length).toBeGreaterThanOrEqual(1);
    expect(out.calls.length).toBeGreaterThanOrEqual(2);
    expect(out.non_get_blocked).toBe(0);
    expect(shop.state.logout).toBe(0); // GET /logout не дійшов до сайту
    expect(shop.state.non_get).toBe(0);
    expect(out.session!.session_id).toContain("l01");
    expect(existsSync(path.join(auditDir(art, "aud_0123456789abcdef"), "journeys"))).toBe(true);
  }, 120_000);

  it("контроль: той самий крок «Вийти» БЕЗ кодового фільтра доходить до сайту (logout > 0) — перевірка вміє впасти", async () => {
    const before = shop.state.logout;
    const driver: AgentDriver = async (obs) => (obs.step === 0
      ? { step: { action: "click", target: 'link:"Вийти"', reason_summary: "Контрольний клік.", task_progress: "Контроль.", friction_detected: [] }, result: null }
      : { step: { action: "stop_failure", target: "", reason_summary: "Кінець.", task_progress: "Кінець.", friction_detected: [] }, result: { success: "false", frictions: [], positive_signals: [], uncertainties: [], final_summary: "Контроль." } });
    await runJourney({ secure: await rt.getBrowser(), startUrl: shop.origin + "/", runDir: auditDir(art, "aud_fedcba9876543210"), audit_run_id: "aud_fedcba9876543210", lens_id: "l01", task: { id: "t1", name: "n", goal: "g", task_type: "delivery", max_actions: 3 }, driver, __controlNoFilter: true });
    expect(shop.state.logout).toBeGreaterThan(before);
  }, 120_000);

  it("збій LLM-кроку (невалідна відповідь після repair) → статус failed з причиною, не виняток (аудит не падає)", async () => {
    const start = shop.origin + "/";
    const provider = ScriptedFakeProvider.from([
      [{ prompt_id: "browser-agent-v1", page_url: start, lens_id: "l01", task_id: "t1", step: 0 }, { response: { nonsense: true } }],
      [{ prompt_id: "browser-agent-v1", page_url: start, lens_id: "l01", task_id: "t1", step: 0, attempt: 1 }, { response: { nonsense: true } }],
    ]);
    const client = new LlmClient({ mode: "fake", provider, budget: new TokenBudget(500_000) });
    const out = await browserJournalRunner({ auditRunId: "aud_1111111111111111", scenarioId: "sc_y", lens, task, startUrl: start, browser: () => rt.getBrowser(), gate: rt.gate, userAgent: rt.userAgent, client, language: "uk", artifactDir: art });
    expect(out.status).toBe("failed");
    expect(out.reason).toBeTruthy();
    expect(out.session).toBeUndefined();
  }, 120_000);
});
