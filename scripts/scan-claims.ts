/**
 * S8, G0-17 (S8-Fix, критик 30.09): заборонені формулювання про «пройдено DoD / MVP готовий». Дозволена лише формула
 * «DoD §72: N ✅ / M ⏭️ [/ K ❌] — перелік ⏭️ і дія власника» (N+M+K = 12). Файли: planning/conclusions/*.md, planning/STATE.md,
 * planning/qa/dod-72.md, README.md (відсутні пропускаються).
 * Рядок нормалізується (markdown-таблиці, тире, двокрапки, дужки, регістр, variation selectors → пробіли), тож `| DoD §72 | ✅ |`,
 * `DoD — passed`, `MVP: ready` = ті самі патерни. ⏭️ у рядку НІЧОГО не звільняє (раніше це вимикало сканер цілком).
 * Єдині винятки: (а) формула вище — вирізається з рядка перед скануванням; (б) фрагмент у лапках («…», "…", `…`) у рядку з маркером
 * цитування заборони (заборон*, forbidden, G0-17, scan-claims). Запуск: pnpm scan:claims (код 1 при знахідках).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./artifact-dir.js";

export const DOD_ROWS = 12;
const SUBJ = String.raw`(?:dod|definition of done)(?: 72)?`;
const MVP = String.raw`mvp`;
const COUNT = String.raw`(?:\d+ (?:рядк\p{L}*|пункт\p{L}*|критері\p{L}*|rows?|items?|criteria|lines?) )?`;
const FILL = String.raw`(?:(?:є|is|was|are|be|been|has|have|now|вже|fully|повністю|цілком|успішно|нарешті|загалом|усі|всі|all|the) )*`;
/** Позитивні предикати (uk/en, відмінки й роди). Негація («не», «not», «без») стоїть ПЕРЕД предикатом і не входить у FILL → не збігається. */
const POS = String.raw`(?:✅|✔|✓|☑|пройден\p{L}*|пройшл\p{L}*|пройшов\p{L}*|виконан\p{L}*|закрит\p{L}*|досягнут\p{L}*|складен\p{L}*|готов\p{L}*|завершен\p{L}*|закінчен\p{L}*|зелен\p{L}*|здан\p{L}*|здано|(?:ready|done|complete|completed|passed|pass|passes|met|achieved|satisfied|green|finished|shipped|closed|ok)(?![\p{L}\p{N}]))`;
const NOUNS = String.raw`(?:рядк\p{L}*|пункт\p{L}*|критері\p{L}*|rows|items|criteria|lines)`;
const rx = (src: string) => new RegExp(src, "iu");
export const FORBIDDEN: Array<[string, RegExp]> = [
  ["DoD + предикат пройдено/✅/passed/complete (uk/en)", rx(`(?:^| )${SUBJ} ${COUNT}${FILL}${POS}`)],
  ["MVP + предикат готовий/ready/done (uk/en)", rx(`(?:^| )${MVP} ${FILL}${POS}`)],
  ["предикат пройдено/passed перед DoD/MVP", rx(`(?:пройден\\p{L}*|passed|completed?) ${FILL}(?:${SUBJ}|${MVP})(?![\\p{L}\\p{N}])`)],
  ["усі/all N рядків [DoD] пройдено/✅/pass", rx(`(?:усі|всі|all) (?:\\d+ )?(?:${SUBJ} )?${NOUNS} (?:${SUBJ} )?${FILL}${POS}`)],
];
const RAW_ALL = /(?:^|[^\d])(\d+)\s*\/\s*\1\s*(?:✅|✔|✓|пройден|passed|pass\b|green)/iu; // «12/12 ✅» — лише в рядку з DoD/MVP
const SUBJ_ANY = /dod|definition of done|mvp/i;
/** Дозволена формула (у сирому рядку, до нормалізації). */
const FORMULA = /DoD(?:\s*§?\s*72)?\s*[:—–|-]?\s*(\d+)\s*✅\s*\/\s*(\d+)\s*⏭\uFE0F?(?:\s*\/\s*(\d+)\s*❌)?/giu;
const QUOTED = /«[^»]*»|"[^"]*"|“[^”]*”|`[^`]*`/g;
const MARKER = /заборон|forbidden|G0-17|scan-claims/i;

/** Нормалізація: без markdown/пунктуації/тире/двокрапок/variation selectors, lower-case, один пробіл; ✅✔✓☑⏭❌ лишаються символами. */
export function normalize(line: string): string {
  return line
    .replace(/[\uFE00-\uFE0F\u200B-\u200D]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}✅✔✓☑⏭❌]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export interface Hit { file: string; line: number; rule: string; text: string }
export function scanClaims(files: Array<{ path: string; text: string }>): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((raw, i) => {
      const add = (rule: string) => hits.push({ file: f.path, line: i + 1, rule, text: raw.trim().slice(0, 160) });
      let line = raw;
      if (MARKER.test(line)) line = line.replace(QUOTED, " ");
      for (const m of line.matchAll(FORMULA)) {
        const sum = Number(m[1]) + Number(m[2]) + Number(m[3] ?? 0);
        if (sum !== DOD_ROWS) add(`формула DoD: N+M+K=${sum}, очікується ${DOD_ROWS}`);
      }
      line = line.replace(FORMULA, " ");
      const n = ` ${normalize(line)}`.trimStart();
      if (!n) return;
      for (const [rule, re] of FORBIDDEN) if (re.test(n)) return void add(rule);
      if (SUBJ_ANY.test(line) && RAW_ALL.test(line)) add("N/N ✅ у рядку про DoD/MVP");
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
