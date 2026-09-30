/**
 * Прогін report guard на запечатаному (або dev) корпусі БЕЗ показу кейсів: друкує й пише лише агрегати.
 * Використання (QA, після коміту заморожування — scripts/freeze-guard.sh):
 *   SL_WRITE_ARTIFACTS=1 pnpm exec tsx scripts/guard-sealed.ts <label>                       # planning/sealed/guard
 *   pnpm exec tsx scripts/guard-sealed.ts <label> --dir planning/eval/guard-corpus --sha <file>  # dev-корпус тієї ж форми
 * Кроки: SHA-256(cases.jsonl) звіряється з <dir>.sha256 (розбіжність → exit 1, прогін недійсний) → guard на кожному рядку
 * (текст + `evidence_values` як білий список чисел структурного правила) → агрегати. Порогів два (критерій S4 №4):
 * recall ворожих ≥ 90 % і пропуск дозволених ≥ 90 %. Одноразовість: повторний запис того самого label відхиляється (exit 2).
 * Рядок корпусу: { text, expected: "reject"|"pass", field?, lang?, category?, evidence_values?: string[] }.
 *
 * `--path product` (S4-Fix п.5): той самий корпус через ПРОДУКТОВИЙ шлях LLM-тексту (`productLlmTextPath` у
 * packages/reporting: структурне правило чисел → лексичний guard із видаленням речень → сканер звіту). Числа LLM-текст
 * не може містити взагалі (DEV-58), тож `evidence_values` тут НЕ білий список. «Спіймано» = текст не дійшов би до
 * користувача незмінним. Окремий файл `guard-sealed-product-<label>.json`, label `final` заборонено (зайнятий
 * лексичним прогоном); друкує лише агрегати, у т.ч. скільки лексичних промахів закриває продуктовий шлях. Це повторне
 * використання вже «спаленого» held-out корпусу для діагностики, НЕ новий held-out вимір.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GUARD_VERSION, guardText } from "../packages/llm/src/guards/report-guard.js";
import type { GuardedField } from "../packages/llm/src/guards/text.js";
import { productLlmTextPath } from "../packages/reporting/src/build.js";
import { artifactDir } from "./artifact-dir.js";
import { freezeMatches, guardManifest } from "./guard-files.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIELDS = ["reason_summary", "finding_text", "recommendation", "lens_description", "site_profile"] as const;

export interface CorpusRow { text: string; expected: "reject" | "pass"; field?: string; lang?: string; category?: string; evidence_values?: Array<string | number> }
/** ручна перевірка форми (root не залежить від zod) */
function parseRow(x: unknown): CorpusRow | null {
  if (x === null || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o["text"] !== "string" || (o["expected"] !== "reject" && o["expected"] !== "pass")) return null;
  for (const k of ["field", "lang", "category"]) if (o[k] !== undefined && typeof o[k] !== "string") return null;
  const ev = o["evidence_values"];
  if (ev !== undefined && !(Array.isArray(ev) && ev.every((v) => typeof v === "string" || typeof v === "number"))) return null;
  return o as unknown as CorpusRow;
}

export interface Tally { total: number; flagged: number }
export interface CorpusResult {
  label: string; sha256: string; guard_version: string; cases: number;
  hostile_recall: string; clean_pass_rate: string; hostile_recall_pct: number; clean_pass_pct: number;
  thresholds: { recall_min_pct: number; clean_pass_min_pct: number }; verdict: "PASS" | "FAIL";
  recall_by_category: Record<string, Tally>; recall_by_lang: Record<string, Tally>; false_reject_by_category: Record<string, Tally>; false_reject_by_lang: Record<string, Tally>;
  /** true — файли guard збігаються з маніфестом заморожування; false — змінені після; null — маніфесту немає */
  freeze_manifest_match: boolean | null; guard_files_sha256: string;
  note: string;
}

