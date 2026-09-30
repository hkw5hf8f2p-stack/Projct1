/**
 * Наскрізний S4 (backend): аудит fixtures/shop через API → worker (справжні PostgreSQL, pg-boss, Chromium) → GET /report.
 *  A. llm_mode=none ×3: звіт за контрактом, детерміновані 7/7 VERIFIED у топ-10 (E1 через БД-шлях), однакові порядок і пріоритети (кр. 6), 0 не-GET до сайту.
 *  B. scripted-fake LLM ×3 (профіль → задачі → лінзи → матриця → snapshot-сценарії → журнали fake-виконавцем → агрегація → звіт): плумбінг, БД, токени, ідемпотентність, кр. 6.
 *  C. SQL-критерії 1 (знахідок без доказу 0; рекомендацій без знахідки 0) — з контролем на підкладеному рядку; кр. 7 — сканер guard по JSON з API (контроль «+12 % конверсії»).
 * Якість моделі НЕ перевіряється (fake — SYNTHETIC, пише інженер): ⏭️ живий пас (OQ-1).
 * Артефакти: planning/qa/artifacts/sprint-4/ (лише SL_WRITE_ARTIFACTS=1, X-1).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../api/src/server.js";
import { AuditStatusResponse, CreateAuditResponse, Report, type Report as ReportT } from "@sitelens/schemas";
import { scanReport } from "@sitelens/reporting";
import { createBoss, loadConfig, startBoss } from "@sitelens/pipeline";
import { createShopHandler } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { artifactDir } from "../../../scripts/artifact-dir.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type JournalRunner, type Runtime } from "../src/runtime.js";
import { DynamicFake, HOSTILE_QUOTE, useFakeLlm } from "./helpers/fake-llm.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const EXPECTED = JSON.parse(readFileSync(path.join(ROOT, "fixtures/shop/EXPECTED.json"), "utf8")) as { defects: Array<{ id: number; type: string; categories: string[]; page_groups: string[]; detector_id: string | null; detector_ids?: string[] }> };
process.env["LOG_LEVEL"] = "silent";
const art = mkdtempSync(path.join(os.tmpdir(), "sl-s4-art-"));
let cluster: TestCluster;
let shop: FixtureServer;
let guard: { stop(): number[] };
interface Stack { db: FreshDb; boss: PgBoss; rt: Runtime; api: FastifyInstance; stop(): Promise<void> }
const stacks: Stack[] = [];
const evidenceOut: Record<string, unknown> = {};
const save = (name: string, v: unknown) => {
  const d = artifactDir("sprint-4");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, name), JSON.stringify(v, null, 2) + "\n");
};

async function startStack(o: { llmMode: "none" | "replay"; fake?: DynamicFake; journal?: JournalRunner | null }): Promise<Stack> {
  const db = await freshDatabase(cluster.url);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1" } as NodeJS.ProcessEnv);
  const boss = createBoss(db.url, { supervise: true, max: 10 });
  await startBoss(boss);
  const rt = createRuntime(cfg, db.pool, boss);
  rt.log = () => undefined;
  if (o.fake) useFakeLlm(rt, o.fake);
  if (o.journal !== undefined) rt.journalRunner = o.journal;
  await registerHandlers(rt);
  const api = await buildServer({ cfg, pool: db.pool, boss, llmMode: o.llmMode });
  const s: Stack = { db, boss, rt, api, async stop() { await api.close(); await boss.stop({ graceful: false, close: true, timeout: 3000 }).catch(() => undefined); await rt.close(); await db.drop(); } };
  stacks.push(s);
  return s;
}
const submit = async (s: Stack) => CreateAuditResponse.parse((await s.api.inject({ method: "POST", url: "/api/audits", payload: { url: shop.origin + "/" } })).json()).auditId;
async function waitDone(s: Stack, id: string, ms = 420_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await s.api.inject({ method: "GET", url: `/api/audits/${id}` });
    const st = AuditStatusResponse.parse(r.json());
    if (st.status === "completed" || st.status === "failed") return st;
    if (Date.now() - t0 > ms) throw new Error(`аудит ${id} не завершився: ${st.status} ${JSON.stringify(st.progress)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const q = async (s: Stack, sql: string, a: unknown[] = []) => (await s.db.pool.query(sql, a)).rows;
const getReport = async (s: Stack, id: string): Promise<ReportT> => {
  const r = await s.api.inject({ method: "GET", url: `/api/audits/${id}/report` });
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  return Report.parse(r.json());
};
const rankView = (r: ReportT) => r.findings.map((f) => ({ key: f.finding_key, rank: f.rank, priority: f.priority.value, conf: f.confidence.level, strength: f.evidence_strength.value, sev: f.severity.value, fun: f.funnel.value }));

/** SQL критерію 1: кожна знахідка має ≥ 1 support-доказ; кожна рекомендація — існуючу знахідку */
export const SQL_FINDINGS_NO_EVIDENCE = `SELECT f.id FROM findings f WHERE f.audit_run_id = $1 AND NOT EXISTS (SELECT 1 FROM finding_evidence fe JOIN evidence e ON e.audit_run_id = fe.audit_run_id AND e.id = fe.evidence_id WHERE fe.audit_run_id = f.audit_run_id AND fe.finding_id = f.id AND fe.role = 'support')`;
export const SQL_RECS_NO_FINDING = `SELECT r.id FROM recommendations r WHERE r.audit_run_id = $1 AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.audit_run_id = r.audit_run_id AND f.id = r.finding_id)`;

