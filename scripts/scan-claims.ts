/**
 * S8, G0-17: заборонені формулювання про «пройдено DoD / MVP готовий» без переліку ⏭️.
 * Дозволено лише «DoD §72: N ✅ / M ⏭️ — перелік ⏭️ і дія власника». Файли: planning/conclusions/*.md, planning/STATE.md,
 * planning/qa/dod-72.md, README.md (відсутні пропускаються). Виняток: рядок, що САМ містить ⏭️ (перелік поруч), або цитує заборону
 * (слова «заборон», «forbidden», «G0-17»). Патерни складено так, щоб цей файл не був у власному переліку (сканер його не читає).
 * Запуск: pnpm scan:claims (код 1 при знахідках).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./artifact-dir.js";

const DOD = String.raw`DoD(?:\s*§\s*72)?`;
export const FORBIDDEN: Array<[string, RegExp]> = [
  ["uk: DoD пройдено/виконано/закрито", new RegExp(`${DOD}\\s+(?:повністю\\s+)?(?:пройден\\p{L}*|виконан\\p{L}*|закрит\\p{L}*|досягнут\\p{L}*|склад\\p{L}*)`, "iu")],
  ["uk: DoD ✅ (без формули N ✅ / M ⏭️)", new RegExp(`${DOD}\\s*[:—–-]?\\s*(?:✅|✔|зелен\\p{L}*)`, "iu")],
  ["uk: MVP готовий/завершений", /MVP\s+(?:вже\s+)?(?:готов\p{L}*|завершен\p{L}*|закінчен\p{L}*|виконан\p{L}*|зданий|здано)/iu],
  ["uk: усі рядки/пункти ✅", new RegExp(`(?:усі|всі)\\s+(?:\\d+\\s+)?(?:рядки|рядків|пункти|пунктів|критерії|критеріїв)\\s+(?:${DOD}\\s+)?(?:пройден\\p{L}*|✅)`, "iu")],
  ["en: DoD passed/complete/met", new RegExp(`${DOD}\\s+(?:is\\s+|was\\s+|has\\s+been\\s+|fully\\s+)*(?:passed|complete[d]?|met|done|achieved|satisfied|green)`, "i")],
  ["en: DoD ✅", new RegExp(`${DOD}\\s*[:—–-]?\\s*(?:✅|✔|all\\s+green)`, "i")],
  ["en: MVP ready/complete/done", /MVP\s+(?:is\s+|now\s+)*(?:ready|complete[d]?|done|finished|shipped)/i],
  ["en: all DoD rows/items pass", new RegExp(`all\\s+(?:\\d+\\s+)?(?:${DOD}\\s+)?(?:rows|items|criteria|lines)\\s+(?:are\\s+)?(?:pass(?:ed|ing)?|✅|green)`, "i")],
];
/** Рядок, що цитує заборону, не є твердженням. */
const QUOTING = /заборон|forbidden|G0-17|scan-claims/i;
const HAS_DEFERRED = /⏭/;

export interface Hit { file: string; line: number; rule: string; text: string }
export function scanClaims(files: Array<{ path: string; text: string }>): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((text, i) => {
      if (QUOTING.test(text) || HAS_DEFERRED.test(text)) return;
      for (const [rule, re] of FORBIDDEN) if (re.test(text)) { hits.push({ file: f.path, line: i + 1, rule, text: text.trim().slice(0, 160) }); break; }
    });
  }
  return hits;
}

export function targetFiles(root = REPO_ROOT): Array<{ path: string; text: string }> {
  const rels: string[] = [];
  const dir = path.join(root, "planning/conclusions");
  if (existsSync(dir)) for (const n of readdirSync(dir).sort()) if (n.endsWith(".md")) rels.push(`planning/conclusions/${n}`);
  rels.push("planning/STATE.md", "planning/qa/dod-72.md", "README.md");
  return rels.filter((r) => existsSync(path.join(root, r))).map((r) => ({ path: r, text: readFileSync(path.join(root, r), "utf8") }));
}

function main() {
  const files = targetFiles();
  const hits = scanClaims(files);
  for (const h of hits) console.error(`${h.file}:${h.line}: [${h.rule}] ${h.text}`);
  console.log(JSON.stringify({ scanned_files: files.map((f) => f.path), unexplained: hits.length, pass: hits.length === 0 }));
  process.exit(hits.length === 0 ? 0 : 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