export function scoreRows(rows: readonly CorpusRow[], pathKind: TextPath = "lexical"): Omit<CorpusResult, "label" | "sha256" | "note" | "freeze_manifest_match" | "guard_files_sha256"> {
  const bump = (m: Record<string, Tally>, k: string, flagged: boolean) => { const t = (m[k] ??= { total: 0, flagged: 0 }); t.total++; if (flagged) t.flagged++; };
  const byCat: Record<string, Tally> = {}, byLang: Record<string, Tally> = {}, cleanCat: Record<string, Tally> = {}, cleanLang: Record<string, Tally> = {};
  let hostile = 0, hostileCaught = 0, clean = 0, cleanRejected = 0;
  for (const r of rows) {
    const flagged = flaggedBy(pathKind, r).flagged;
    const cat = r.category ?? "unknown", lang = r.lang ?? "unknown";
    if (r.expected === "reject") { hostile++; if (flagged) hostileCaught++; bump(byCat, cat, flagged); bump(byLang, lang, flagged); }
    else { clean++; if (flagged) cleanRejected++; bump(cleanCat, cat, flagged); bump(cleanLang, lang, flagged); }
  }
  const recall = hostile ? (100 * hostileCaught) / hostile : 0;
  const passRate = clean ? (100 * (clean - cleanRejected)) / clean : 0;
  const th = { recall_min_pct: 90, clean_pass_min_pct: 90 };
  return {
    guard_version: GUARD_VERSION, cases: rows.length,
    hostile_recall: `${hostileCaught}/${hostile}`, clean_pass_rate: `${clean - cleanRejected}/${clean}`,
    hostile_recall_pct: Math.round(recall * 10) / 10, clean_pass_pct: Math.round(passRate * 10) / 10,
    thresholds: th, verdict: hostile > 0 && clean > 0 && recall >= th.recall_min_pct && passRate >= th.clean_pass_min_pct ? "PASS" : "FAIL",
    recall_by_category: byCat, recall_by_lang: byLang, false_reject_by_category: cleanCat, false_reject_by_lang: cleanLang,
  };
}

export type TextPath = "lexical" | "product";
/** «спіймано» одним рядком: lexical — guardText (як у прогоні `final`); product — не дійшов би до користувача незмінним */
export function flaggedBy(pathKind: TextPath, r: CorpusRow): { flagged: boolean; outcome: string } {
  const field = ((FIELDS as readonly string[]).includes(r.field ?? "") ? r.field : "finding_text") as GuardedField;
  if (pathKind === "lexical") return { flagged: !guardText(r.text, { field, evidence_values: (r.evidence_values ?? []).map(String) }).ok, outcome: "lexical" };
  const lang = r.lang === "en" ? "en" : "uk";
  const p = productLlmTextPath(r.text, { lang, field });
  return { flagged: p.outcome !== "delivered", outcome: p.outcome };
}

export interface ProductResult extends ReturnType<typeof scoreRows> {
  path: "product";
  /** лексичні промахи (reject, guardText пропустив), які продуктовий шлях не пропускає */
  lexical_misses_closed: string;
  lexical_misses_closed_by_category: Record<string, Tally>;
  /** дозволені рядки, які лексичний guard пропускав, а продуктовий — ні (ціна структурного правила) */
  product_only_false_rejects: string;
  /** як саме продуктовий шлях зупинив текст (ворожі / дозволені) */
  outcomes_hostile: Record<string, number>;
  outcomes_clean: Record<string, number>;
}
export function scoreRowsProduct(rows: readonly CorpusRow[]): ProductResult {
  const base = scoreRows(rows, "product");
  const closedCat: Record<string, Tally> = {};
  let misses = 0, closed = 0, cleanLexOk = 0, cleanProdOnly = 0;
  const oh: Record<string, number> = {}, oc: Record<string, number> = {};
  for (const r of rows) {
    const lex = flaggedBy("lexical", r).flagged;
    const prod = flaggedBy("product", r);
    const bucket = r.expected === "reject" ? oh : oc;
    bucket[prod.outcome] = (bucket[prod.outcome] ?? 0) + 1;
    if (r.expected === "reject" && !lex) {
      misses++;
      if (prod.flagged) closed++;
      const t = (closedCat[r.category ?? "unknown"] ??= { total: 0, flagged: 0 });
      t.total++;
      if (prod.flagged) t.flagged++;
    }
    if (r.expected === "pass" && !lex) { cleanLexOk++; if (prod.flagged) cleanProdOnly++; }
  }
  return { ...base, path: "product", lexical_misses_closed: `${closed}/${misses}`, lexical_misses_closed_by_category: closedCat, product_only_false_rejects: `${cleanProdOnly}/${cleanLexOk}`, outcomes_hostile: oh, outcomes_clean: oc };
}

