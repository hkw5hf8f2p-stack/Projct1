/**
 * Облік процесів, які тест запускає сам (Chromium, Chrome Lighthouse від chrome-launcher — він НЕ прив'язаний до батька і переживає його смерть).
 * Той самий механізм, що й у worker (G0-28): PID-файл нащадків з starttime; при аварії (kill -9 / падіння vitest) НАСТУПНИЙ запуск прибирає ЛИШЕ записаних
 * дітей мертвого власника; при штатному завершенні (afterAll / exit) — SIGKILL власних нащадків. Живих власників і чужі процеси не чіпаємо ніколи.
 */
import { readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupOrphansFromFile, killOwnDescendants, startProcWatch } from "../packages/db/src/index.js";

const PREFIX = "sitelens-test-procs-";

export function reapDeadTestProcs(): Array<{ file: string; killed: number[] }> {
  const out: Array<{ file: string; killed: number[] }> = [];
  for (const f of readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX) && n.endsWith(".json"))) {
    const file = path.join(os.tmpdir(), f);
    const rep = cleanupOrphansFromFile(file);
    if (rep.owner_pid !== null && !rep.owner_was_alive) {
      out.push({ file: f, killed: rep.killed.map((k) => k.pid) });
      rmSync(file, { force: true });
    }
  }
  return out;
}

export function guardTestProcesses(): { stop(): number[] } {
  reapDeadTestProcs();
  const file = path.join(os.tmpdir(), `${PREFIX}${process.pid}.json`);
  const watch = startProcWatch(file, 100);
  const onExit = () => {
    killOwnDescendants();
    rmSync(file, { force: true });
  };
  process.on("exit", onExit);
  return {
    stop() {
      watch.stop();
      const killed = killOwnDescendants();
      rmSync(file, { force: true });
      process.off("exit", onExit);
      return killed;
    },
  };
}
