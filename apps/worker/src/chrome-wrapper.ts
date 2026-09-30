/**
 * Обгортка для Chrome Lighthouse (chrome-launcher НЕ прив'язує Chrome до батька: після kill -9 worker він живе далі).
 * Скрипт записує власний PID і starttime в журнал спавнів ДО `exec` Chrome (PID лишається тим самим) — облік без вікна гонки між запуском і
 * знімком нащадків (procwatch). Наступний старт worker вбиває записані живі процеси (cleanupSpawnLog), лише з тим самим starttime.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

export function ensureChromeWrapper(pidDir: string): { script: string; spawnLog: string } {
  mkdirSync(pidDir, { recursive: true });
  const script = path.join(pidDir, "chrome-lh-wrapper.sh");
  const spawnLog = path.join(pidDir, "worker-spawns.log");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    script,
    `#!/bin/sh\n# SiteLens: облік PID Chrome Lighthouse до exec (див. apps/worker/src/chrome-wrapper.ts)\nst=$(cut -d' ' -f22 /proc/$$/stat 2>/dev/null)\necho "$$ $st" >> ${q(spawnLog)}\nexec ${q(chromium.executablePath())} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);
  return { script, spawnLog };
}
