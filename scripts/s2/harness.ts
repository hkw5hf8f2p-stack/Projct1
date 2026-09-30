/**
 * Харнес сценаріїв S2: ізольований стек (власний Postgres на 54339, API :3101, worker, фікстури :4310+) у data/s2 — усе від `sitelens`
 * (bash scripts/run-as-sitelens.sh). Скрипт-оркестратор може бути root: він лише запускає, вбиває (kill -9) і дивиться в /proc та БД.
 * Прибирання — лише за PID-файлами й PID, отриманими від власних spawn (G0-28); pgrep -x, ніколи pkill -f/killall.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { artifactDir } from "../artifact-dir.js";
import { cmdlineOf, descendantsOf, isSameProc, procStart, readPidFile, readStat } from "../../packages/db/src/index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const S2 = path.join(ROOT, "data/s2");
/** SL_WRITE_ARTIFACTS=1 → planning/qa/artifacts/sprint-2 (свідоме оновлення доказів); інакше os.tmpdir()/… (scripts/artifact-dir.ts, X-1) */
export const ART = artifactDir("sprint-2");
export const PORTS = { pg: 54339, api: 3101, fx: 4310, canary: 4399, attacker: 4398 };
export const PG_URL = `postgres://sitelens:sitelens@127.0.0.1:${PORTS.pg}/sitelens`;
export const API = `http://127.0.0.1:${PORTS.api}`;
export const FX = { shop: `http://127.0.0.1:${PORTS.fx}`, clean: `http://127.0.0.1:${PORTS.fx + 1}`, bot: `http://127.0.0.1:${PORTS.fx + 2}`, errors: `http://127.0.0.1:${PORTS.fx + 3}`, errorsTls: `https://127.0.0.1:${PORTS.fx + 4}` };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sh = (cmd: string, args: string[]): string => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
export const save = (name: string, data: unknown) => { mkdirSync(ART, { recursive: true }); writeFileSync(path.join(ART, name), (typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\n"); };

export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PG_DATA_DIR: path.join(S2, "pg"), EMBEDDED_PG_PORT: String(PORTS.pg), DATABASE_URL: PG_URL, PID_DIR: path.join(S2, "pids"), LOG_DIR: path.join(S2, "logs"),
    ARTIFACT_DIR: path.join(S2, "artifacts"), PORT: String(PORTS.api), FIXTURE_BASE_PORT: String(PORTS.fx),
    SITELENS_FIXTURE_MODE: "1", SITELENS_FIXTURE_ORIGINS: [...Object.values(FX), `http://127.0.0.1:${PORTS.attacker}`].join(","), LIGHTHOUSE_MAX_PAGES: "1", TTL_SWEEP_INTERVAL_MS: "2000", ...extra,
  };
}
const asSitelens = (args: string[], env: Record<string, string>): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } => ({
  cmd: "bash", args: [path.join(ROOT, "scripts/run-as-sitelens.sh"), ...args],
  env: { ...process.env, ...env, SL_PASS_VARS: Object.keys(env).join(" ") },
});

