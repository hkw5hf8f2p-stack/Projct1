/**
 * S7 без API-ключа (DEV-81): двофазний транспорт `session`.
 *   pnpm s7:export -- <fixture-shop|shop-clean|shop-clean-degraded|injection|all>   → requests/ (+ img/), статус awaiting_session_model
 *   pnpm s7:import                                                                  → responses/ → та сама обробка, що й відповідь API → кеш E5
 * Обидві команди — той самий прогін validate на транспорті session: що відповіді є — обробляється й пишеться в кеш, чого немає — експортується запитом.
 * Раундів може бути кілька: невалідна відповідь → запит attempt=2 (repair) у requests/. Env: SESSION_MODEL_NAME (обов'язково), S7_SESSION_DIR.
 * Знімки заморожуються при першому експорті (потрібен Chromium: bash scripts/run-as-sitelens.sh pnpm s7:export -- all).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DirStore, readIndex } from "../packages/llm/src/index.js";
import { formatResult, runValidation, type CheckId } from "./validate/core.js";
import { S7_ROOT, SCENARIOS, ensureS7Snapshots, isScenario, sessionBackend, writeValidateArtifacts, type ScenarioName } from "./validate/s7.js";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const cmd = argv[0];
if (cmd !== "export" && cmd !== "import") {
  console.error("використання: pnpm s7:export -- <fixture-shop|shop-clean|shop-clean-degraded|injection|all> · pnpm s7:import");
  process.exit(2);
}
const want = argv[1] ?? (cmd === "import" ? "all" : "");
if (want !== "all" && !isScenario(want)) {
  console.error(`невідомий сценарій «${want}»: fixture-shop | shop-clean | shop-clean-degraded | injection | all`);
  process.exit(2);
}
const names: ScenarioName[] = want === "all" ? (Object.keys(SCENARIOS) as ScenarioName[]) : [want as ScenarioName];
const backend = sessionBackend("session");
for (const d of ["requests", "responses", "cache"]) mkdirSync(path.join(S7_ROOT, d), { recursive: true });

const snaps = await ensureS7Snapshots(S7_ROOT, { sites: names.some((n) => SCENARIOS[n].sites), injection: names.includes("injection") });
const checks = [...new Set(names.flatMap((n) => SCENARIOS[n].checks))] as CheckId[];
const before = new Set(Object.keys(readIndex(S7_ROOT).requests));
const result = await runValidation({ snapshots: { shop: snaps.shop, clean: snaps.clean, degraded: snaps.degraded, injection: snaps.injection }, checks, session: backend });
const text = formatResult(result);
console.log(text);

// ---- зведення запитів за сценаріями (лише з index.json; requests/ сценаріїв не містять — сліпота E3c)
const idx = readIndex(S7_ROOT).requests;
const store = new DirStore(path.join(S7_ROOT, "cache"), true);
const answered = (e: { request_id: string; key: string; namespace: string }) => existsSync(path.join(S7_ROOT, "responses", `${e.request_id}.json`));
const inCache = (e: { key: string; namespace: string }) => store.get(e.namespace, e.key) !== undefined;
const perScenario: Record<string, { requests: number; images: number; new_this_run: number; answered: number; cached: number; attempt2: number; awaiting_answer: number }> = {};
for (const sc of Object.keys(SCENARIOS)) {
  const rows = Object.values(idx).filter((e) => e.scenarios.some((s) => s === sc || s.startsWith(`${sc}/`)));
  perScenario[sc] = {
    requests: rows.length, images: new Set(rows.flatMap((e) => e.images)).size, new_this_run: rows.filter((e) => !before.has(e.request_id)).length,
    answered: rows.filter(answered).length, cached: rows.filter(inCache).length, attempt2: rows.filter((e) => e.attempt === 2).length, awaiting_answer: rows.filter((e) => !answered(e)).length,
  };
}
const all = Object.values(idx);
const imagesDir = path.join(S7_ROOT, "requests/img");
const summary = {
  command: cmd, scenarios: names, verdict: result.verdict, model: backend.model, banner: result.banner,
  requests_total: all.length, images_total: existsSync(imagesDir) ? readdirSync(imagesDir).length : 0, awaiting_answer: all.filter((e) => !answered(e)).length, per_scenario: perScenario,
};
writeFileSync(path.join(S7_ROOT, `status-${cmd}.json`), JSON.stringify(summary, null, 2) + "\n");
console.log(`\nзапитів (унікальних, усі сценарії): ${summary.requests_total}, зображень: ${summary.images_total}, без відповіді: ${summary.awaiting_answer}`);
for (const [sc, v] of Object.entries(perScenario)) console.log(`  ${sc}: запитів ${v.requests} (нових ${v.new_this_run}, attempt=2: ${v.attempt2}), зображень ${v.images}, без відповіді ${v.awaiting_answer}`);
if (result.verdict !== "AWAITING") writeValidateArtifacts(path.join(S7_ROOT, "results"), result, text);
process.exitCode = result.verdict === "PASS" ? 0 : result.verdict === "AWAITING" ? 10 : 1;
