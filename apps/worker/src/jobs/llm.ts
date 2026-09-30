/**
 * LLM-етапи як задачі черги (build_site_profile → generate_tasks → generate_lenses → build_scenario_matrix), S4: виходи ЗБЕРІГАЮТЬСЯ в БД
 * (site_profiles / customer_tasks / behavioral_lenses / scenarios + llm_calls + токени) атомарно зі станом етапу. Після матриці — веєр
 * run_snapshot_scenario / run_browser_scenario (одна транзакція: рядки очікуваних задач у config_json + enqueue), далі — join у scenarios.ts → aggregate.
 * llm_mode=none (DEV-11): етап `skipped: no LLM provider`, aggregate йде одразу. Шлях live/replay перевірено на scripted fake/replay (плумбінг), не на якості моделі.
 */
import type { Job } from "pg-boss";
import { Q, advanceStatus, enqueue, setStage, txDb, type AuditRow, type JobData, type QueueName } from "@sitelens/pipeline";
import { buildScenarioMatrix, buildSiteProfile, generateLenses, generateTasks, type StageResult } from "@sitelens/llm";
import type { Runtime } from "../runtime.js";
import { liveAudit } from "./common.js";
import { commitStage, loadLenses, loadPageInputs, loadProfile, loadTasks, withTx, writeLenses, writeProfile, writeScenarios, writeTasks } from "../llm-store.js";

interface Spec { stage: "site_profile" | "tasks" | "lenses" | "scenario_matrix"; status: "profiling" | "generating_lenses" | "running_scenarios"; next: QueueName; upstream: Array<"site_profile" | "tasks" | "lenses"> }
export const LLM_JOBS: Record<string, Spec> = {
  [Q.profile]: { stage: "site_profile", status: "profiling", next: Q.tasks, upstream: [] },
  [Q.tasks]: { stage: "tasks", status: "profiling", next: Q.lenses, upstream: ["site_profile"] },
  [Q.lenses]: { stage: "lenses", status: "generating_lenses", next: Q.matrix, upstream: ["site_profile"] },
  [Q.matrix]: { stage: "scenario_matrix", status: "running_scenarios", next: Q.aggregate, upstream: ["tasks", "lenses"] },
};

export async function llmStageJob(rt: Runtime, name: string, job: Job<JobData>): Promise<void> {
  const spec = LLM_JOBS[name]!;
  const id = job.data.auditRunId;
  const audit = await liveAudit(rt, id);
  if (!audit) return;
  await advanceStatus(rt.pool, id, spec.status);
  if (!audit.stage_status[spec.stage]) await runStage(rt, audit, spec);
  if (spec.stage === "scenario_matrix") return; // веєр або aggregate ставить сам runStage/fanOut атомарно
  await enqueue(rt.boss, spec.next, { auditRunId: id });
}

async function runStage(rt: Runtime, audit: AuditRow, spec: Spec): Promise<void> {
  const id = audit.id;
  // matrix: стан етапу й enqueue(aggregate) — атомарно (повтор після збою не лишає аудит без наступної задачі)
  const skip = async (reason: string) => {
    if (spec.stage !== "scenario_matrix") return setStage(rt.pool, id, spec.stage, "skipped", reason);
    await withTx(rt.pool, async (c) => { await setStage(c, id, spec.stage, "skipped", reason); await enqueue(rt.boss, Q.aggregate, { auditRunId: id }, { db: txDb(c) }); });
  };
  if (audit.llm_mode === "none") return skip("no LLM provider");
  const bad = spec.upstream.find((u) => audit.stage_status[u]?.status !== "done");
  if (bad) return skip(`upstream ${bad} не завершено (${audit.stage_status[bad]?.status ?? "немає"})`);
  const h = await rt.llm(audit);
  if (h.client.mode === "none") return skip("no LLM provider");
  const ctx = { audit_run_id: id, client: h.client, language: audit.language };
  switch (spec.stage) {
    case "site_profile": {
      const pages = await loadPageInputs(rt.pool, rt.cfg.artifactDir, id);
      const r = await buildSiteProfile(ctx, { pages });
      await commitStage(rt.pool, id, h.client, "site_profile", r, async (c, ids) => writeProfile(c, id, r.output!.profile, r.prompt_id ?? "site-profile-v1", ids[0]));
      return;
    }
    case "tasks": {
      const pages = await loadPageInputs(rt.pool, rt.cfg.artifactDir, id);
      const profile = (await loadProfile(rt.pool, id))!;
      const r = await generateTasks(ctx, { pages, profile });
      await commitStage(rt.pool, id, h.client, "tasks", r, async (c) => writeTasks(c, id, r.output!.tasks));
      return;
    }
    case "lenses": {
      const profile = (await loadProfile(rt.pool, id))!;
      const r = await generateLenses(ctx, { profile });
      await commitStage(rt.pool, id, h.client, "lenses", r, async (c, ids) => writeLenses(c, id, r.output!.lenses, r.prompt_id ?? "lens-generator-v1", ids[0]));
      return;
    }
    case "scenario_matrix": {
      const [lenses, tasks] = [await loadLenses(rt.pool, id), await loadTasks(rt.pool, id)];
      const r: StageResult<unknown> = await buildScenarioMatrix(ctx, { lenses, tasks });
      const out = (r as Awaited<ReturnType<typeof buildScenarioMatrix>>).output;
      const dev = new Map((out?.snapshot_entries ?? []).map((e) => [`${e.lens_id}|${e.task_id}`, e.device]));
      const jdev = new Map((out?.fixed_journals ?? []).map((e) => [`${e.lens_id}|${e.task_id}`, e.device]));
      const all = out ? [
        ...out.scenarios.map((s) => ({ ...s, device: dev.get(`${s.lens_id}|${s.task_id}`) ?? "desktop" })),
        ...out.journal_scenarios.map((s) => ({ ...s, device: jdev.get(`${s.lens_id}|${s.task_id}`) ?? "desktop" })),
      ] : [];
      const seen = new Set<string>(); // UNIQUE (lens, task, level): одна пара — один сценарій (перший)
      const rows = all.filter((s) => { const k = `${s.lens_id}|${s.task_id}|${s.level}`; if (seen.has(k)) return false; seen.add(k); return true; });
      await commitStage(rt.pool, id, h.client, "scenario_matrix", r, async (c) => writeScenarios(c, id, rows), async (c) => {
        // веєр в ТІЙ САМІЙ транзакції: очікувані ключі + enqueue (як advancePostCrawl) — kill -9 не лишає етап без задач
        const keys = rows.map((s) => `${s.level === "snapshot" ? "snapshot" : "browser"}:${s.id}`);
        if (r.status !== "done" || keys.length === 0) { await enqueue(rt.boss, Q.aggregate, { auditRunId: id }, { db: txDb(c) }); return; }
        await c.query("UPDATE audit_runs SET config_json = config_json || $2::jsonb WHERE id = $1", [id, JSON.stringify({ expected_scenarios: keys, scenarios_enqueued: true })]);
        for (const s of rows) await enqueue(rt.boss, s.level === "snapshot" ? Q.snapshot : Q.browser, { auditRunId: id, scenarioId: s.id }, { db: txDb(c) });
      });
      return;
    }
  }
}
