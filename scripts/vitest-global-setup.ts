/**
 * Одноразовий тестовий кластер PostgreSQL (embedded-postgres) на запуск `pnpm test`: порожня БД → міграції 001…N застосовуються КОЖНОГО прогону
 * (вимога «міграції тестуються на порожній БД»). Порт вільний (listen 0), каталог — os.tmpdir()/sitelens-vitest-pg, PID-файл там само;
 * залишки попереднього аварійного прогону прибираються ЛИШЕ за цим PID-файлом. Від root Postgres не стартує → dbUrl=null (тест-охоронець впаде гучно).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { DbDaemon, migrate, defaultConnectionString } from "../packages/db/src/index.js";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string | null;
    dbError: string | null;
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = path.join(os.tmpdir(), "sitelens-vitest-pg");
  const mk = (port: number) => new DbDaemon({ dataDir: path.join(root, "pg"), port, pidFile: path.join(root, "pids", "postgres.json"), logFile: path.join(root, "postgres.log"), sockDir: path.join(root, "run") });
  // прибрати кластер аварійно перерваного попереднього прогону — за його ж PID-файлом
  if (existsSync(path.join(root, "pg", "postmaster.pid"))) {
    try {
      await mk(0).stop();
    } catch {
      /* не наш/не запущений */
    }
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let daemon: DbDaemon | null = null;
  try {
    const port = await freePort();
    daemon = mk(port);
    await daemon.start();
    const url = defaultConnectionString(port);
    const res = await migrate(url);
    project.provide("dbUrl", url);
    project.provide("dbError", null);
    process.env["SITELENS_TEST_MIGRATIONS"] = res.applied.join(",");
  } catch (e) {
    project.provide("dbUrl", null);
    project.provide("dbError", (e as Error).message);
  }
  return async () => {
    await daemon?.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };
}
