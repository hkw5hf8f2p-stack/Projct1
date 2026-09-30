/**
 * DEV-92/93 наскрізно: UI-контракт → API → worker (справжні PostgreSQL, pg-boss, Chromium) на fixtures/shop зі scripted-fake LLM.
 *  - швидкий (quick) і повний (full) аудит: режим у статусі й звіті, обсяг (сторінки/лінзи/сесії/журнали), банер «швидкий аудит»;
 *  - лічильники прогресу (step_details) НЕ спадають між опитуваннями й закінчуються на N/N;
 *  - паралельність LLM = llm_concurrency (пік одночасних snapshot-викликів ≤ N і > 1 при N ≥ 2), бюджет E4 не перевищено.
 * Якість моделі НЕ перевіряється (fake): ⏭️ живий пас.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../api/src/server.js";
import { AuditStatusResponse, CreateAuditResponse, MODE_PROFILES, Report, type Report as ReportT } from "@sitelens/schemas";
import type { ProviderResult, LlmRequest } from "@sitelens/llm";
import { createBoss, loadConfig, startBoss } from "@sitelens/pipeline";
import { createShopHandler } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type JournalRunner, type Runtime } from "../src/runtime.js";
import { DynamicFake, useFakeLlm } from "./helpers/fake-llm.js";

process.env["LOG_LEVEL"] = "silent";
const art = mkdtempSync(path.join(os.tmpdir(), "sl-qp-art-"));
let cluster: TestCluster;
let shop: FixtureServer;
let guard: { stop(): number[] };
interface Stack { db: FreshDb; boss: PgBoss; rt: Runtime; api: FastifyInstance; stop(): Promise<void> }
const stacks: Stack[] = [];

/** fake з паузою на snapshot-виклик і лічильником одночасних викликів (пік = фактична паралельність) */
class SlowFake extends DynamicFake {
  inflight = 0;
  peak = 0;
  /** scripted-відповіді профілю/задач посилаються на сторінки повного обходу shop; при quick (≤ 6 сторінок) лишаємо лише надані — як зробила б справжня модель */
  private fit(req: LlmRequest, r: ProviderResult): ProviderResult {
    const text = req.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
    const ids = new Set([...text.matchAll(/page_id=(\S+)/g), ...text.matchAll(/^(\S+)\t\S+\thttps?:\/\//gm)].map((m) => m[1]!));
    const first = [...ids][0]!;
    const j = JSON.parse(JSON.stringify(r.json)) as { evidence?: Array<{ page_id: string }>; tasks?: Array<{ recommended_start_page: string }> };
    if (j.evidence) j.evidence = j.evidence.filter((e) => ids.has(e.page_id));
    if (j.tasks && first) for (const t of j.tasks) if (!ids.has(t.recommended_start_page)) t.recommended_start_page = first;
    return { ...r, json: j };
  }
  override async complete(req: LlmRequest): Promise<ProviderResult> {
    if (req.prompt_id === "site-profile-v1" || req.prompt_id === "task-generator-v1") return this.fit(req, await super.complete(req));
    if (req.prompt_id !== "snapshot-evaluator-v1") return super.complete(req);
    this.inflight++;
    this.peak = Math.max(this.peak, this.inflight);
    try { await new Promise((r) => setTimeout(r, 250)); return await super.complete(req); } finally { this.inflight--; }
  }
}

const journal: JournalRunner = async (i) => ({
  status: "done", non_get_blocked: 0, calls: [],
  session: {
    session_id: "ses_" + i.scenarioId.slice(3), success: "true", actions_used: 1, frictions: [], positive_signals: ["Шлях пройдено."], uncertainties: [], final_summary: "Журнал пройдено (fake-виконавець).",
    pages_seen: [new URL(i.startUrl).pathname], steps: [{ action: "stop_success", target: "", reason_summary: "Мету досягнуто.", task_progress: "Готово.", friction_detected: [] }],
  },
});

async function startStack(fake: DynamicFake): Promise<Stack> {
  const db = await freshDatabase(cluster.url);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1", MAX_PAGES: "12" } as NodeJS.ProcessEnv);
  const boss = createBoss(db.url, { supervise: true, max: 10 });
  await startBoss(boss);
  const rt = createRuntime(cfg, db.pool, boss);
  rt.log = () => undefined;
  useFakeLlm(rt, fake);
  rt.journalRunner = journal;
  await registerHandlers(rt);
  const api = await buildServer({ cfg, pool: db.pool, boss, llmMode: "replay" });
  const s: Stack = { db, boss, rt, api, async stop() { await api.close(); await boss.stop({ graceful: false, close: true, timeout: 3000 }).catch(() => undefined); await rt.close(); await db.drop(); } };
  stacks.push(s);
  return s;
}

/** опитує статус як UI (~5/с) до завершення; повертає всі знімки */
async function pollAll(s: Stack, id: string, ms = 420_000) {
  const t0 = Date.now();
  const samples: Array<ReturnType<typeof AuditStatusResponse.parse>> = [];
  for (;;) {
    const r = await s.api.inject({ method: "GET", url: `/api/audits/${id}` });
    const st = AuditStatusResponse.parse(r.json());
    samples.push(st);
    if (st.status === "completed" || st.status === "failed") return samples;
    if (Date.now() - t0 > ms) throw new Error(`аудит ${id} не завершився: ${st.status}`);
    await new Promise((res) => setTimeout(res, 200));
  }
}
const counterSeries = (samples: Array<ReturnType<typeof AuditStatusResponse.parse>>) => {
  const m = new Map<string, number[]>();
  for (const st of samples) for (const d of st.step_details ?? []) for (const c of d.counters) { const k = `${d.id}/${c.unit}`; (m.get(k) ?? m.set(k, []).get(k)!).push(c.done); }
  return m;
};

beforeAll(async () => {
  guard = guardTestProcesses();
  cluster = await startTestCluster();
  shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }) });
}, 90_000);
afterAll(async () => {
  for (const s of stacks) await s.stop().catch(() => undefined);
  await shop?.close();
  await cluster?.stop();
  guard?.stop();
  rmSync(art, { recursive: true, force: true });
});

