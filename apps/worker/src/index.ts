/**
 * Worker (pnpm worker; з браузером — від sitelens: bash scripts/run-as-sitelens.sh pnpm worker). Черга pg-boss, задачі SPEC §47.
 * Старт: єдиний екземпляр (PID-файл) → прибирання сиріт за PID-файлом попереднього worker (лише записані PID) → повернення в чергу задач,
 * що зависли `active` від мертвого worker → реєстрація обробників. Не мігрує БД (pnpm db:migrate).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "pg-boss";
import { cleanupOrphansFromFile, isSameProc, loadDotEnv, pg, readPidFile } from "@sitelens/db";
import { Q, QUEUE_SPECS, createBoss, describeConfig, loadConfig, startBoss, sweepExpiredArtifacts, type JobData, type QueueName } from "@sitelens/pipeline";
import { accessibilityJob } from "./jobs/accessibility.js";
import { aggregateJob } from "./jobs/aggregate.js";
import { captureJob } from "./jobs/capture.js";
import { crawlJob } from "./jobs/crawl.js";
import { LLM_JOBS, llmStageJob } from "./jobs/llm.js";
import { lighthouseJob } from "./jobs/lighthouse.js";
import { startProcWatch } from "./procwatch.js";
import { createRuntime, type Runtime } from "./runtime.js";

loadDotEnv();
const cfg = loadConfig();
mkdirSync(cfg.pidDir, { recursive: true });
mkdirSync(cfg.logDir, { recursive: true });
const pidFile = path.join(cfg.pidDir, "worker.json");

const prev = readPidFile(pidFile);
if (prev && prev.pid !== process.pid && isSameProc(prev)) {
  console.error(JSON.stringify({ level: "fatal", msg: `інший worker уже працює (pid ${prev.pid}); одночасно — один екземпляр` }));
  process.exit(5);
}
const cleanup = cleanupOrphansFromFile(pidFile);
if (cleanup.owner_pid !== null) writeFileSync(path.join(cfg.logDir, `recovery-${Date.now()}.json`), JSON.stringify({ ts: new Date().toISOString(), ...cleanup }, null, 2) + "\n");
const watch = startProcWatch(pidFile);

const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 8, application_name: "sitelens-worker" });
pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "pg pool", err: e.message })));
try {
  await pool.query("SELECT 1");
} catch (e) {
  console.error(JSON.stringify({ level: "fatal", msg: `БД недоступна: ${(e as Error).message}. Запустіть pnpm db:start && pnpm db:migrate` }));
  process.exit(4);
}
const boss = createBoss(cfg.databaseUrl, { supervise: true, max: 10, application_name: "sitelens-worker-boss" });
await startBoss(boss);
const rt: Runtime = createRuntime(cfg, pool, boss);

/** Задачі, що лишились `active` від мертвого worker → fail() → pg-boss повертає їх у чергу (retry), бо retryLimit > 0. */
let requeued = 0;
if (cleanup.owner_pid !== null && !cleanup.owner_was_alive) {
  for (const name of Object.keys(QUEUE_SPECS)) {
    const ids = (await pool.query("SELECT id FROM pgboss.job WHERE name = $1 AND state = 'active'", [name])).rows.map((r) => r.id as string);
    if (ids.length) {
      await boss.fail(name, ids, { reason: "worker died (kill -9 / crash); recovered at startup" });
      requeued += ids.length;
    }
  }
}
rt.log("info", "worker started", { pid: process.pid, cleanup: { killed: cleanup.killed, already_gone: cleanup.already_gone.length, requeued_jobs: requeued }, config: describeConfig(cfg) });

const handler = (name: QueueName, fn: (rt: Runtime, job: Job<JobData>) => Promise<void>) => async (jobs: Job<JobData>[]) => {
  for (const job of jobs) {
    const t0 = Date.now();
    try {
      await fn(rt, job);
      rt.log("info", "job done", { queue: name, job: job.id, audit: job.data.auditRunId, retry: job.retryCount, ms: Date.now() - t0 });
    } catch (e) {
      rt.log("error", "job failed (буде повтор, якщо лишились спроби)", { queue: name, job: job.id, audit: job.data.auditRunId, retry: job.retryCount, err: String((e as Error).message).slice(0, 300) });
      throw e;
    }
  }
};
const reg = async (name: QueueName, fn: (rt: Runtime, job: Job<JobData>) => Promise<void>) =>
  boss.work<JobData>(name, { localConcurrency: QUEUE_SPECS[name].concurrency, batchSize: 1, pollingIntervalSeconds: 1 }, handler(name, fn));
await reg(Q.crawl, crawlJob);
await reg(Q.capture, captureJob);
await reg(Q.lighthouse, lighthouseJob);
await reg(Q.accessibility, accessibilityJob);
for (const name of Object.keys(LLM_JOBS)) await reg(name as QueueName, (r, j) => llmStageJob(r, name, j));
await reg(Q.aggregate, aggregateJob);

const sweep = async () => {
  try {
    const rep = await sweepExpiredArtifacts(pool, cfg.artifactDir);
    if (rep.expired.length) rt.log("info", "TTL sweep", { expired: rep.expired });
  } catch (e) {
    rt.log("error", "TTL sweep failed", { err: (e as Error).message });
  }
};
await sweep();
const sweepTimer = setInterval(sweep, cfg.ttlSweepIntervalMs);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(sweepTimer);
  await boss.stop({ graceful: false, close: true, timeout: 5000 }).catch(() => undefined);
  await rt.close();
  await pool.end().catch(() => undefined);
  watch.stop();
  rmSync(pidFile, { force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
