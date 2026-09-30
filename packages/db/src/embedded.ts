/**
 * Керування embedded-postgres як ДЕМОНОМ (DEV-2, DEV-10, G0-28): бінарники з npm-пакета `@embedded-postgres/<platform>`,
 * але процес Postgres відв'язаний від Node (pg_ctl start), тож `kill -9` API/worker його не зачіпає — саме це потрібно
 * для стійкості (§55.13). Клас `EmbeddedPostgres` із npm-пакета не використовується: він прив'язує Postgres до процесу-батька.
 * Дані, лог, сокет і PID-файл — у каталозі проєкту (data/, gitignored). Прибирання — лише за PID-файлом.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { isSameProc, newPidFile, procStart, readPidFile, readStat, writePidFile } from "./procs.js";

export interface DbDaemonOptions {
  dataDir: string;
  port: number;
  pidFile: string;
  logFile: string;
  user?: string;
  password?: string;
  database?: string;
  /** каталог unix-сокета (короткий шлях: ліміт 107 байт) */
  sockDir?: string;
}
export interface DbStatus {
  running: boolean;
  pid: number | null;
  port: number;
  stale_pid_file_removed: boolean;
}

interface Bins { initdb: string; pg_ctl: string; postgres: string }

export async function resolveBinaries(): Promise<Bins> {
  const key = `${process.platform}-${process.arch}`;
  const pkg = key === "linux-x64" ? "@embedded-postgres/linux-x64" : key === "darwin-arm64" ? "@embedded-postgres/darwin-arm64" : null;
  if (!pkg) throw new Error(`embedded-postgres: платформа ${key} не підтримана цим проєктом (linux-x64, darwin-arm64); скористайтесь infra/docker-compose.yml (UNVERIFIED) або власним PostgreSQL і DATABASE_URL`);
  try {
    return (await import(pkg)) as Bins;
  } catch (e) {
    throw new Error(`embedded-postgres: не вдалося завантажити ${pkg} (${(e as Error).message}). Виконайте pnpm install; pnpm 10/11 має дозволити postinstall у pnpm-workspace.yaml (onlyBuiltDependencies/allowBuilds)`);
  }
}

export const defaultConnectionString = (port: number, o: { user?: string; password?: string; database?: string } = {}): string =>
  `postgres://${o.user ?? "sitelens"}:${o.password ?? "sitelens"}@127.0.0.1:${port}/${o.database ?? "sitelens"}`;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export class DbDaemon {
  readonly opts: Required<DbDaemonOptions>;
  constructor(o: DbDaemonOptions) {
    this.opts = { user: "sitelens", password: "sitelens", database: "sitelens", sockDir: path.join(path.dirname(o.dataDir), "run"), ...o };
  }
  get connectionString(): string {
    return defaultConnectionString(this.opts.port, this.opts);
  }
  private get postmasterPidFile(): string {
    return path.join(this.opts.dataDir, "postmaster.pid");
  }

  /** stale postmaster.pid: файл є, а процесу з таким PID (postgres) немає → видаляємо (лише наш каталог даних). */
  status(): DbStatus {
    let pid: number | null = null;
    let removed = false;
    if (existsSync(this.postmasterPidFile)) {
      const first = Number(readFileSync(this.postmasterPidFile, "utf8").split("\n")[0]);
      const st = Number.isInteger(first) && first > 0 ? readStat(first) : null;
      if (st && st.comm === "postgres") pid = first;
      else {
        rmSync(this.postmasterPidFile, { force: true });
        removed = true;
      }
    }
    return { running: pid !== null, pid, port: this.opts.port, stale_pid_file_removed: removed };
  }

  async start(): Promise<DbStatus & { started: boolean; initialised: boolean }> {
    if (typeof process.getuid === "function" && process.getuid() === 0)
      throw new Error("PostgreSQL не запускається від root. Запустіть від звичайного користувача (у контейнері: bash scripts/run-as-sitelens.sh pnpm db:start)");
    const bins = await resolveBinaries();
    const st = this.status();
    if (st.running) {
      this.writePid(st.pid!);
      await this.ensureDatabase();
      return { ...st, started: false, initialised: false };
    }
    if (!(await portFree(this.opts.port)))
      throw new Error(`порт ${this.opts.port} зайнятий іншим процесом (не нашим Postgres). Задайте вільний EMBEDDED_PG_PORT у .env; чужий процес не зупиняємо`);
    mkdirSync(this.opts.sockDir, { recursive: true });
    mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
    let initialised = false;
    const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    if (!existsSync(path.join(this.opts.dataDir, "PG_VERSION"))) {
      mkdirSync(this.opts.dataDir, { recursive: true });
      const pw = path.join(path.dirname(this.opts.dataDir), `.pw-${process.pid}`);
      writeFileSync(pw, this.opts.password + "\n", { mode: 0o600 });
      try {
        const r = spawnSync(bins.initdb, ["-D", this.opts.dataDir, "-U", this.opts.user, `--pwfile=${pw}`, "--auth=scram-sha-256", "-E", "UTF8", "--locale=C"], { env, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`initdb: ${r.stderr || r.stdout}`);
      } finally {
        rmSync(pw, { force: true });
      }
      chmodSync(this.opts.dataDir, 0o700);
      initialised = true;
    }
    const opts = `-p ${this.opts.port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${this.opts.sockDir} -c max_connections=60`;
    const r = spawnSync(bins.pg_ctl, ["start", "-w", "-t", "60", "-D", this.opts.dataDir, "-l", this.opts.logFile, "-o", opts], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) throw new Error(`pg_ctl start: ${r.stderr || r.stdout}\n(лог: ${this.opts.logFile})`);
    const after = this.status();
    if (!after.running) throw new Error("pg_ctl start повернув 0, але postmaster.pid відсутній");
    this.writePid(after.pid!);
    await this.ensureDatabase();
    return { ...after, started: true, initialised };
  }

  private writePid(pid: number): void {
    writePidFile(this.opts.pidFile, newPidFile("postgres", pid, []));
  }

  async ensureDatabase(): Promise<void> {
    const c = new pg.Client({ host: "127.0.0.1", port: this.opts.port, user: this.opts.user, password: this.opts.password, database: "postgres" });
    await c.connect();
    try {
      const r = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [this.opts.database]);
      if (r.rowCount === 0) await c.query(`CREATE DATABASE ${JSON.stringify(this.opts.database)}`);
    } finally {
      await c.end();
    }
  }

  /** Зупиняє ЛИШЕ наш кластер (каталог даних із цих опцій). */
  async stop(): Promise<{ stopped: boolean }> {
    const st = this.status();
    if (!st.running) {
      rmSync(this.opts.pidFile, { force: true });
      return { stopped: false };
    }
    const bins = await resolveBinaries();
    const r = spawnSync(bins.pg_ctl, ["stop", "-m", "fast", "-w", "-t", "60", "-D", this.opts.dataDir], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    if (r.status !== 0) throw new Error(`pg_ctl stop: ${r.stderr || r.stdout}`);
    rmSync(this.opts.pidFile, { force: true });
    return { stopped: true };
  }

  /** Перевірка узгодженості PID-файлу з фактичним процесом (для звірки «0 сиріт»). */
  pidFileMatches(): boolean {
    const pf = readPidFile(this.opts.pidFile);
    const st = this.status();
    return !!pf && st.running && pf.pid === st.pid && isSameProc(pf) && pf.start === procStart(pf.pid);
  }
}