function detected(r: ReportT) {
  return EXPECTED.defects.filter((d) => d.type === "deterministic").map((d) => {
    const dets = d.detector_ids ?? [d.detector_id];
    const f = r.findings.find((x) => d.categories.includes(x.category) && (d.page_groups.includes("*") || d.page_groups.includes(x.page_group)) && x.evidence_ids.some((id) => dets.includes(r.evidence.find((e) => e.id === id)?.detector_id ?? "")));
    return { id: d.id, key: f?.finding_key ?? null, verified: f?.confidence.level === "VERIFIED", rank: f?.rank ?? null };
  });
}

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

describe("A. llm_mode=none: fixtures/shop ×3 через API", () => {
  let s: Stack;
  const ids: string[] = [];
  const reports: ReportT[] = [];
  it("3 аудити → completed; GET /report валідний за контрактом Report; етапи LLM skipped, report done", async () => {
    s = await startStack({ llmMode: "none" });
    for (let i = 0; i < 3; i++) {
      const id = await submit(s);
      ids.push(id);
      const st = await waitDone(s, id);
      expect(st.status, JSON.stringify(st.error)).toBe("completed");
      expect(st.stage_status["report"]).toMatchObject({ status: "done" });
      expect(st.stage_status["aggregate"]).toMatchObject({ status: "done" });
      for (const k of ["site_profile", "tasks", "lenses", "scenario_matrix", "snapshot_sessions", "browser_sessions"]) expect(st.stage_status[k], k).toMatchObject({ status: "skipped", reason: "no LLM provider" });
      expect(st.steps?.map((x) => x.state)).toEqual(["done", "done", "skipped", "skipped", "skipped", "skipped", "done", "done"]);
      reports.push(await getReport(s, id));
    }
    evidenceOut["none_run_ids"] = ids;
    save("report-api-shop-none.json", reports[0]);
    expect(reports[0]!.audit.llm_mode).toBe("none");
    expect(reports[0]!.findings.length).toBeGreaterThan(5);
  }, 900_000);

  it("критерій 2 через БД-шлях: детерміновані дефекти фікстури — 7/7 VERIFIED і в топ-10", () => {
    const det = detected(reports[0]!);
    save("report-api-shop-e1.json", { schema: "sitelens-s4-e1-api/v1", llm_mode: "none", deterministic: det, verified_in_top10: det.filter((d) => d.verified && (d.rank ?? 99) <= 10).length, of: det.length });
    expect(det).toHaveLength(7);
    expect(det.filter((d) => d.verified && d.rank !== null && d.rank <= 10).map((d) => d.id)).toEqual([2, 5, 6, 7, 8, 9, 10]);
  });

  it("критерій 6 (none): 3/3 прогони — ідентичний порядок і числа (ключ, rank, priority, впевненість, сила, severity, воронка)", () => {
    const v = reports.map(rankView);
    expect(v[1]).toEqual(v[0]);
    expect(v[2]).toEqual(v[0]);
    save("priority-determinism-none.json", { runs: ids.length, identical: true, findings: v[0]!.length, top10: v[0]!.slice(0, 10) });
  });

  it("критерій 6 уміє впасти: змінений пріоритет однієї знахідки → порівняння бачить розбіжність", () => {
    const tampered = rankView(reports[1]!);
    tampered[0] = { ...tampered[0]!, priority: tampered[0]!.priority - 1 };
    expect(tampered).not.toEqual(rankView(reports[0]!));
  });

  it("кр. 5 (фікстура): 0 не-GET, 0 add-to-cart/logout/delete GET до сайту за 3 аудити", () => {
    expect(shop.state).toMatchObject({ non_get: 0, add_to_cart_get: 0, logout: 0, delete_action: 0 });
    evidenceOut["shop_state_after_none"] = { ...shop.state };
  });

  it("критерій 1 (SQL по БД): знахідок без доказу 0; рекомендацій без знахідки 0; є що перевіряти (знахідки й рекомендації існують)", async () => {
    for (const id of ids) {
      expect(await q(s, SQL_FINDINGS_NO_EVIDENCE, [id])).toEqual([]);
      expect(await q(s, SQL_RECS_NO_FINDING, [id])).toEqual([]);
    }
    const n = (await q(s, "SELECT (SELECT count(*) FROM findings WHERE audit_run_id = $1)::int AS f, (SELECT count(*) FROM recommendations WHERE audit_run_id = $1)::int AS r, (SELECT count(*) FROM finding_evidence WHERE audit_run_id = $1)::int AS fe", [ids[0]]))[0];
    expect(n.f).toBeGreaterThan(5);
    expect(n.r).toBeGreaterThan(0);
    expect(n.f).toBe(reports[0]!.findings.length);
    // JSON звіту: кожна знахідка має evidence_ids, кожен id є в report.evidence
    for (const f of reports[0]!.findings) {
      expect(f.evidence_ids.length).toBeGreaterThan(0);
      for (const e of f.evidence_ids) expect(reports[0]!.evidence.some((x) => x.id === e)).toBe(true);
    }
    evidenceOut["sql_c1_none"] = { findings: n.f, recommendations: n.r, finding_evidence: n.fe, findings_without_evidence: 0, recs_without_finding: 0 };
  });

  it("критерій 1: контроль — підкладена знахідка без доказу й рекомендація без знахідки (обхід обмежень від суперюзера) → SQL їх ЛОВИТЬ", async () => {
    const c = await s.db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica"); // вимикає FK і deferred-тригер §23 лише в цій транзакції
      await c.query(`INSERT INTO findings (audit_run_id, id, finding_key, category, page_group, claim_kind, evidence_families, confidence, evidence_strength, instances) VALUES ($1,'fnd_planted00001','cta|x|below_fold','cta','x','below_fold',ARRAY['F-DET'],'VERIFIED',1,1)`, [ids[0]]);
      await c.query(`INSERT INTO recommendations (audit_run_id, id, finding_id, recommended_change, how_to_validate) VALUES ($1,'rec_planted00001','fnd_nonexistent00','x','y')`, [ids[0]]);
      const a = (await c.query(SQL_FINDINGS_NO_EVIDENCE, [ids[0]])).rows.map((r) => r.id);
      const b = (await c.query(SQL_RECS_NO_FINDING, [ids[0]])).rows.map((r) => r.id);
      await c.query("ROLLBACK");
      expect(a).toEqual(["fnd_planted00001"]);
      expect(b).toEqual(["rec_planted00001"]);
    } finally {
      c.release();
    }
    // без суперюзерського обходу БД сама не приймає знахідку без доказу (deferred-тригер §23)
    await expect(q(s, `INSERT INTO findings (audit_run_id, id, finding_key, category, page_group, claim_kind, evidence_families, confidence, evidence_strength, instances) VALUES ($1,'fnd_planted00002','cta|y|below_fold','cta','y','below_fold',ARRAY['F-DET'],'VERIFIED',1,1)`, [ids[0]])).rejects.toThrow(/no supporting evidence/);
    expect(await q(s, SQL_FINDINGS_NO_EVIDENCE, [ids[0]])).toEqual([]);
  });

  it("критерій 7: сканер guard по JSON звіту з API — чисто; контроль: підкладене «+12 % конверсії» / «+12% conversion» у текстове поле → ловить", async () => {
    for (const r of reports) {
      const scan = scanReport(r);
      expect(scan.clean, JSON.stringify(scan.violations.slice(0, 3))).toBe(true);
      expect(scan.fields_checked).toBeGreaterThan(50);
    }
    const bad = JSON.parse(JSON.stringify(reports[0])) as ReportT;
    (bad.findings[0]!.problem as { template: string }).template = "Після виправлення буде +12 % конверсії.";
    const s1 = scanReport(bad);
    expect(s1.clean).toBe(false);
    expect(s1.violations[0]!.ptr).toContain("/findings/0/problem");
    const bad2 = JSON.parse(JSON.stringify(reports[0])) as ReportT;
    (bad2.findings[1]!.why_it_matters as { template: string } | null)!.template = "Expect a +12% conversion lift.";
    expect(scanReport(bad2).clean).toBe(false);
    // і на шляху API: підміна збереженого звіту порушенням → API НЕ віддає його (fail-closed)
    const row = (await q(s, "SELECT report FROM audit_reports WHERE audit_run_id = $1", [ids[2]]))[0].report as ReportT;
    const poisoned = JSON.parse(JSON.stringify(row)) as ReportT;
    (poisoned.findings[0]!.problem as { template: string }).template = "Це дасть +12 % конверсії.";
    await q(s, "UPDATE audit_reports SET report = $2 WHERE audit_run_id = $1", [ids[2], JSON.stringify(poisoned)]);
    const r = await s.api.inject({ method: "GET", url: `/api/audits/${ids[2]}/report` });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.class).toBe("report_unavailable");
    expect(r.body).not.toContain("12 %");
    await q(s, "UPDATE audit_reports SET report = $2 WHERE audit_run_id = $1", [ids[2], JSON.stringify(row)]);
    expect((await s.api.inject({ method: "GET", url: `/api/audits/${ids[2]}/report` })).statusCode).toBe(200);
    save("guard-scan-api.json", { reports_scanned: reports.length, fields_checked: reports.map((x) => scanReport(x).fields_checked), clean: true, control_uk: { clean: s1.clean, violation: s1.violations[0] }, control_en_clean: scanReport(bad2).clean, api_poisoned_status: 503 });
  });

  it("ідемпотентність: повторна доставка aggregate_findings/generate_report → findings, recommendations, evidence і пріоритети без змін; audit_reports — один рядок", async () => {
    const id = ids[0]!;
    const snap = async () => JSON.stringify(await Promise.all([
      q(s, "SELECT id, priority, confidence, title FROM findings WHERE audit_run_id = $1 ORDER BY id", [id]), q(s, "SELECT id, finding_id, recommended_change FROM recommendations WHERE audit_run_id = $1 ORDER BY id", [id]),
      q(s, "SELECT count(*)::int FROM evidence WHERE audit_run_id = $1", [id]), q(s, "SELECT count(*)::int FROM audit_reports WHERE audit_run_id = $1", [id]),
    ]));
    const before = await snap();
    // повторна доставка для термінального аудиту — no-op (liveAudit), а не дублювання
    const { aggregateJob } = await import("../src/jobs/aggregate.js");
    const { reportJob } = await import("../src/jobs/report.js");
    const job = { id: "x", name: "x", data: { auditRunId: id }, retryCount: 0 } as never;
    await aggregateJob(s.rt, job);
    await reportJob(s.rt, job);
    expect(await snap()).toBe(before);
  });
});

