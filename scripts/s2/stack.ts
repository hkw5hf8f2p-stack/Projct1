/** Керування ізольованим стеком S2 (Postgres, фікстури, API, worker) для сценаріїв. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { API, S2, PORTS, alive, baseEnv, ensureDirs, http, launch, logHas, runSync, sleep, waitFor, type Proc } from "./harness.js";
import { readPidFile } from "../../packages/db/src/index.js";

export const stack: { fixtures?: Proc; api?: Proc; worker?: Proc } = {};

export function dbUp(): { started: boolean } {
  ensureDirs();
  const env = baseEnv();
  const out = JSON.parse(runSync(["pnpm", "--silent", "db:start"], env).trim().split("\n").pop()!);
  runSync(["pnpm", "--silent", "db:migrate"], env);
  return { started: out.started };
}
export function dbDown(): void {
  try { runSync(["pnpm", "--silent", "db:stop"], baseEnv()); } catch { /* уже зупинено */ }
}
export const pidOf = (name: "api" | "worker" | "postgres" | "fixtures"): number | null => readPidFile(path.join(S2, "pids", `${name}.json`))?.pid ?? null;

async function waitNew(p: Proc, prev: number | null, name: string): Promise<number> {
  return waitFor(`${name}: новий pid`, () => { const x = p.pid(); return x !== null && x !== prev && alive(x) ? x : null; }, 90_000);
}
export async function fixturesUp(): Promise<void> {
  const prev = pidOf("fixtures");
  stack.fixtures = launch("fixtures", ["pnpm", "--silent", "fixtures"], baseEnv(), "fixtures.json");
  await waitNew(stack.fixtures, prev, "fixtures");
  await waitFor("фікстури слухають", () => logHas(stack.fixtures!, '"shop"'), 60_000);
}
export async function apiUp(extra: Record<string, string> = {}): Promise<number> {
  const prev = pidOf("api");
  stack.api = launch("api", ["pnpm", "--silent", "api"], baseEnv(extra), "api.json");
  const pid = await waitNew(stack.api, prev, "api");
  await waitFor("API health", async () => { try { return (await http("GET", `${API}/api/health`)).status === 200; } catch { return false; } }, 60_000);
  return pid;
}
export async function workerUp(extra: Record<string, string> = {}): Promise<number> {
  const prev = pidOf("worker");
  stack.worker = launch("worker", ["pnpm", "--silent", "worker"], baseEnv(extra), "worker.json");
  const pid = await waitNew(stack.worker, prev, "worker");
  await waitFor("worker started", () => logHas(stack.worker!, '"msg":"worker started"'), 90_000);
  return pid;
}
export async function stopGraceful(name: "api" | "worker" | "fixtures"): Promise<void> {
  const pid = pidOf(name);
  if (pid === null || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
  if (alive(pid)) process.kill(pid, "SIGKILL"); // лише НАШ записаний pid
}
export function newestRecovery(sinceMs: number): Record<string, unknown> | null {
  const dir = path.join(S2, "logs");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => n.startsWith("recovery-")).map((n) => ({ n, t: Number(n.slice(9, -5)) })).filter((x) => x.t >= sinceMs).sort((a, b) => b.t - a.t)[0];
  return f ? (JSON.parse(readFileSync(path.join(dir, f.n), "utf8")) as Record<string, unknown>) : null;
}
export { PORTS };