async function runAudit(mode: "quick" | "full", conc: number) {
  const fake = new SlowFake({ frictionLensIds: ["l01", "l03", "l05", "l07"] });
  const s = await startStack(fake);
  const prev = process.env["LLM_CONCURRENCY"];
  process.env["LLM_CONCURRENCY"] = String(conc);
  let id: string;
  try { id = CreateAuditResponse.parse((await s.api.inject({ method: "POST", url: "/api/audits", payload: { url: shop.origin + "/", mode } })).json()).auditId; }
  finally { if (prev === undefined) delete process.env["LLM_CONCURRENCY"]; else process.env["LLM_CONCURRENCY"] = prev; }
  const samples = await pollAll(s, id);
  const last = samples.at(-1)!;
  expect(last.status, JSON.stringify(last.error)).toBe("completed");
  const rr = await s.api.inject({ method: "GET", url: `/api/audits/${id}/report` });
  expect(rr.statusCode, rr.body.slice(0, 300)).toBe(200);
  const report: ReportT = Report.parse(rr.json());
  const q = async (sql: string) => (await s.db.pool.query(sql, [id])).rows;
  return { s, fake, id, samples, last, report, q };
}

const monotone = (samples: Array<ReturnType<typeof AuditStatusResponse.parse>>) => {
  const series = counterSeries(samples);
  expect(series.size).toBeGreaterThan(3);
  for (const [k, xs] of series) for (let i = 1; i < xs.length; i++) expect(xs[i]!, `${k} спав: ${xs.join(",")}`).toBeGreaterThanOrEqual(xs[i - 1]!);
  return series;
};

