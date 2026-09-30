/**
 * Worker (pnpm worker; з браузером — від sitelens: bash scripts/run-as-sitelens.sh pnpm worker). Черга pg-boss, задачі SPEC §47.
 * Старт: єдиний екземпляр (PID-файл) → прибирання сиріт за PID-файлом попереднього worker (лише записані PID) → повернення в чергу задач,
 * що зависли `active` від мертвого worker → реєстрація обробників. Не мігрує БД (pnpm db:migrate).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupOrphansFromFile, isSameProc, killOwnDescendants, loadDotEnv, pg, readPidFile, startProcWatch } from "@sitelens/db";
import { QUEUE_SPECS, createBoss, describeConfig, loadConfig, startBoss, sweepExpiredArtifacts } from "@sitelens/pipeline";
import { registerHandlers } from "./handlers.js";
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

await registerHandlers(rt);

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

process.on("exit", () => void killOwnDescendants()); // аварійний вихід (uncaught) теж не лишає дітей
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(sweepTimer);
  await boss.stop({ graceful: false, close: true, timeout: 5000 }).catch(() => undefined);
  await rt.close();
  killOwnDescendants(); // Chrome Lighthouse (chrome-launcher не прив'язаний до батька) і решта власних дітей — не лишати сиріт при штатній зупинці
  await pool.end().catch(() => undefined);
  watch.stop();
  rmSync(pidFile, { force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
