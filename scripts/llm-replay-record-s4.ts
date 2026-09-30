/**
 * pnpm exec tsx scripts/llm-replay-record-s4.ts [--out <dir>] — SYNTHETIC записи для промптів S4 у fixtures/replay/s4-sim-synthetic-v1 (G0-16 б).
 * НЕ живий запис (R-2): відповіді пише packages/llm/src/testing/synthetic-s4.ts. Живий запис — S7 (потрібен ключ, OQ-1).
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirStore, LlmClient, ReplayCache, TokenBudget, loadPagesFromArtifacts } from "../packages/llm/src/index.js";
import { S4_IDENTITY, S4_NAMESPACE, runS4Sim, s4FakeProvider } from "../packages/llm/src/testing/synthetic-s4.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHOP_CLEAN_ARTIFACTS = path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix/shop-clean");

export async function recordS4(outRoot: string, artifacts = SHOP_CLEAN_ARTIFACTS): Promise<{ files: number; calls: number }> {
  const ns = path.join(outRoot, S4_NAMESPACE);
  rmSync(ns, { recursive: true, force: true });
  mkdirSync(ns, { recursive: true });
  const pages = loadPagesFromArtifacts(artifacts);
  const client = new LlmClient({
    mode: "live", provider: s4FakeProvider(pages), cache: new ReplayCache(new DirStore(outRoot), S4_NAMESPACE), cache_identity: S4_IDENTITY, budget: new TokenBudget(5_000_000),
    now: () => new Date("2026-09-30T00:00:00.000Z"),
  });
  const r = await runS4Sim({ audit_run_id: "run_s4_synthetic", client, language: "uk" }, pages);
  const bad = [...r.snapshots, ...r.agent, r.texts].filter((x) => x.status !== "done");
  if (bad.length) throw new Error(`запис: етапи не done: ${JSON.stringify(bad.map((b) => [b.stage, b.status, b.reason]))}`);
  return { files: readdirSync(ns).length, calls: client.records.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const oi = process.argv.indexOf("--out");
  const out = path.resolve(ROOT, oi >= 0 ? (process.argv[oi + 1] as string) : "fixtures/replay");
  recordS4(out).then((x) => console.log(`записано ${x.files} записів (SYNTHETIC) у ${out}/${S4_NAMESPACE}`), (e) => { console.error(e); process.exit(1); });
}
