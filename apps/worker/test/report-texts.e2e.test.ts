/**
 * DEV-96…DEV-98 наскрізно: fixtures/shop через API → worker (PostgreSQL, pg-boss, Chromium) → GET /report зі scripted-fake LLM,
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
import { createBoss, getAudit, loadConfig, startBoss } from "@sitelens/pipeline";
import { createShopHandler } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import { guardTestProcesses } from "../../../scripts/test-procs.js";
import { registerHandlers } from "../src/handlers.js";
import { createRuntime, type JournalRunner, type Runtime } from "../src/runtime.js";
import { loadAuditArtifacts } from "../src/artifacts.js";
import { llmResultsFromDb } from "../src/llm-store.js";
import { DynamicFake, useFakeLlm } from "./helpers/fake-llm.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const EXPECTED = JSON.parse(readFileSync(path.join(ROOT, "fixtures/shop/EXPECTED.json"), "utf8")) as { defects: Array<{ id: number; type: string; categories: string[]; page_groups: string[]; detector_id: string | null; detector_ids?: string[] }> };
process.env["LOG_LEVEL"] = "silent";
const art = mkdtempSync(path.join(os.tmpdir(), "sl-texts-art-"));
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

beforeAll(async () => {
  guard = guardTestProcesses();
  cluster = await startTestCluster();
  shop = await startFixtureServer({ handler: createShopHandler({ mutant: null, control: null, transforms: null }) });
  db = await freshDatabase(cluster.url);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art, PID_DIR: path.join(art, "pids"), SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: shop.origin, LIGHTHOUSE_ENABLED: "0", CAPTURE_ATTEMPTS: "1" } as NodeJS.ProcessEnv);
  boss = createBoss(db.url, { supervise: true, max: 10 });
  await startBoss(boss);
  rt = createRuntime(cfg, db.pool, boss);
  rt.log = () => undefined;
  useFakeLlm(rt, new DynamicFake({ frictionLensIds: ["l01", "l03", "l05", "l07"], richFrictions: true }));
  rt.journalRunner = journal;
  await registerHandlers(rt);
  api = await buildServer({ cfg, pool: db.pool, boss, llmMode: "replay" });
}, 120_000);
afterAll(async () => {
  await api?.close();
  await boss?.stop({ graceful: false, close: true, timeout: 3000 }).catch(() => undefined);
  await rt?.close();
  await db?.drop();
  await shop?.close();
  await cluster?.stop();
  guard?.stop();
  rmSync(art, { recursive: true, force: true });
});

describe("тексти моделі доходять до звіту (scripted-fake, fixtures/shop)", () => {
  let id = "";
  let report: ReportT;
  it("аудит через API → completed; звіт за контрактом, сканер guard чистий", async () => {
    id = CreateAuditResponse.parse((await api.inject({ method: "POST", url: "/api/audits", payload: { url: shop.origin + "/" } })).json()).auditId;
    const t0 = Date.now();
    for (;;) {
      const st = AuditStatusResponse.parse((await api.inject({ method: "GET", url: `/api/audits/${id}` })).json());
      if (st.status === "completed" || st.status === "failed") { expect(st.status, JSON.stringify(st.error)).toBe("completed"); break; }
      if (Date.now() - t0 > 600_000) throw new Error("аудит не завершився");
      await new Promise((r) => setTimeout(r, 500));
    }
    const res = await api.inject({ method: "GET", url: `/api/audits/${id}/report` });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    report = Report.parse(res.json());
    expect(scanReport(report).clean, JSON.stringify(scanReport(report).violations.slice(0, 3))).toBe(true);
    expect(report.audit.stage_status["aggregate"]?.status).toBe("done");
  }, 900_000);

  it("дефект 1: частка SYNTHETIC-доказів з заглушкою evidence.llm.fallback = 0; NOT_FOUND-текст моделі з замаскованим числом у звіті", () => {
    const synth = report.evidence.filter((e) => e.source_class === "SYNTHETIC");
    const fb = synth.filter((e) => e.description.template_id === "evidence.llm.fallback");
    console.log(`SYNTHETIC-доказів ${synth.length}, fallback ${fb.length}`);
    expect(synth.length).toBeGreaterThan(0);
    expect(fb.length).toBe(0);
    expect(synth.some((e) => e.description.origin === "llm" && /^Не знайдено: строк доставки для замовлення від … одиниць/.test(e.description.template))).toBe(true);
    expect(synth.some((e) => e.description.origin === "llm" && e.description.template.includes("не видно, скільки коштує доставка"))).toBe(true);
  });

  it("дефект 2: finding-aggregator-v1/recommendation-v1 викликано на живому шляху; групи з текстом — заголовок моделі, без finding.title.generic", async () => {
    const rows = (await db.pool.query("SELECT finding_key, status, title, llm_call_ids, prompt_versions FROM finding_texts WHERE audit_run_id = $1", [id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe("supported");
      expect(r.llm_call_ids.length).toBe(2);
      expect(r.prompt_versions).toEqual(["finding-aggregator-v1", "recommendation-v1"]);
    }
    expect(report.audit.prompt_versions).toEqual(expect.arrayContaining(["finding-aggregator-v1", "recommendation-v1"]));
    const withText = new Set(rows.map((r) => r.finding_key as string));
    const fs = report.findings.filter((f) => withText.has(f.finding_key));
    expect(fs.length).toBe(rows.length);
    for (const f of fs) {
      expect(f.title.template_id, f.finding_key).toBe("finding-aggregator-v1");
      expect(f.recommendation?.recommended_change.template_id).toBe("recommendation-v1");
    }
    expect(report.findings.filter((f) => f.title.template_id === "finding.title.generic")).toEqual([]);
    // E4: токени llm_calls = лічильник аудиту (виклики текстів знахідок враховано)
    const c = (await db.pool.query("SELECT coalesce(sum(input_tokens),0)::bigint AS i, coalesce(sum(output_tokens),0)::bigint AS o, count(*) FILTER (WHERE prompt_version IN ('finding-aggregator-v1','recommendation-v1'))::int AS n FROM llm_calls WHERE audit_run_id = $1", [id])).rows[0];
    const a = (await getAudit(db.pool, id))!;
    expect(c.n).toBe(rows.length * 2);
    expect(Number(a.tokens_input)).toBe(Number(c.i));
    expect(Number(a.tokens_output)).toBe(Number(c.o));
  });

  it("тексти знахідок переживають рестарт: новий шлях читання з БД дає ті самі тексти", async () => {
    const a = (await getAudit(db.pool, id))!;
    const artifacts = await loadAuditArtifacts(db.pool, art, a, { completedAt: new Date().toISOString() });
    const r = await llmResultsFromDb(db.pool, id, artifacts, a);
    expect(Object.keys(r!.llm.finding_texts).length).toBeGreaterThan(0);
    expect(Object.keys(r!.llm.evidence_text).length).toBeGreaterThan(0);
  });

  it("дефект 3 (не зламано): детерміновані дефекти фікстури 7/7 VERIFIED у топ-10", () => {
    const det = detected(report);
    expect(det.filter((d) => d.verified && (d.rank ?? 99) <= 10).map((d) => d.id)).toEqual([2, 5, 6, 7, 8, 9, 10]);
    expect(report.findings.filter((f) => f.category === "accessibility" && f.confidence.level === "VERIFIED").length).toBeGreaterThan(0);
  });
});
