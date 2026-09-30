/** Мінімальний завантажувач .env (без залежностей): не перекриває змінні, уже задані в середовищі. Значення не логуються. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export function loadDotEnv(file = path.join(REPO_ROOT, ".env"), env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const set: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (env[m[1]!] === undefined && v !== "") {
      env[m[1]!] = v;
      set.push(m[1]!);
    }
  }
  return set;
}

export interface DbEnvConfig {
  port: number;
  dataDir: string;
  pidFile: string;
  logFile: string;
  databaseUrl: string;
}

const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbEnvConfig {
  const port = Number(env["EMBEDDED_PG_PORT"] ?? 54329);
  const dataDir = abs(env["PG_DATA_DIR"] ?? "data/pg");
  return {
    port,
    dataDir,
    pidFile: abs(env["PID_DIR"] ?? "data/pids") + "/postgres.json",
    logFile: abs(env["LOG_DIR"] ?? "data/logs") + "/postgres.log",
    databaseUrl: env["DATABASE_URL"] ?? `postgres://sitelens:sitelens@127.0.0.1:${port}/sitelens`,
  };
}
