/**
 * Облік дочірніх процесів worker (G0-28): кожні `intervalMs` знімок нащадків (Chromium і його рендерери, Chrome Lighthouse) у PID-файл
 * (pid + starttime + comm). Якщо worker помре від `kill -9`, наступний старт вб'є ЛИШЕ записаних, що ще живі й ті самі (cleanupOrphansFromFile).
 * Вікно неточності: процес, що з'явився менш ніж `intervalMs` тому перед смертю worker, ще не записаний → лишається (задокументовано).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cmdlineOf, descendantsOf, isSameProc, newPidFile, readStat, writePidFile, type TrackedProc } from "./procs.js";

/** Розбір журналу спавнів: рядки `pid starttime` (пише обгортка ДО exec дочірнього процесу — без вікна гонки). */
export function parseSpawnLog(file: string): Array<{ pid: number; start: string | null }> {
  if (!existsSync(file)) return [];
  const out: Array<{ pid: number; start: string | null }> = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^(\d+)(?:\s+(\d+))?\s*$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), start: m[2] ?? null });
  }
  return out;
}

/** Прибирання за журналом спавнів мертвого власника: SIGKILL записаних процесів, що ще живі й ті самі (pid+starttime) і схожі на браузер. */
export function cleanupSpawnLog(file: string): Array<{ pid: number; comm: string }> {
  const killed: Array<{ pid: number; comm: string }> = [];
  for (const e of parseSpawnLog(file)) {
    if (e.start === null || !isSameProc(e)) continue; // без starttime — не ризикуємо (повторне використання PID)
    const st = readStat(e.pid);
    if (!st || !/chrom|headless/i.test(st.comm)) continue;
    try {
      process.kill(e.pid, "SIGKILL");
      killed.push({ pid: e.pid, comm: st.comm });
    } catch {
      /* уже вийшов */
    }
  }
  return killed;
}

export function startProcWatch(pidFile: string, intervalMs = 100, opts: { spawnLog?: string } = {}): { stop(): void; snapshot(): TrackedProc[] } {
  const known = new Map<number, TrackedProc>();
  if (opts.spawnLog) writeFileSync(opts.spawnLog, ""); // журнал попереднього власника уже оброблено при старті
  let lastKey = "";
  const tick = () => {
    if (opts.spawnLog) {
      for (const e of parseSpawnLog(opts.spawnLog)) {
        if (known.has(e.pid) || !isSameProc({ pid: e.pid, start: e.start })) continue;
        const st = readStat(e.pid);
        if (st) known.set(e.pid, { pid: e.pid, start: st.start, comm: st.comm, role: "browser", cmd: cmdlineOf(e.pid).slice(0, 160).replace(/--proxy-server=\S+/g, "--proxy-server=…") });
      }
    }
    for (const pid of descendantsOf(process.pid)) {
      if (known.has(pid)) continue;
      const st = readStat(pid);
      if (!st) continue;
      const role = /chrom|headless/i.test(st.comm) ? "browser" : "child";
      known.set(pid, { pid, start: st.start, comm: st.comm, role, cmd: cmdlineOf(pid).slice(0, 160).replace(/--proxy-server=\S+/g, "--proxy-server=…") });
    }
    for (const [pid, t] of known) if (!isSameProc(t)) known.delete(pid);
    const key = [...known.keys()].sort().join(",");
    if (key !== lastKey) {
      lastKey = key;
      writePidFile(pidFile, newPidFile("worker", process.pid, [...known.values()]));
    }
  };
  writePidFile(pidFile, newPidFile("worker", process.pid, []));
  const h = setInterval(tick, intervalMs);
  h.unref();
  return { stop: () => clearInterval(h), snapshot: () => [...known.values()] };
}

/** SIGKILL усіх нащадків ЦЬОГО процесу (лише власні діти: Chromium, Chrome Lighthouse). Для коректного завершення й хуків exit. */
export function killOwnDescendants(): number[] {
  const killed: number[] = [];
  for (const pid of descendantsOf(process.pid)) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      /* уже вийшов */
    }
  }
  return killed;
}