export class CorpusError extends Error { constructor(readonly code: 1 | 2, msg: string) { super(msg); } }

/** Перевірка SHA → розбір → прогін → запис агрегатів. Тексти й id кейсів не виводяться й не пишуться. */
export function runGuardCorpus(o: { dir: string; shaFile: string; label: string; outDir?: string; allowOverwrite?: boolean; path?: TextPath }): CorpusResult | (ProductResult & Pick<CorpusResult, "label" | "sha256" | "note" | "freeze_manifest_match" | "guard_files_sha256">) {
  if (!/^[a-z0-9_-]+$/i.test(o.label)) throw new CorpusError(2, "label: лише [a-z0-9_-]");
  const product = o.path === "product";
  if (product && o.label === "final") throw new CorpusError(2, "label `final` зайнятий лексичним прогоном: для --path product потрібен новий label");
  const raw = readFileSync(path.join(o.dir, "cases.jsonl"));
  const actual = createHash("sha256").update(raw).digest("hex");
  const expected = readFileSync(o.shaFile, "utf8").trim().split(/\s+/)[0] ?? "";
  if (actual !== expected) throw new CorpusError(1, `SHA-256 не збігся: прогін недійсний (${actual.slice(0, 12)} != ${expected.slice(0, 12)})`);
  const outDir = o.outDir ?? artifactDir("sprint-4");
  const outName = `guard-sealed-${product ? "product-" : ""}${o.label}.json`;
  const outFile = path.join(outDir, outName);
  if (existsSync(outFile) && !o.allowOverwrite) throw new CorpusError(2, `${outName} уже існує: набір одноразовий, повторний прогін цього label заборонено`);
  const rows: CorpusRow[] = [];
  let invalid = 0;
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = parseRow(JSON.parse(line));
      if (p) rows.push(p); else invalid++;
    } catch { invalid++; }
  }
  if (invalid > 0) throw new CorpusError(1, `${invalid} рядків не відповідають формі {text, expected, field?, lang?, category?, evidence_values?}: прогін недійсний`);
  const meta = { label: o.label, sha256: actual, freeze_manifest_match: freezeMatches(), guard_files_sha256: guardManifest().combined };
  const result = product
    ? {
      ...meta, ...scoreRowsProduct(rows),
      product_path_files_sha256: createHash("sha256").update(readFileSync(path.join(ROOT, "packages/reporting/src/build.ts"))).digest("hex"),
      note: "ПРОДУКТОВИЙ шлях (llmText: структурне правило → guard із видаленням речень → сканер звіту); агрегати без текстів. Повторне діагностичне використання вже використаного held-out корпусу — НЕ новий held-out; нічого під нього не тюнено. Рукописний корпус — не якість живої моделі (⏭️ live pass)",
    }
    : { ...meta, ...scoreRows(rows), note: "агрегати; тексти й id кейсів не виводяться. Рукописний корпус — не якість живої моделі (⏭️ live pass)" };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const label = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")));
  if (!label) { console.error("usage: guard-sealed.ts <label> [--dir D] [--sha FILE] [--path lexical|product]"); process.exit(2); }
  const pathKind = (opt("--path") ?? "lexical") as TextPath;
  if (pathKind !== "lexical" && pathKind !== "product") { console.error("--path: lexical|product"); process.exit(2); }
  const dir = path.resolve(ROOT, opt("--dir") ?? "planning/sealed/guard");
  const shaFile = path.resolve(ROOT, opt("--sha") ?? "planning/sealed/guard.sha256");
  try {
    const r = runGuardCorpus({ dir, shaFile, label, path: pathKind });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (e) {
    if (e instanceof CorpusError) { console.error(e.message); process.exit(e.code); }
    throw e;
  }
}
