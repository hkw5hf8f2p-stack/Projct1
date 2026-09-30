/**
 * run_snapshot_scenario / run_browser_scenario + join (SPEC §19A/§19B, §47). Кожен сценарій — окрема ідемпотентна задача: маркер завершення — рядок audit_jobs
 * (`snapshot:<id>` / `browser:<id>`), що пишеться в ОДНІЙ транзакції з synthetic_sessions, llm_calls і токенами. Останній сценарій «замикає» join:
 * стани етапів snapshot_sessions/browser_sessions, статус aggregating, enqueue aggregate_findings — один раз (прапорець у config_json під FOR UPDATE).
 */
import type { Job } from "pg-boss";
import type { PoolClient } from "pg";
import { evaluateSnapshot, type CallRecord } from "@sitelens/llm";
import { Q, addWarning, advanceStatus, auditDir, enqueue, getJob, setStage, txDb, upsertJob, upsertSession, type JobData, type AuditRow } from "@sitelens/pipeline";
import type { Runtime } from "../runtime.js";
import { advanceIsFinal, liveAudit, TERMINAL } from "./common.js";
import { loadLenses, loadTasks, pageInputFromRow, recordCalls, withTx } from "../llm-store.js";

const norm = (u: string): string => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ""); } catch { return u; } };

/** сторінка сценарію: recommended_start_page завдання → інакше головна → інакше перша за id (лише успішно захоплені) */
async function pickPage(rt: Runtime, auditId: string, startUrl: string) {
  const rows = (await rt.pool.query("SELECT * FROM page_artifacts WHERE audit_run_id = $1 AND NOT (technical_json ? 'capture_error') ORDER BY id", [auditId])).rows;
  return rows.find((r) => norm(r.url) === norm(startUrl)) ?? rows.find((r) => r.page_type === "homepage") ?? rows[0] ?? null;
}

type Outcome = { status: "done" | "skipped" | "failed"; reason?: string; error?: string; result: Record<string, unknown> };

async function finish(rt: Runtime, audit: AuditRow, kind: "snapshot" | "browser", key: string, tx: (c: PoolClient) => Promise<void>, o: Outcome): Promise<void> {
  const url = null;
  await withTx(rt.pool, async (c) => {
    await tx(c);
    await upsertJob(c, { audit_run_id: audit.id, job_key: key, kind, page_url: url, status: o.status, error_class: null, error: o.status === "failed" ? (o.error ?? o.reason ?? "збій").slice(0, 1000) : null, result_json: { ...(o.reason ? { reason: o.reason } : {}), ...o.result } });
    if (o.status === "failed") await addWarning(c, audit.id, { stage: kind === "snapshot" ? "snapshot_sessions" : "browser_sessions", message: `${key}: ${(o.error ?? o.reason ?? "збій").slice(0, 200)}` });
  });
}

const tokensOf = (calls: readonly CallRecord[]) => ({ input: calls.reduce((a, r) => a + r.input_tokens, 0), output: calls.reduce((a, r) => a + r.output_tokens, 0), calls: calls.length });

