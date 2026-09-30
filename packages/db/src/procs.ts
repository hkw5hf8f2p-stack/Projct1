/**
 * Учет власних процесів (G0-28): PID-файл із `starttime` (захист від повторного використання PID),
 * обхід нащадків через /proc, вбивство ЛИШЕ записаних процесів. Ніколи pkill -f / killall.
 * Linux (/proc). На macOS `readStart` повертає null — тоді збіг перевіряється лише за PID + іменем (`ps`), див. README Known limitations.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TrackedProc {
  pid: number;
  /** поле 22 /proc/<pid>/stat (тіки від старту системи); null, якщо недоступно */
  start: string | null;
  comm: string;
  role: string;
  cmd?: string;
}
export interface PidFile {
  owner: string;
  pid: number;
  start: string | null;
  written_at: string;
  children: TrackedProc[];
}

export function readStat(pid: number): { comm: string; ppid: number; start: string } | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rp = s.lastIndexOf(")");
    const comm = s.slice(s.indexOf("(") + 1, rp);
    const f = s.slice(rp + 2).split(" ");
    return { comm, ppid: Number(f[1]), start: f[19] ?? "" };
  } catch {
    return null;
  }
}

export function procStart(pid: number): string | null {
  const s = readStat(pid);
  if (s) return s.start;
  if (process.platform === "linux") return null;
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Процес жив і це той самий процес (PID+start збігаються). Без start — лише PID. */
export function isSameProc(t: { pid: number; start: string | null }): boolean {
  try {
    process.kill(t.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const cur = procStart(t.pid);
  if (t.start === null || cur === null) return true;
  return cur === t.start;
}

export function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

/** Усі нащадки pid (діти, онуки…) за PPid. */
export function descendantsOf(root: number, procRoot = "/proc"): number[] {
  if (process.platform !== "linux") return [];
  let names: string[] = [];
  try {
    names = readdirSync(procRoot);
  } catch {
    return [];
  }
  const kids = new Map<number, number[]>();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const st = readStat(Number(n));
    if (!st) continue;
    (kids.get(st.ppid) ?? kids.set(st.ppid, []).get(st.ppid)!).push(Number(n));
  }
  const out: number[] = [];
  const q = [root];
  while (q.length) {
    for (const c of kids.get(q.shift()!) ?? []) {
      out.push(c);
      q.push(c);
    }
  }
  return out;
}

export function readPidFile(file: string): PidFile | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PidFile;
  } catch {
    return null;
  }
}

export function writePidFile(file: string, data: PidFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

export function newPidFile(owner: string, pid: number, children: TrackedProc[] = []): PidFile {
  return { owner, pid, start: procStart(pid), written_at: new Date().toISOString(), children };
}

export interface CleanupReport {
  file: string;
  owner_pid: number | null;
  owner_was_alive: boolean;
  killed: Array<{ pid: number; comm: string; role: string }>;
  already_gone: number[];
  skipped_reused_pid: number[];
}

/**
 * Прибирання за PID-файлом: якщо ВЛАСНИК мертвий — SIGKILL кожного записаного нащадка, що ще живий і той самий
 * (PID+start+comm). Якщо власник живий — нічого не чіпаємо. Чужі процеси (не з файлу) не зачіпаються ніколи.
 */
export function cleanupOrphansFromFile(file: string): CleanupReport {
  const pf = readPidFile(file);
  const rep: CleanupReport = { file, owner_pid: pf?.pid ?? null, owner_was_alive: false, killed: [], already_gone: [], skipped_reused_pid: [] };
  if (!pf) return rep;
  rep.owner_was_alive = isSameProc(pf);
  if (rep.owner_was_alive) return rep;
  for (const c of pf.children) {
    if (!isSameProc(c)) {
      const st = readStat(c.pid);
      if (st) rep.skipped_reused_pid.push(c.pid);
      else rep.already_gone.push(c.pid);
      continue;
    }
    const st = readStat(c.pid);
    if (st && c.comm && st.comm !== c.comm) {
      rep.skipped_reused_pid.push(c.pid);
      continue;
    }
    try {
      process.kill(c.pid, "SIGKILL");
      rep.killed.push({ pid: c.pid, comm: c.comm, role: c.role });
    } catch {
      rep.already_gone.push(c.pid);
    }
  }
  return rep;
}

/** Записані діти, що ще живі (для перевірки «0 сиріт»). */
export function survivors(file: string): TrackedProc[] {
  const pf = readPidFile(file);
  if (!pf) return [];
  return pf.children.filter((c) => isSameProc(c) && (readStat(c.pid)?.comm ?? c.comm) === c.comm);
}

export const fileExists = existsSync;
