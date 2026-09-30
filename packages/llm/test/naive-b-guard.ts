/**
 * «Наївний» guard: ТІ САМІ правила й маски, що в report-rules.ts, але з ASCII-межею слова замість Unicode-меж (G0-26).
 * Це тестовий еталон-порушник (лінт забороняє таку межу лише в каталозі guard-ів; тут файл тестовий).
 * Доводить, що корпус «uk_boundary» уміє впасти: ці речення такий guard пропускає, а наш — ловить.
 */
import { __rulesForTests, normalizeText, splitSentences } from "../src/guards/report-rules.js";

const ASCII_B = String.raw`\b`;
const swap = (re: RegExp): RegExp =>
  new RegExp(re.source.replaceAll(String.raw`(?<![\p{L}\p{N}])`, ASCII_B).replaceAll(String.raw`(?![\p{L}\p{N}])`, ASCII_B), re.flags);

const MASKS = __rulesForTests.MASKS.map(swap);
const RULES = __rulesForTests.RULES.map((r) => ({ ...r, re: swap(r.re) }));
const PERCENT = new RegExp(String.raw`\b\d+(?:[.,]\d+)?\s?%\b`, "u");

/** true → «наївний» guard відхилив би текст */
export function naiveBoundaryGuardRejects(raw: string): boolean {
  const t = normalizeText(raw);
  if (PERCENT.test(t)) return true;
  let masked = t;
  for (const re of MASKS) masked = masked.replace(re, " ⟂ ");
  for (const s of splitSentences(masked)) for (const r of RULES) if (r.re.test(s) && (!r.needs || r.needs(s))) return true;
  return false;
}