export async function snapshotJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const { auditRunId: id, scenarioId } = job.data as JobData & { scenarioId: string };
  const audit = await liveAudit(rt, id);
  if (!audit) return;
  const key = `snapshot:${scenarioId}`;
  if (await getJob(rt.pool, id, key)) { await advancePostScenarios(rt, id); return; }
  const sc = (await rt.pool.query("SELECT * FROM scenarios WHERE audit_run_id = $1 AND id = $2 AND level = 'snapshot'", [id, scenarioId])).rows[0];
  if (!sc) throw new Error(`сценарій ${scenarioId} не знайдено`);
  const lens = (await loadLenses(rt.pool, id)).find((l) => l.id === sc.lens_id)!;
  const task = (await loadTasks(rt.pool, id)).find((t) => t.task_id === sc.task_id)!;
  const row = await pickPage(rt, id, task.recommended_start_page);
  const bail = async (o: Outcome): Promise<void> => { await finish(rt, audit, "snapshot", key, async () => undefined, o); await advancePostScenarios(rt, id); };
  if (!row) return bail({ status: "failed", error: "немає захопленої сторінки для сценарію", result: {} });
  const { page, viewportHeight, imageRel } = pageInputFromRow(auditDir(rt.cfg.artifactDir, id), row, sc.device === "mobile" ? "mobile" : "desktop");
  if (!page.image) return bail({ status: "failed", error: `немає скриншота першого вікна (${sc.device ?? "desktop"}) сторінки ${page.id}`, result: { page: page.id } });
  const h = await rt.llm(audit);
  let res: Awaited<ReturnType<typeof evaluateSnapshot>>;
  try {
    res = await evaluateSnapshot(
      { audit_run_id: id, client: h.client, language: audit.language },
      {
        page, lens, task: { id: task.task_id, name: task.name, goal: task.goal, task_type: task.task_type },
        tiles: [{ id: "t0", y_css: 0, height_css: viewportHeight ?? 1000, image: page.image }], tiles_total: 1,
        a11y_outline: ((row.aria_snapshot as string | null) ?? "").slice(0, 3000),
      },
    );
  } catch (e) {
    // ReplayMissError / ConfigError — гучні: повтор, а на останній спробі — запис збою (§47: збій сценарію ≠ збій аудиту)
    if (!isFinal(job)) throw e;
    return bail({ status: "failed", error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400), result: { page: page.id } });
  }
  const tok = tokensOf(res.calls);
  await finish(rt, audit, "snapshot", key, async (c) => {
    const ids = await recordCalls(c, h.client, id, key, res.calls);
    if (res.status === "done" && res.output) {
      const s = res.output.session;
      await upsertSession(c, id, { session_id: s.session_id, lens_id: s.lens_id, task_id: s.task_id, level: "snapshot", success: s.success, actions_used: 0, frictions: s.frictions, positive_signals: s.positive_signals, uncertainties: s.uncertainties, final_summary: s.final_summary, steps: null, llm_call_ids: ids, prompt_version: res.prompt_id, pages_seen: s.pages_seen });
    }
  }, res.status === "done"
    ? { status: "done", result: { verdict: res.output?.verdict, page: page.id, screenshot: imageRel, tokens: tok } }
    : res.status === "budget_limited" ? { status: "skipped", reason: "budget_limited", result: { detail: res.reason, tokens: tok } }
    : res.status === "skipped" ? { status: "skipped", reason: res.reason ?? "skipped", result: { tokens: tok } }
    : { status: "failed", error: res.reason ?? "етап не виконано", result: { tokens: tok, rejected: res.rejected.slice(0, 5) } });
  await advancePostScenarios(rt, id);
}

const isFinal = (job: Job<JobData>): boolean => advanceIsFinal(job.name, job.retryCount);

export async function browserJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const { auditRunId: id, scenarioId } = job.data as JobData & { scenarioId: string };
  const audit = await liveAudit(rt, id);
  if (!audit) return;
  const key = `browser:${scenarioId}`;
  if (await getJob(rt.pool, id, key)) { await advancePostScenarios(rt, id); return; }
  const sc = (await rt.pool.query("SELECT * FROM scenarios WHERE audit_run_id = $1 AND id = $2 AND level = 'journey'", [id, scenarioId])).rows[0];
  if (!sc) throw new Error(`сценарій ${scenarioId} не знайдено`);
  const done = async (o: Outcome, tx: (c: PoolClient) => Promise<void> = async () => undefined) => { await finish(rt, audit, "browser", key, tx, o); await advancePostScenarios(rt, id); };
  if (!rt.journalRunner) return done({ status: "skipped", reason: "journal_executor_unavailable: виконавця журналів (packages/browser) не підключено до worker", result: {} });
  const lens = (await loadLenses(rt.pool, id)).find((l) => l.id === sc.lens_id)!;
  const task = (await loadTasks(rt.pool, id)).find((t) => t.task_id === sc.task_id)!;
  const h = await rt.llm(audit);
  let out: Awaited<ReturnType<NonNullable<Runtime["journalRunner"]>>>;
  try {
    out = await rt.journalRunner({ auditRunId: id, scenarioId, lens, task, startUrl: task.recommended_start_page, browser: () => rt.getBrowser(), gate: rt.gate, userAgent: rt.userAgent, client: h.client, language: audit.language, artifactDir: rt.cfg.artifactDir });
  } catch (e) {
    if (!isFinal(job)) throw e;
    return done({ status: "failed", error: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 400), result: {} });
  }
  const tok = tokensOf(out.calls);
  const result = { tokens: tok, non_get_blocked: out.non_get_blocked ?? 0 };
  if (out.status === "done" && out.session) {
    const s = out.session;
    return done({ status: "done", result }, async (c) => {
      const ids = await recordCalls(c, h.client, id, key, out.calls);
      await upsertSession(c, id, { session_id: s.session_id, lens_id: lens.id, task_id: task.task_id, level: "journey", success: s.success, actions_used: s.actions_used, frictions: s.frictions, positive_signals: s.positive_signals, uncertainties: s.uncertainties, final_summary: s.final_summary, steps: s.steps, llm_call_ids: ids, prompt_version: "browser-agent-v1", pages_seen: s.pages_seen });
    });
  }
  const tx = async (c: PoolClient) => { await recordCalls(c, h.client, id, key, out.calls); };
  if (out.status === "budget_limited") return done({ status: "skipped", reason: "budget_limited", result: { ...result, detail: out.reason } }, tx);
  if (out.status === "skipped") return done({ status: "skipped", reason: out.reason ?? "skipped", result }, tx);
  return done({ status: "failed", error: out.reason ?? "журнал не виконано", result }, tx);
}

