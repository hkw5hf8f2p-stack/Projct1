/**
 * Хелпери БД для тестів. Кожен тестовий ФАЙЛ, якому потрібна БД, піднімає ВЛАСНИЙ одноразовий кластер embedded-postgres у унікальному каталозі
 * (`os.tmpdir()/sitelens-vitest-pg-<pid>-<rand>`) і зупиняє його в afterAll. Глобального setup немає й не може бути: спільна машина, паралельні
 * запуски vitest інших агентів не повинні ні зупиняти наш кластер, ні платити за нього. Залишки аварійно перерваного файлу прибираються наступним
 * запуском ЛИШЕ якщо власник (pid vitest-процесу з owner.json) мертвий; чужі живі кластери не чіпаємо ніколи.
 * Від root Postgres не стартує (DbDaemon кидає виняток) — тест падає гучно, а не пропускається.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { DbDaemon, defaultConnectionString, isSameProc, migrate, procStart } from "../packages/db/src/index.js";

const PREFIX = "sitelens-vitest-pg-";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const daemonFor = (root: string, port: number) =>
  new DbDaemon({ dataDir: path.join(root, "pg"), port, pidFile: path.join(root, "pids", "postgres.json"), logFile: path.join(root, "postgres.log"), sockDir: path.join(root, "run") });

/** Прибирає кластери файлів, чий власник мертвий (аварія/kill -9). Живих і чужих не чіпає. */
async function reapDead(): Promise<string[]> {
  const reaped: string[] = [];
  for (const d of readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX))) {
    const root = path.join(os.tmpdir(), d);
    try {
      const owner = JSON.parse(readFileSync(path.join(root, "owner.json"), "utf8")) as { pid: number; start: string | null };
      if (isSameProc(owner)) continue; // власник живий → чужий прогін
    } catch {
      continue; // без owner.json — не наш каталог або ще створюється
    }
    try {
      await daemonFor(root, 0).stop();
    } catch {
      /* кластер уже мертвий */
    }
    rmSync(root, { recursive: true, force: true });
    reaped.push(d);
  }
  return reaped;
}

export interface TestCluster { url: string; applied: string[]; stop(): Promise<void> }

export async function startTestCluster(): Promise<TestCluster> {
  await reapDead();
  const root = mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${process.pid}-`));
  writeFileSync(path.join(root, "owner.json"), JSON.stringify({ pid: process.pid, start: procStart(process.pid) }));
  mkdirSync(path.join(root, "pids"), { recursive: true });
  const port = await freePort();
  const daemon = daemonFor(root, port);
  try {
    await daemon.start();
    const url = defaultConnectionString(port);
    const res = await migrate(url); // порожня БД → міграції кожного прогону
    return {
      url, applied: res.applied,
      async stop() {
        await daemon.stop().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await daemon.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

export interface FreshDb { url: string; name: string; pool: pg.Pool; drop(): Promise<void> }

export async function freshDatabase(baseUrl: string, opts: { migrate?: boolean } = {}): Promise<FreshDb> {
  const name = "t_" + randomBytes(5).toString("hex");
  const admin = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]+$/, "/postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = baseUrl.replace(/\/[^/]+$/, `/${name}`);
  if (opts.migrate !== false) await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  pool.on("error", () => undefined); // DROP DATABASE … FORCE обриває простійні з'єднання пулу — це очікувано
  return {
    url, name, pool,
    async drop() {
      await pool.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]+$/, "/postgres") });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await a.end();
    },
  };
}