describe("швидкий аудит (quick, паралельність 2)", () => {
  it("обсяг ≤ профілю; режим і банер у звіті; лічильники монотонні й закінчуються N/N; пік паралельних LLM ≤ 2", async () => {
    const r = await runAudit("quick", 2);
    expect(r.last.mode).toBe("quick");
    expect(r.last.llm_concurrency).toBe(2);
    const series = monotone(r.samples);
    expect(series.get("testing_journeys/snapshot_sessions")!.at(-1)).toBe(r.last.step_details!.find((d) => d.id === "testing_journeys")!.counters.find((c) => c.unit === "snapshot_sessions")!.total);
    // обсяг
    const pages = Number((await r.q("SELECT count(*) AS n FROM page_artifacts WHERE audit_run_id = $1"))[0].n);
    const lenses = Number((await r.q("SELECT count(*) AS n FROM behavioral_lenses WHERE audit_run_id = $1"))[0].n);
    const snaps = Number((await r.q("SELECT count(*) AS n FROM scenarios WHERE audit_run_id = $1 AND level = 'snapshot'"))[0].n);
    const jrn = Number((await r.q("SELECT count(*) AS n FROM scenarios WHERE audit_run_id = $1 AND level = 'journey'"))[0].n);
    expect(pages).toBeLessThanOrEqual(MODE_PROFILES.quick.max_pages);
    expect(lenses).toBeGreaterThanOrEqual(6);
    expect(lenses).toBeLessThanOrEqual(7);
    expect(snaps).toBeLessThanOrEqual(14);
    expect(snaps).toBeGreaterThanOrEqual(6);
    expect(jrn).toBeLessThanOrEqual(MODE_PROFILES.quick.journals_max);
    expect(r.last.progress.scenarios_done).toBe(r.last.progress.scenarios_total);
    // звіт: помітка «швидкий аудит»
    expect(r.report.audit.mode).toBe("quick");
    expect(r.report.audit.banners.map((b) => b.code)).toContain("quick_audit");
    // паралельність: реально > 1 і не більше налаштованої
    expect(r.fake.peak).toBeGreaterThan(1);
    expect(r.fake.peak).toBeLessThanOrEqual(2);
    // бюджет E4
    const used = Number((await r.q("SELECT tokens_input + tokens_output AS n FROM audit_runs WHERE id = $1"))[0].n);
    expect(used).toBeLessThanOrEqual(1_650_000);
    // ETA: коли з'явилась — невід'ємна; а до першої завершеної задачі етапу її не було (не вигадується)
    const firstSnapEta = r.samples.filter((st) => st.step_details?.find((d) => d.id === "testing_journeys")?.counters.find((c) => c.unit === "snapshot_sessions")?.done === 0).every((st) => st.step_details!.find((d) => d.id === "testing_journeys")!.counters.find((c) => c.unit === "snapshot_sessions")!.eta_seconds == null);
    expect(firstSnapEta).toBe(true);
  }, 600_000);
});

describe("повний аудит (full, паралельність 3): контроль — без швидких обмежень і без помітки", () => {
  it("режим full; звіт без mode і без банера quick_audit; пік паралельних LLM ≤ 3 (і > 2 → семафор не занижує); лічильники монотонні", async () => {
    const r = await runAudit("full", 3);
    expect(r.last.mode).toBe("full");
    expect(r.last.llm_concurrency).toBe(3);
    monotone(r.samples);
    expect(r.report.audit.mode).toBeUndefined();
    expect(r.report.audit.banners.map((b) => b.code)).not.toContain("quick_audit");
    expect(r.fake.peak).toBeLessThanOrEqual(3);
    expect(r.fake.peak).toBeGreaterThan(2);
    const snaps = Number((await r.q("SELECT count(*) AS n FROM scenarios WHERE audit_run_id = $1 AND level = 'snapshot'"))[0].n);
    expect(snaps).toBeGreaterThanOrEqual(24); // повний профіль не звужено
  }, 900_000);
});