interface JobRow { job_key: string; kind: string; status: string; error: string | null; result_json: { reason?: string } }
function stageOf(rows: JobRow[], kind: "snapshot" | "browser"): { status: "done" | "skipped" | "budget_limited" | "failed"; reason?: string } {
  const mine = rows.filter((r) => r.kind === kind);
  if (mine.length === 0) return { status: "skipped", reason: "немає сценаріїв цього рівня" };
  const d = mine.filter((r) => r.status === "done").length;
  const budget = mine.filter((r) => r.status === "skipped" && r.result_json.reason === "budget_limited").length;
  const failed = mine.filter((r) => r.status === "failed").length;
  if (budget > 0) return { status: "budget_limited", reason: `обмежено бюджетом MAX_AUDIT_TOKENS: виконано ${d} з ${mine.length} сценаріїв` };
  if (d === 0) {
    if (failed > 0) return { status: "failed", reason: `усі ${mine.length} сценаріїв завершились помилкою (${failed} збій)` };
    return { status: "skipped", reason: (mine[0]?.result_json.reason ?? "сценарії пропущено").slice(0, 300) };
  }
  return failed > 0 ? { status: "done", reason: `часткові результати: ${failed} з ${mine.length} сценаріїв з помилкою` } : { status: "done" };
}

/** join після веєра: усі очікувані сценарії мають запис у audit_jobs → ОДИН раз виставити стани, aggregating і поставити aggregate_findings */
export async function advancePostScenarios(rt: Runtime, auditId: string): Promise<boolean> {
  const c = await rt.pool.connect();
  try {
    await c.query("BEGIN");
    const a = (await c.query("SELECT status, config_json FROM audit_runs WHERE id = $1 FOR UPDATE", [auditId])).rows[0] as { status: string; config_json: Record<string, unknown> } | undefined;
    if (!a || TERMINAL.has(a.status) || !a.config_json["scenarios_enqueued"] || a.config_json["scenarios_advanced"]) { await c.query("COMMIT"); return false; }
    const expected = (a.config_json["expected_scenarios"] as string[] | undefined) ?? [];
    const rows = (await c.query("SELECT job_key, kind, status, error, result_json FROM audit_jobs WHERE audit_run_id = $1 AND kind IN ('snapshot','browser')", [auditId])).rows as JobRow[];
    const have = new Set(rows.map((r) => r.job_key));
    if (!expected.every((k) => have.has(k))) { await c.query("COMMIT"); return false; }
    for (const [kind, stage] of [["snapshot", "snapshot_sessions"], ["browser", "browser_sessions"]] as const) {
      const s = stageOf(rows, kind);
      await setStage(c, auditId, stage, s.status, s.reason);
    }
    await c.query("UPDATE audit_runs SET config_json = config_json || '{\"scenarios_advanced\": true}'::jsonb WHERE id = $1", [auditId]);
    await advanceStatus(c, auditId, "aggregating");
    await enqueue(rt.boss, Q.aggregate, { auditRunId: auditId }, { db: txDb(c) });
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
