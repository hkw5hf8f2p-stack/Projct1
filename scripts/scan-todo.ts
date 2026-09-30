/**
 * S8: маркери недоробок (чотири слова з WORDS нижче) у критичному шляху = 0. Критичний шлях: src пакетів і застосунків, scripts (без *.test.ts).
 * Виняток — лише запис у ALLOW із посиланням на DEV (файл + регекс рядка + причина). Порожній ALLOW — норма.
 * Слова складено з частин, щоб сам сканер не збігався зі своїм патерном. Запуск: pnpm scan:todo (код виходу 1 при знахідках).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./artifact-dir.js";

const WORDS = ["TO" + "DO", "FIX" + "ME", "X".repeat(3), "HA" + "CK"];
export const MARKER = new RegExp(`\\b(${WORDS.join("|")})\\b`);
export const CRITICAL = /^(packages\/[^/]+\/src|apps\/[^/]+\/src|scripts)\/.+\.(ts|tsx|js|mjs|cjs|sh)$/;
export const isCritical = (p: string): boolean => CRITICAL.test(p) && !/\.test\.(ts|tsx)$/.test(p);

/** Обґрунтовані винятки: { file, line, why: "… DEV-N" }. */
export const ALLOW: Array<{ file: RegExp; line: RegExp; why: string }> = [];

export interface Hit { file: string; line: number; text: string }
export function scanFiles(files: Array<{ path: string; text: string }>, allow = ALLOW): { hits: Hit[]; explained: Hit[] } {
  const hits: Hit[] = [], explained: Hit[] = [];
  for (const f of files) {
    if (!isCritical(f.path)) continue;
    f.text.split("\n").forEach((text, i) => {
      if (!MARKER.test(text)) return;
      const h = { file: f.path, line: i + 1, text: text.trim().slice(0, 160) };
      (allow.some((a) => a.file.test(f.path) && a.line.test(text)) ? explained : hits).push(h);
    });
  }
  return { hits, explained };
}

export function listTree(): Array<{ path: string; text: string }> {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter((p) => p && isCritical(p)).flatMap((p) => { try { return [{ path: p, text: readFileSync(path.join(REPO_ROOT, p), "utf8") }]; } catch { return []; } });
}

function main() {
  const files = listTree();
  const { hits, explained } = scanFiles(files);
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.text}`);
  console.log(JSON.stringify({ scanned_files: files.length, unexplained: hits.length, explained: explained.length, pass: hits.length === 0 }));
  process.exit(hits.length === 0 ? 0 : 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