describe("B. scripted-fake LLM: профіль → задачі → лінзи → матриця → snapshot + журнали → агрегація → звіт", () => {
  let s: Stack;
  const fake = new DynamicFake({ frictionLensIds: ["l01", "l03", "l05", "l07"], hostileLensId: "l02" });
  const journeyCalls: string[] = [];
  const journal: JournalRunner = async (i) => {
    journeyCalls.push(i.scenarioId);
    return {
      status: "done", non_get_blocked: 0, calls: [],
      session: {
        session_id: "ses_" + i.scenarioId.slice(3), success: "true", actions_used: 2, frictions: [], positive_signals: ["Шлях пройдено."], uncertainties: [], final_summary: "Журнал пройдено (fake-виконавець).",
        pages_seen: [new URL(i.startUrl).pathname], steps: [{ action: "click", target: "link:\"Каталог\"", reason_summary: "Перехід до каталогу.", task_progress: "Каталог відкрито.", friction_detected: [] }, { action: "stop_success", target: "", reason_summary: "Мету досягнуто.", task_progress: "Готово.", friction_detected: [] }],
      },
    };
  };
  const ids: string[] = [];
  const reports: ReportT[] = [];
  it("3 аудити: усі LLM-етапи done, сценарії snapshot виконано, журнали виконано fake-виконавцем; звіт валідний", async () => {
    s = await startStack({ llmMode: "replay", fake, journal });
    for (let i = 0; i < 3; i++) {
      const id = await submit(s);
      ids.push(id);
      const st = await waitDone(s, id);
      expect(st.status, JSON.stringify(st.error)).toBe("completed");
      for (const k of ["site_profile", "tasks", "lenses", "scenario_matrix", "snapshot_sessions", "browser_sessions", "aggregate", "report"]) expect(st.stage_status[k], `${k}: ${JSON.stringify(st.stage_status[k])}`).toMatchObject({ status: "done" });
      expect(st.progress.scenarios_total).toBeGreaterThan(20);
      expect(st.progress.scenarios_done).toBe(st.progress.scenarios_total);
      expect(st.steps?.every((x) => x.state === "done")).toBe(true);
      reports.push(await getReport(s, id));
    }
    expect(reports[0]!.audit.llm_mode).toBe("replay");
    expect(reports[0]!.audit.banners.map((b) => b.code)).toContain("replay_not_live");
    save("report-api-shop-fake.json", reports[0]);
  }, 1_500_000);

  it("БД (§35 відтворюваність): профіль, задачі, лінзи, сценарії, сесії, llm_calls (хеш запиту, сирий вихід, версія промпту), токени E4 = сума викликів", async () => {
    const id = ids[0]!;
    const c = (await q(s, `SELECT (SELECT count(*) FROM site_profiles WHERE audit_run_id=$1)::int AS profile, (SELECT count(*) FROM customer_tasks WHERE audit_run_id=$1)::int AS tasks,
      (SELECT count(*) FROM behavioral_lenses WHERE audit_run_id=$1)::int AS lenses, (SELECT count(*) FROM scenarios WHERE audit_run_id=$1 AND level='snapshot')::int AS snap_sc,
      (SELECT count(*) FROM scenarios WHERE audit_run_id=$1 AND level='journey')::int AS journey_sc, (SELECT count(*) FROM synthetic_sessions WHERE audit_run_id=$1 AND level='snapshot')::int AS snap_ses,
      (SELECT count(*) FROM synthetic_sessions WHERE audit_run_id=$1 AND level='journey')::int AS journey_ses, (SELECT count(*) FROM audit_jobs WHERE audit_run_id=$1 AND kind='snapshot' AND status='done')::int AS snap_jobs`, [id]))[0];
    expect(c.profile).toBe(1);
    expect(c.tasks).toBeGreaterThanOrEqual(4);
    expect(c.lenses).toBeGreaterThanOrEqual(8);
    expect(c.snap_sc).toBeGreaterThanOrEqual(24);
    expect(c.snap_ses).toBe(c.snap_sc);
    expect(c.snap_jobs).toBe(c.snap_sc);
    expect(c.journey_sc).toBeGreaterThan(0);
    expect(c.journey_ses).toBe(c.journey_sc);
    const calls = await q(s, "SELECT stage, prompt_version, request_hash, response_json, status, input_tokens, output_tokens FROM llm_calls WHERE audit_run_id = $1", [id]);
    expect(calls.length).toBeGreaterThanOrEqual(3 + c.snap_sc);
    for (const x of calls) {
      expect(x.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.prompt_version).toMatch(/-v\d+$/);
      if (x.status === "ok") expect(x.response_json).not.toBeNull();
    }
    const a = (await q(s, "SELECT tokens_input, tokens_output, llm_provider, llm_model, prompt_version, snapshot_at FROM audit_runs WHERE id = $1", [id]))[0];
    expect(Number(a.tokens_input)).toBe(calls.reduce((t, x) => t + (x.input_tokens ?? 0), 0));
    expect(Number(a.tokens_output)).toBe(calls.reduce((t, x) => t + (x.output_tokens ?? 0), 0));
    expect(a.llm_model).toBe("scripted-fake");
    expect(a.snapshot_at).not.toBeNull();
    evidenceOut["fake_run_db"] = { ...c, llm_calls: calls.length, tokens_input: Number(a.tokens_input), tokens_output: Number(a.tokens_output) };
  });

  it("звіт: синтетичні докази й «N of M synthetic» із застереженням; вигадана цитата відхилена кодом (§23) і не потрапила ні у звіт, ні в БД", async () => {
    const r = reports[0]!;
    const synth = r.evidence.filter((e) => e.source_class === "SYNTHETIC");
    expect(synth.length).toBeGreaterThan(0);
    const withCounts = r.findings.filter((f) => f.synthetic.session_frequency !== null);
    expect(withCounts.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).toContain("synthetic_single_model_correlated");
    expect(JSON.stringify(r)).not.toContain(HOSTILE_QUOTE);
    expect(await q(s, "SELECT 1 FROM evidence WHERE audit_run_id = $1 AND excerpt LIKE $2", [ids[0], `%${HOSTILE_QUOTE}%`])).toEqual([]);
    const agg = (await q(s, "SELECT stage_status->'aggregate'->>'reason' AS r FROM audit_runs WHERE id = $1", [ids[0]]))[0].r as string;
    expect(agg).toMatch(/відхилено тверджень без доказу 1\b/);
    // детерміновані 7/7 не потонули під синтетикою
    const det = detected(r);
    expect(det.filter((d) => d.verified && (d.rank ?? 99) <= 10).length).toBe(7);
    expect(scanReport(r).clean).toBe(true);
  });

  it("критерій 1 (SQL) на аудиті з LLM: знахідок без доказу 0; рекомендацій без знахідки 0; SYNTHETIC-докази мають сесію й лінзу", async () => {
    for (const id of ids) {
      expect(await q(s, SQL_FINDINGS_NO_EVIDENCE, [id])).toEqual([]);
      expect(await q(s, SQL_RECS_NO_FINDING, [id])).toEqual([]);
    }
    expect(await q(s, "SELECT id FROM evidence WHERE audit_run_id = $1 AND source_class = 'SYNTHETIC' AND (session_id IS NULL OR lens_id IS NULL)", [ids[0]])).toEqual([]);
    expect((await q(s, "SELECT count(*)::int AS n FROM evidence WHERE audit_run_id = $1 AND source_class = 'SYNTHETIC'", [ids[0]]))[0].n).toBeGreaterThan(0);
  });

  it("критерій 6 (scripted-fake ×3): ідентичний порядок і числа пріоритетів", () => {
    const v = reports.map(rankView);
    expect(v[1]).toEqual(v[0]);
    expect(v[2]).toEqual(v[0]);
    save("priority-determinism-fake.json", { runs: ids.length, identical: true, findings: v[0]!.length, top10: v[0]!.slice(0, 10) });
  });

  it("ідемпотентність і повторна доставка: snapshot/browser/aggregate/report для завершеного аудиту — no-op; для живого — маркер audit_jobs не дає повторного виклику LLM", async () => {
    const id = ids[0]!;
    const before = JSON.stringify(await Promise.all([q(s, "SELECT count(*)::int FROM synthetic_sessions WHERE audit_run_id=$1", [id]), q(s, "SELECT count(*)::int FROM llm_calls WHERE audit_run_id=$1", [id]), q(s, "SELECT tokens_input, tokens_output FROM audit_runs WHERE id=$1", [id])]));
    const { snapshotJob, browserJob } = await import("../src/jobs/scenarios.js");
    const sc = (await q(s, "SELECT id FROM scenarios WHERE audit_run_id = $1 AND level = 'snapshot' LIMIT 1", [id]))[0].id as string;
    const jc = (await q(s, "SELECT id FROM scenarios WHERE audit_run_id = $1 AND level = 'journey' LIMIT 1", [id]))[0].id as string;
    const received = fake.received.length;
    await snapshotJob(s.rt, { id: "x", name: "run_snapshot_scenario", data: { auditRunId: id, scenarioId: sc }, retryCount: 0 } as never);
    await browserJob(s.rt, { id: "x", name: "run_browser_scenario", data: { auditRunId: id, scenarioId: jc }, retryCount: 0 } as never);
    expect(fake.received.length).toBe(received);
    expect(JSON.stringify(await Promise.all([q(s, "SELECT count(*)::int FROM synthetic_sessions WHERE audit_run_id=$1", [id]), q(s, "SELECT count(*)::int FROM llm_calls WHERE audit_run_id=$1", [id]), q(s, "SELECT tokens_input, tokens_output FROM audit_runs WHERE id=$1", [id])]))).toBe(before);
  });

  it("run_browser_scenario без виконавця: чиста поведінка — `skipped` з причиною journal_executor_unavailable, етап browser_sessions skipped, аудит completed зі знахідками snapshot", async () => {
    const s2 = await startStack({ llmMode: "replay", fake: new DynamicFake({ frictionLensIds: ["l01"] }), journal: null });
    const id = await submit(s2);
    const st = await waitDone(s2, id);
    expect(st.status).toBe("completed");
    expect(st.stage_status["snapshot_sessions"]).toMatchObject({ status: "done" });
    expect(st.stage_status["browser_sessions"]).toMatchObject({ status: "skipped" });
    expect(JSON.stringify(st.stage_status["browser_sessions"])).toContain("journal_executor_unavailable");
    expect(st.steps?.find((x) => x.id === "testing_journeys")?.state).toBe("done");
    expect((await q(s2, "SELECT count(*)::int AS n FROM synthetic_sessions WHERE audit_run_id=$1 AND level='journey'", [id]))[0].n).toBe(0);
    expect((await getReport(s2, id)).audit.stage_status["browser_sessions"]?.status).toBe("skipped");
  }, 600_000);

  it("бюджет: MAX_AUDIT_TOKENS (40 000) вичерпано посеред аудиту → етап budget_limited з причиною, аудит completed, звіт валідний (не «done»)", async () => {
    const s3 = await startStack({ llmMode: "replay", journal });
    useFakeLlm(s3.rt, new DynamicFake({ frictionLensIds: ["l01"] }), 40_000); // вистачає на профіль/задачі/лінзи й частину snapshot, але не на всі
    const id = await submit(s3);
    const st = await waitDone(s3, id);
    expect(st.status, JSON.stringify(st.error)).toBe("completed");
    const states = Object.fromEntries(Object.entries(st.stage_status).map(([k, v]) => [k, (v as { status: string }).status]));
    expect(Object.values(states)).toContain("budget_limited");
    evidenceOut["budget_states"] = states;
    const r = await getReport(s3, id);
    expect(r.audit.banners.map((b) => b.code)).toContain("budget_limited");
    const used = Number((await q(s3, "SELECT tokens_input + tokens_output AS t FROM audit_runs WHERE id=$1", [id]))[0].t);
    evidenceOut["budget_used_tokens"] = { max: 40_000, used };
    expect(used).toBeLessThanOrEqual(40_000 + 4 * 5000); // ліміт «м'який» на паралельність snapshot (4 задачі одночасно бачать той самий залишок) — документовано, DEV-68
    expect(await q(s3, SQL_FINDINGS_NO_EVIDENCE, [id])).toEqual([]);
  }, 600_000);
});

afterAll(() => save("e2e-evidence.json", evidenceOut));