export function ensureDirs(): void {
  mkdirSync(S2, { recursive: true });
  sh("chown", ["-R", "sitelens:sitelens", S2]);
}
export function runSync(args: string[], env: Record<string, string>): string {
  const c = asSitelens(args, env);
  return execFileSync(c.cmd, c.args, { env: c.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface Proc { name: string; child: ChildProcess; log: string; pidFile: string; pid(): number | null }
export function launch(name: string, args: string[], env: Record<string, string>, pidFileName: string): Proc {
  mkdirSync(path.join(S2, "logs"), { recursive: true });
  sh("chown", ["-R", "sitelens:sitelens", S2]);
  const log = path.join(S2, "logs", `${name}-${Date.now()}.out`);
  writeFileSync(log, "");
  chmodSync(log, 0o666);
  const c = asSitelens(args, env);
  const child = spawn(c.cmd, c.args, { env: c.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => appendFileSync(log, d));
  child.stderr?.on("data", (d) => appendFileSync(log, d));
  child.unref();
  const pidFile = path.join(S2, "pids", pidFileName);
  return { name, child, log, pidFile, pid: () => readPidFile(pidFile)?.pid ?? null };
}
export async function waitFor<T>(what: string, fn: () => Promise<T | null | false | undefined> | T | null | false | undefined, timeoutMs = 120_000, pollMs = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`таймаут очікування: ${what} (${timeoutMs} мс)`);
    await sleep(pollMs);
  }
}
export const logHas = (p: Proc, needle: string) => existsSync(p.log) && readFileSync(p.log, "utf8").includes(needle);
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function pool(): pg.Pool {
  const p = new pg.Pool({ connectionString: PG_URL, max: 4 });
  p.on("error", () => undefined);
  return p;
}
export async function q<T = Record<string, unknown>>(p: pg.Pool, sql: string, args: unknown[] = []): Promise<T[]> {
  return (await p.query(sql, args)).rows as T[];
}

export async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown; text: string; headers: Record<string, string> }> {
  const r = await fetch(url, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: r.status, json, text, headers: Object.fromEntries(Array.from(r.headers as unknown as Iterable<[string, string]>)) };
}

// ---------------------------------------------------------------- процеси
export interface ProcId { pid: number; start: string | null; comm: string }
export const idOf = (pid: number): ProcId => ({ pid, start: procStart(pid), comm: readStat(pid)?.comm ?? "" });
export const BROWSER_COMMS = ["headless_shell", "chrome", "chromium"];
export const browserPids = (): number[] => BROWSER_COMMS.flatMap((c) => sh("pgrep", ["-x", c]).split("\n").filter(Boolean).map(Number));
export const postgresPids = (): number[] => sh("pgrep", ["-x", "postgres"]).split("\n").filter(Boolean).map(Number);
const key = (p: ProcId) => `${p.pid}:${p.start}`;
export const snapshotForeign = (): { browsers: ProcId[]; postgres: ProcId[] } => ({ browsers: browserPids().map(idOf), postgres: postgresPids().map(idOf) });

/**
 * Сироти — НЕЗАЛЕЖНО від нашого PID-обліку. Браузер-сирота: живий процес браузера, чий батько НЕ браузер і це init (ppid == 1: власника-процес помер,
 * дерево переприв'язано), і його не було серед чужих ДО початку. Живий браузер чужого тесту (батько — його node) сиротою НЕ є (не наш і не покинутий).
 * Postgres-сирота: живий postgres з нашим каталогом даних (-D data/s2/pg), який не є нашим поточним postmaster (або його нащадком).
 */
export function orphanReport(foreignBefore: { browsers: ProcId[]; postgres: ProcId[] }, liveWorkerPids: number[], postmasterPid: number | null) {
  const okB = new Set(liveWorkerPids.flatMap((w) => descendantsOf(w)));
  const okP = new Set(postmasterPid ? [postmasterPid, ...descendantsOf(postmasterPid)] : []);
  const fb = new Set(foreignBefore.browsers.map(key));
  const isBrowser = (pid: number) => BROWSER_COMMS.includes(readStat(pid)?.comm ?? "");
  const b = browserPids().map(idOf).filter((p) => {
    if (okB.has(p.pid) || fb.has(key(p))) return false;
    const st = readStat(p.pid);
    if (!st || st.state === "Z" || isBrowser(st.ppid)) return false; // зомбі (уже вийшли, чекають прибирання init) і не-корені не рахуємо
    return st.ppid === 1;
  });
  const dataDir = path.join(S2, "pg");
  const p = postgresPids().map(idOf).filter((x) => !okP.has(x.pid) && cmdlineOf(x.pid).includes(dataDir));
  return { orphan_browsers: b.map((x) => ({ ...x, cmd: cmdlineOf(x.pid).slice(0, 120) })), orphan_postgres: p, foreign_browsers_untouched: foreignBefore.browsers.filter((f) => isSameProc(f)).map((f) => f.pid), foreign_browsers_before: foreignBefore.browsers.map((f) => f.pid), rule: "orphan browser = корінь дерева браузера з ppid==1, не з чужих до старту; orphan postgres = процес із нашим -D поза деревом поточного postmaster" };
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of existsSync(d) ? readdirSync(d) : []) { const p = path.join(d, n); if (isDir(p)) walk(p); else out.push(p); } };
  walk(dir);
  return out;
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
export { rmSync };
