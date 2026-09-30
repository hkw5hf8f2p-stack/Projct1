/**
 * pnpm validate — E1 (детерміновані x/7 і LLM-лише y/3 + абляція), E2 (3 прогони замороженого знімка, cache_mode=bypass),
 * E3a (чисті сторінки), E3c (база vs деградована копія на нейтральних хостах), E4 (MAX_AUDIT_TOKENS) за ОДИН запуск.
 * Запуск: bash scripts/run-as-sitelens.sh pnpm validate   (браузерні аудити; під root Chromium не стартує)
 * Провайдер: fake (scripted evaluator, НЕ модель). Живий LLM-провайдер — ⏭️ S7 (потрібен ключ, OQ-1).
 * S7 без API (DEV-82): `--provider session` (SessionProvider: export/import) і `--provider replay` (LLM_PROVIDER=replay REPLAY_AS=session:<SESSION_MODEL_NAME>: лише кеш сесії, промах = гучна помилка);
 * знімки — заморожені planning/qa/artifacts/s7-session/snapshots; результати — s7-session/results-{session,replay}/. Код виходу 10 = AWAITING (чекаємо відповідей).
 * Env: MAX_VALIDATE_TOKENS (жорсткий ліміт на весь запуск; за замовчуванням 2 000 000), MAX_AUDIT_TOKENS (на аудит),
 *      SL_WRITE_ARTIFACTS=1 → planning/qa/artifacts/sprint-4/validate/, інакше os.tmpdir().
 * Прапорці: --strict-live (сума E1 ≥ 8 і LLM-виміри E3c стають гейтом), --checks E1,E2,…, --snapshots shop=…,clean=…,degraded=…
 * Код виходу: 0 PASS, 1 FAIL/INVALID, 2 зупинено MAX_VALIDATE_TOKENS, 3 провайдер не підтримано.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { artifactDir } from "./artifact-dir.js";
import { DEFAULT_MAX_AUDIT_TOKENS, DEFAULT_MAX_VALIDATE_TOKENS, formatResult, runValidation, type CheckId } from "./validate/core.js";
import { auditSnapshots, type SnapshotDirs } from "./validate/snapshots.js";
import { S7_ROOT, s7SnapshotDirs, sessionBackend, writeValidateArtifacts } from "./validate/s7.js";

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
/** S7 без API (DEV-82): `--provider replay` із LLM_PROVIDER=replay + REPLAY_AS=session:<модель> → лише кеш сесії (промах = гучна помилка); `--provider session` → SessionProvider */
const sessionPhase = provider === "session" ? "session" : provider === "replay" ? "replay" : null;
if (provider === "replay" && !(process.env["REPLAY_AS"] ?? "").startsWith("session:")) {
  console.error("⏭️ --provider replay: потрібен REPLAY_AS=session:<SESSION_MODEL_NAME> (replay-кеш транспорту session; фікстури fake-оцінювача цим не читаються)");
  process.exit(3);
}
if (provider !== "fake" && !sessionPhase) {
  console.error(`⏭️ провайдер «${provider}» не підтримано в dev-проході: живий запуск потребує ключа (OQ-1) і S7; replay не годиться для E2 (cache_mode=bypass несумісний із replay). Використай --provider fake.`);
  process.exit(3);
}

const base = sessionPhase ? path.join(S7_ROOT, `results-${sessionPhase === "replay" ? "replay" : "session"}`) : artifactDir("sprint-4/validate");
mkdirSync(base, { recursive: true });
let dirs: SnapshotDirs & { injection?: string };
const given = arg("--snapshots");
if (sessionPhase) {
  dirs = s7SnapshotDirs(S7_ROOT); // заморожені знімки s7-session (з них порахований ключ E5); браузер не потрібен
} else if (given) {
  const m = Object.fromEntries(given.split(",").map((kv) => kv.split("=") as [string, string]));
  if (!m["shop"] || !m["clean"]) throw new Error("--snapshots: потрібні shop=…,clean=… (degraded=… для E3c)");
  dirs = { shop: path.resolve(m["shop"]), clean: path.resolve(m["clean"]), degraded: m["degraded"] ? path.resolve(m["degraded"]) : "" };
} else {
  dirs = await auditSnapshots(path.join(base, "snapshots"));
}

const checks = arg("--checks")?.split(",") as CheckId[] | undefined;
const result = await runValidation({
  snapshots: { shop: dirs.shop, clean: dirs.clean, ...(dirs.degraded ? { degraded: dirs.degraded } : {}), ...(dirs.injection ? { injection: dirs.injection } : {}) },
  checks, ...(sessionPhase ? { session: sessionBackend(sessionPhase) } : {}),
  strict_live: process.argv.includes("--strict-live"),
  max_validate_tokens: num(process.env["MAX_VALIDATE_TOKENS"], DEFAULT_MAX_VALIDATE_TOKENS),
  max_audit_tokens: num(process.env["MAX_AUDIT_TOKENS"], DEFAULT_MAX_AUDIT_TOKENS),
});
const text = formatResult(result);
console.log(text);

writeValidateArtifacts(base, result, text);
console.log(`\nартефакти: ${base}${process.env["SL_WRITE_ARTIFACTS"] === "1" ? "" : " (тимчасові; SL_WRITE_ARTIFACTS=1 → planning/qa/artifacts/)"}`);
process.exitCode = result.verdict === "PASS" ? 0 : result.verdict === "STOPPED" ? 2 : result.verdict === "AWAITING" ? 10 : 1;
