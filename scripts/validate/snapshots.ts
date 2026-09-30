/**
 * Браузерні аудити для `pnpm validate`: shop (127.0.0.1:4210), shop-clean на нейтральному хості site-a.test:4213 і
 * деградована копія на site-b.test:4214 (сліпий прогін E3c, DEV-74). Запуск лише від `sitelens`
 * (`bash scripts/run-as-sitelens.sh pnpm validate`, Chromium-пісочниця не стартує під root, DEV-13/25).
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { auditFixture, launchForFixtures } from "../fixture-harness.js";

export const NEUTRAL_HOSTS = [
  { host: "site-a.test", port: 4213 },
  { host: "site-b.test", port: 4214 },
] as const;
export const SHOP_PORT = 4210;

export interface SnapshotDirs { shop: string; clean: string; degraded: string }

/** shots=true (S7 session): пишуться viewport.png першого вікна — вони йдуть у запити сесійної моделі як зображення (без них тайл — заглушка без байтів) */
export async function auditSnapshots(baseDir: string, shots = false): Promise<SnapshotDirs> {
  const dirs: SnapshotDirs = { shop: path.join(baseDir, "shop"), clean: path.join(baseDir, "site-a"), degraded: path.join(baseDir, "site-b") };
  for (const d of Object.values(dirs)) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
  const sb = await launchForFixtures([SHOP_PORT], NEUTRAL_HOSTS);
  try {
    await auditFixture({ sb, site: "shop", port: SHOP_PORT, runDir: dirs.shop, shots });
    await auditFixture({ sb, site: "clean", port: NEUTRAL_HOSTS[0].port, host: NEUTRAL_HOSTS[0].host, runDir: dirs.clean, shots });
    await auditFixture({ sb, site: "degraded", port: NEUTRAL_HOSTS[1].port, host: NEUTRAL_HOSTS[1].host, runDir: dirs.degraded, shots });
  } finally {
    await sb.close();
  }
  return dirs;
}
