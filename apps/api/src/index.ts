/** Точка входу API: pnpm api. G0-5: не-loopback лише з HOST і ACCESS_TOKEN. Не мігрує БД (pnpm db:migrate). */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadDotEnv, newPidFile, pg, writePidFile } from "@sitelens/db";
import { ListenRefused, createBoss, describeConfig, loadConfig, resolveListen, startBoss } from "@sitelens/pipeline";
import { buildServer } from "./server.js";

loadDotEnv();
const cfg = loadConfig();
let listen;
try {
  listen = resolveListen(cfg);
} catch (e) {
  if (e instanceof ListenRefused) {
    console.error(JSON.stringify({ level: "fatal", msg: e.message }));
    process.exit(3);
  }
  throw e;
}
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 6, application_name: "sitelens-api" });
pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "pg pool", err: e.message })));
try {
  await pool.query("SELECT 1");
} catch (e) {
  console.error(JSON.stringify({ level: "fatal", msg: `БД недоступна: ${(e as Error).message}. Запустіть pnpm db:start && pnpm db:migrate` }));
  process.exit(4);
}
const boss = createBoss(cfg.databaseUrl, { supervise: false, max: 3, application_name: "sitelens-api-boss" });
await startBoss(boss);
const app = await buildServer({ cfg, pool, boss });
await app.listen({ host: listen.host, port: listen.port });
mkdirSync(cfg.pidDir, { recursive: true });
writePidFile(path.join(cfg.pidDir, "api.json"), newPidFile("api", process.pid, []));
console.log(JSON.stringify({ level: "info", msg: "api started", pid: process.pid, listen, config: describeConfig(cfg) }));
const stop = async () => {
  await app.close().catch(() => undefined);
  await boss.stop({ graceful: false, close: true }).catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
