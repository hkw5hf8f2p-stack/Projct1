/**
 * pnpm validate — E1 (детерміновані x/7 і LLM-лише y/3 + абляція), E2 (3 прогони замороженого знімка, cache_mode=bypass),
 * E3a (чисті сторінки), E3c (база vs деградована копія на нейтральних хостах), E4 (MAX_AUDIT_TOKENS) за ОДИН запуск.
 * Запуск: bash scripts/run-as-sitelens.sh pnpm validate   (браузерні аудити; під root Chromium не стартує)
 * Провайдер: fake (scripted evaluator, НЕ модель). Живий/replay LLM-провайдер — ⏭️ S7 (потрібен ключ, OQ-1).
 * Env: MAX_VALIDATE_TOKENS (жорсткий ліміт на весь запуск; за замовчуванням 2 000 000), MAX_AUDIT_TOKENS (на аудит),
 *      SL_WRITE_ARTIFACTS=1 → planning/qa/artifacts/sprint-4/validate/, інакше os.tmpdir().
 * Прапорці: --strict-live (сума E1 ≥ 8 і LLM-виміри E3c стають гейтом), --checks E1,E2,…, --snapshots shop=…,clean=…,degraded=…
 * Код виходу: 0 PASS, 1 FAIL/INVALID, 2 зупинено MAX_VALIDATE_TOKENS, 3 провайдер не підтримано.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { artifactDir } from "./artifact-dir.js";
import { DEFAULT_MAX_AUDIT_TOKENS, DEFAULT_MAX_VALIDATE_TOKENS, formatResult, runValidation, type CheckId } from "./validate/core.js";
import { auditSnapshots, type SnapshotDirs } from "./validate/snapshots.js";

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`очікується додатне число, отримано «${v}»`);
  return n;
};

const provider = arg("--provider") ?? process.env["VALIDATE_PROVIDER"] ?? "fake";
if (provider !== "fake") {
  console.error(`⏭️ провайдер «${provider}» не підтримано в dev-проході: живий запуск потребує ключа (OQ-1) і S7; replay не годиться для E2 (cache_mode=bypass несумісний із replay). Використай --provider fake.`);
  process.exit(3);
}

const base = artifactDir("sprint-4/validate");
mkdirSync(base, { recursive: true });
let dirs: SnapshotDirs;
const given = arg("--snapshots");
if (given) {
  const m = Object.fromEntries(given.split(",").map((kv) => kv.split("=") as [string, string]));
  if (!m["shop"] || !m["clean"]) throw new Error("--snapshots: потрібні shop=…,clean=… (degraded=… для E3c)");
  dirs = { shop: path.resolve(m["shop"]), clean: path.resolve(m["clean"]), degraded: m["degraded"] ? path.resolve(m["degraded"]) : "" };
} else {
  dirs = await auditSnapshots(path.join(base, "snapshots"));
}

const checks = arg("--checks")?.split(",") as CheckId[] | undefined;
const result = await runValidation({
  snapshots: { shop: dirs.shop, clean: dirs.clean, ...(dirs.degraded ? { degraded: dirs.degraded } : {}) },
  checks,
  strict_live: process.argv.includes("--strict-live"),
  max_validate_tokens: num(process.env["MAX_VALIDATE_TOKENS"], DEFAULT_MAX_VALIDATE_TOKENS),
  max_audit_tokens: num(process.env["MAX_AUDIT_TOKENS"], DEFAULT_MAX_AUDIT_TOKENS),
});
const text = formatResult(result);
console.log(text);

mkdirSync(path.join(base, "reports"), { recursive: true });
writeFileSync(path.join(base, "console.txt"), text + "\n");
const { reports, ...rest } = result;
writeFileSync(path.join(base, "results.json"), JSON.stringify({ schema: "sitelens-validate-result/v1", ...rest }, null, 2) + "\n");
for (const [label, rep] of Object.entries(reports)) writeFileSync(path.join(base, "reports", `${label}.json`), JSON.stringify(rep, null, 1) + "\n");
console.log(`\nартефакти: ${base}${process.env["SL_WRITE_ARTIFACTS"] === "1" ? "" : " (тимчасові; SL_WRITE_ARTIFACTS=1 → planning/qa/artifacts/)"}`);
process.exitCode = result.verdict === "PASS" ? 0 : result.verdict === "STOPPED" ? 2 : 1;
