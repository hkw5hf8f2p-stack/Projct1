/**
 * Fail-open текстів знахідок (DEV-98): модель на finding-aggregator/recommendation падає (error) або висить (hang) —
 * аудит однаково completed за розумний час, звіт є, знахідки з кодовими текстами (не generic), finding_texts порожня.
 * Контекст (основний тест — report-texts.e2e): DEV-96…DEV-98 наскрізно: fixtures/shop через API → worker (PostgreSQL, pg-boss, Chromium) → GET /report зі scripted-fake LLM,
 * що пише friction як жива модель (цитата + коментар, `NOT_FOUND: …` з числом) і відповідає на finding-aggregator-v1 / recommendation-v1.
 * Перевіряє плумбінг текстів моделі до звіту, а не якість моделі (⏭️ живий пас).
 *  - частка SYNTHETIC-доказів з описом-заглушкою `evidence.llm.fallback` = 0 (живий kredens: 98/98);
 *  - групи з текстом finding-aggregator-v1 → заголовок від моделі, ніде `finding.title.generic`, рекомендація recommendation-v1;
 *  - тексти знахідок у БД (finding_texts + llm_calls, токени E4) і читаються знову з БД (переживають рестарт);
 *  - детерміновані дефекти фікстури 7/7 VERIFIED у топ-10 (не зламано).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type JournalRunner, type Runtime } from "../src/runtime.js";
import { DynamicFake, useFakeLlm } from "./helpers/fake-llm.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const EXPECTED = JSON.parse(readFileSync(path.join(ROOT, "fixtures/shop/EXPECTED.json"), "utf8")) as { defects: Array<{ id: number; type: string; categories: string[]; page_groups: string[]; detector_id: string | null; detector_ids?: string[] }> };
process.env["LOG_LEVEL"] = "silent";
const art = mkdtempSync(path.join(os.tmpdir(), "sl-texts-fo-art-"));
let cluster: TestCluster;
let shop: FixtureServer;
let guard: { stop(): number[] };
let db: FreshDb; let boss: PgBoss; let rt: Runtime; let api: FastifyInstance;

const journal: JournalRunner = async (i) => ({
  status: "done", non_get_blocked: 0, calls: [],
  session: {
    session_id: "ses_" + i.scenarioId.slice(3), success: "true", actions_used: 1, frictions: [], positive_signals: ["Шлях пройдено."], uncertainties: [], final_summary: "Журнал пройдено (fake-виконавець).",
    pages_seen: [new URL(i.startUrl).pathname], steps: [{ action: "stop_success", target: "", reason_summary: "Мету досягнуто.", task_progress: "Готово.", friction_detected: [] }],
  },
});

function detected(r: ReportT) {
  return EXPECTED.defects.filter((d) => d.type === "deterministic").map((d) => {
    const dets = d.detector_ids ?? [d.detector_id];
    const f = r.findings.find((x) => d.categories.includes(x.category) && (d.page_groups.includes("*") || d.page_groups.includes(x.page_group)) && x.evidence_ids.some((id) => dets.includes(r.evidence.find((e) => e.id === id)?.detector_id ?? "")));
    return { id: d.id, verified: f?.confidence.level === "VERIFIED", rank: f?.rank ?? null };
  });
}

const stacks: Array<{ db: FreshDb; boss: PgBoss; rt: Runtime; api: FastifyInstance }> = [];
beforeAll(async () => {
  guard = guardTestProcesses();
  cluster = await startTestCluster();
  shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }) });
  process.env["FINDING_TEXT_GROUP_TIMEOUT_MS"] = "1500";
  process.env["FINDING_TEXT_TOTAL_MS"] = "5000";
}, 120_000);
afterAll(async () => {
  delete process.env["FINDING_TEXT_GROUP_TIMEOUT_MS"]; delete process.env["FINDING_TEXT_TOTAL_MS"];
  for (const s of stacks) {
    await s.api.close();
    await s.boss.stop({ graceful: false, close: true, timeout: 3000 }).catch(() => undefined);
    await s.rt.close();
    await s.db.drop();
  }
  await shop?.close();
  await cluster?.stop();
  guard?.stop();
  rmSync(art, { recursive: true, force: true });
});

async function runAudit(mode: "error" | "hang") {
  db = await freshDatabase(cluster.url);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids-" + mode), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1" } as NodeJS.ProcessEnv);
  boss = createBoss(db.url, { supervise: true, max: 10 });
  await startBoss(boss);
  rt = createRuntime(cfg, db.pool, boss);
  rt.log = () => undefined;
  useFakeLlm(rt, new DynamicFake({ frictionLensIds: ["l01", "l03", "l05", "l07"], richFrictions: true, findingTexts: mode }));
  rt.journalRunner = journal;
  await registerHandlers(rt);
  api = await buildServer({ cfg, pool: db.pool, boss, llmMode: "replay" });
  stacks.push({ db, boss, rt, api });
  const id = CreateAuditResponse.parse((await api.inject({ method: "POST", url: "/api/audits", payload: { url: shop.origin + "/" } })).json()).auditId;
  const t0 = Date.now();
  let aggStart = 0, aggEnd = 0;
  for (;;) {
    const st = AuditStatusResponse.parse((await api.inject({ method: "GET", url: `/api/audits/${id}` })).json());
    if (!aggStart && st.status === "aggregating") aggStart = Date.now();
    if (st.status === "completed" || st.status === "failed") { aggEnd = Date.now(); expect(st.status, JSON.stringify(st.error)).toBe("completed"); break; }
    if (Date.now() - t0 > 600_000) throw new Error(`аудит завис: ${st.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const res = await api.inject({ method: "GET", url: `/api/audits/${id}/report` });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return { id, report: Report.parse(res.json()), aggregateMs: aggStart ? aggEnd - aggStart : null };
}

for (const mode of ["error", "hang"] as const) {
  describe(`тексти знахідок: модель ${mode === "error" ? "падає (HTTP 500)" : "висить (без відповіді)"} → аудит completed, кодові тексти`, () => {
    it("completed; звіт є; finding_texts порожня; заголовки не generic; fallback доказів 0; 7/7", async () => {
      const { id, report, aggregateMs } = await runAudit(mode);
      console.log(`${mode}: aggregate→completed ${aggregateMs} мс`);
      if (aggregateMs !== null) expect(aggregateMs).toBeLessThan(60_000); // межа 5 с на тексти + решта агрегації/звіту
      expect((await db.pool.query("SELECT count(*)::int AS n FROM finding_texts WHERE audit_run_id = $1", [id])).rows[0].n).toBe(0);
      const reason = (await db.pool.query("SELECT stage_status->'aggregate'->>'reason' AS r, stage_status->'aggregate'->>'status' AS s FROM audit_runs WHERE id = $1", [id])).rows[0];
      expect(reason.s).toBe("done");
      expect(reason.r).toMatch(mode === "error" ? /збій [1-9]/ : /тайм-аут [1-9]/);
      expect(report.findings.filter((f) => f.title.template_id === "finding.title.generic")).toEqual([]);
      expect(report.findings.some((f) => f.title.template_id === "finding-aggregator-v1")).toBe(false);
      expect(report.evidence.filter((e) => e.source_class === "SYNTHETIC" && e.description.template_id === "evidence.llm.fallback")).toEqual([]);
      expect(scanReport(report).clean).toBe(true);
      expect(detected(report).filter((d) => d.verified && (d.rank ?? 99) <= 10).length).toBe(7);
    }, 900_000);
  });
}
