/**
 * Облік дочірніх процесів worker (G0-28): кожні `intervalMs` знімок нащадків (Chromium і його рендерери, Chrome Lighthouse) у PID-файл
 * (pid + starttime + comm). Якщо worker помре від `kill -9`, наступний старт вб'є ЛИШЕ записаних, що ще живі й ті самі (cleanupOrphansFromFile).
 * Вікно неточності: процес, що з'явився менш ніж `intervalMs` тому перед смертю worker, ще не записаний → лишається (задокументовано).
 */
import { cmdlineOf, descendantsOf, isSameProc, newPidFile, readStat, writePidFile, type TrackedProc } from "@sitelens/db";

export function startProcWatch(pidFile: string, intervalMs = 100): { stop(): void; snapshot(): TrackedProc[] } {
  const known = new Map<number, TrackedProc>();
  let lastKey = "";
  const tick = () => {
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
