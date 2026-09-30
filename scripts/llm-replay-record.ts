/**
 * pnpm run llm:replay:record [-- --out <dir>] — записує SYNTHETIC відповіді для fixtures/shop у fixtures/replay/ (G0-16 б).
 * Це НЕ живий запис: відповіді пише packages/llm/src/testing/synthetic-shop.ts (R-2). Живий запис — S7 (потрібен ключ, OQ-1).
 * Кожен запис — повний ключ E5 (провайдер+модель+промпт+вміст+хеші зображень+семплінг); namespace shop-synthetic-v1.
 * Також пише fixtures/replay/hostile/cases.json — ворожий набір.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirStore, LlmClient, ReplayCache, TokenBudget, loadPagesFromArtifacts, runLlmStages } from "../packages/llm/src/index.js";
import { SHOP_NAMESPACE, SYNTHETIC_IDENTITY, shopFakeProvider } from "../packages/llm/src/testing/synthetic-shop.js";
import { hostileCases } from "../packages/llm/src/testing/hostile-cases.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHOP_ARTIFACTS = path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix/shop");

export async function recordShop(outRoot: string, artifacts = SHOP_ARTIFACTS): Promise<{ files: number; calls: number }> {
  const ns = path.join(outRoot, SHOP_NAMESPACE);
  rmSync(ns, { recursive: true, force: true });
  mkdirSync(ns, { recursive: true });
  const pages = loadPagesFromArtifacts(artifacts);
  const cache = new ReplayCache(new DirStore(outRoot), SHOP_NAMESPACE);
  const client = new LlmClient({
    mode: "live", provider: shopFakeProvider(pages), cache, cache_identity: SYNTHETIC_IDENTITY, budget: new TokenBudget(5_000_000),
    now: () => new Date("2026-09-30T00:00:00.000Z"),
  });
  const r = await runLlmStages({ audit_run_id: "run_shop_synthetic", client, pages, llm_mode: "replay" });
  const bad = Object.entries(r.stage_status).filter(([, v]) => v?.status !== "done");
  if (bad.length) throw new Error(`запис: етапи не done: ${JSON.stringify(bad)}`);
  mkdirSync(path.join(outRoot, "hostile"), { recursive: true });
  writeFileSync(path.join(outRoot, "hostile", "cases.json"), JSON.stringify(hostileCases(), null, 2) + "\n");
  return { files: readdirSync(ns).length, calls: client.records.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const oi = process.argv.indexOf("--out");
  const out = path.resolve(ROOT, oi >= 0 ? (process.argv[oi + 1] as string) : "fixtures/replay");
  recordShop(out).then((x) => console.log(`записано ${x.files} записів (SYNTHETIC) у ${out}/${SHOP_NAMESPACE}; ворожий набір: hostile/cases.json`), (e) => { console.error(e); process.exit(1); });
}
