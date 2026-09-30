/** Спільне для `pnpm s7:export|import` і `pnpm validate --provider session|replay` (S7 без API, DEV-82). */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../artifact-dir.js";
import { auditSnapshots } from "./snapshots.js";
import { captureInjection, injectionSnapshotReady } from "./injection.js";
import type { SessionBackend, ValidateResult, CheckId } from "./core.js";

export const S7_ROOT = process.env["S7_SESSION_DIR"] ? path.resolve(process.env["S7_SESSION_DIR"]) : path.join(REPO_ROOT, "planning/qa/artifacts/s7-session");

export interface S7Snapshots { shop: string; clean: string; degraded: string; injection: string }
export const s7SnapshotDirs = (root: string): S7Snapshots => ({
  shop: path.join(root, "snapshots/shop"), clean: path.join(root, "snapshots/site-a"), degraded: path.join(root, "snapshots/site-b"), injection: path.join(root, "snapshots/injection"),
});

/** Заморожені знімки: якщо їх немає — один браузерний аудит зі скриншотами (потрібен Chromium; від sitelens). Далі знімки НЕ перевизначаються (ключі E5 залежать від sha256 зображень). */
export async function ensureS7Snapshots(root: string, need: { sites: boolean; injection: boolean }): Promise<S7Snapshots> {
  const d = s7SnapshotDirs(root);
  if (need.sites && !["shop", "clean", "degraded"].every((k) => existsSync(path.join(d[k as "shop"], "pages.json")))) {
    await auditSnapshots(path.join(root, "snapshots"), true);
  }
  if (need.injection && !injectionSnapshotReady(d.injection)) await captureInjection(d.injection);
  return d;
}

/** сценарій → перевірки validate */
export const SCENARIOS = {
  "fixture-shop": { checks: ["E1", "E2"] as CheckId[], sites: true, injection: false },
  "shop-clean": { checks: ["E3a"] as CheckId[], sites: true, injection: false },
  "shop-clean-degraded": { checks: ["E3c"] as CheckId[], sites: true, injection: false },
  injection: { checks: ["INJ"] as CheckId[], sites: false, injection: true },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;
export const isScenario = (s: string): s is ScenarioName => s in SCENARIOS;

export function sessionBackend(phase: "session" | "replay", env: NodeJS.ProcessEnv = process.env): SessionBackend {
  const fromReplayAs = (env["REPLAY_AS"] ?? "").startsWith("session:") ? (env["REPLAY_AS"] as string).slice("session:".length) : "";
  const model = env["SESSION_MODEL_NAME"] || fromReplayAs;
  if (!model) throw new Error("SESSION_MODEL_NAME не задано (для replay — або REPLAY_AS=session:<ім'я>): ім'я моделі входить у ключ E5");
  return { root: S7_ROOT, model, phase };
}

export function writeValidateArtifacts(base: string, result: ValidateResult, text: string): void {
  mkdirSync(path.join(base, "reports"), { recursive: true });
  writeFileSync(path.join(base, "console.txt"), text + "\n");
  const { reports, ...rest } = result;
  writeFileSync(path.join(base, "results.json"), JSON.stringify({ schema: "sitelens-validate-result/v1", ...rest }, null, 2) + "\n");
  for (const [label, rep] of Object.entries(reports)) writeFileSync(path.join(base, "reports", `${label}.json`), JSON.stringify(rep, null, 1) + "\n");
}
