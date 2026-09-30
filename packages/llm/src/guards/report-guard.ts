/**
 * Report guard D1 (SPEC §33, S4; G0-26): один вхід для ВСІХ текстів LLM, які бачить користувач, EN + UK.
 * Три лінії, від структурної до лексичної:
 *   1. СТРУКТУРА: у тексті дозволені лише числа/числівники з білого списку `evidence_values` (значення з доказів або
 *      скорингу, підставлені кодом) і форми, які рендерить код («N of M synthetic …», «Priority NN/100»). Решта — відхилення.
 *   2. ЛЕКСИКА: `report-rules.ts` (uplift, TAM, виручка, частки, кратність, вигадані бенчмарки, демографія в лінзах).
 *   3. ДРУГА ЛІНІЯ: загальне правило «відсоток/сума поруч із конверсією/продажами/виручкою/ринком/клієнтами»
 *      (НЕ послаблюється доказом: «12 %» на сайті не дозволяє «+12 % конверсії») і прогнози БЕЗ чисел.
 * Межі слів — лише `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`; ESLint-правило `no-restricted-syntax` забороняє ASCII-межу слова
 * у цьому каталозі (eslint.config.js, тест guard-lint).
 * Межа: лексичний фільтр — не доказ відсутності перефразувань (⏭️ хибні пропуски й спрацювання на живих текстах — live pass).
 */
import { NUMERAL_WORD_RE } from "@sitelens/schemas";
import {
  CORE_BODY, CURRENCY, DIGITS, L, PCT_UNIT, POP_WORDS, R, applyMasks, normalizeText, splitSentences,
} from "./report-rules.js";
import { checkTextField, ruleOf, type GuardedField, type Issue } from "./text.js";

export const GUARD_VERSION = "report-guard-v2";

export interface GuardCtx {
  field?: GuardedField;
  /** білий список чисел зі структурного правила: значення з доказів/скорингу («20%», «12 990 грн», «2 роки»…) */
  evidence_values?: readonly string[];
  /** видимий текст сторінок (лексичні правила, що залежать від наявності в доказах) */
  evidence_corpus?: string;
  /** false → лише лексика (рядки, які не є TemplatedText: причини, банери коду) */
  structural?: boolean;
}
export interface GuardResult { ok: boolean; issues: Issue[]; rule_ids: string[] }

// ---------------------------------------------------------------- 1. структурне правило чисел
const NUM_TOKEN = /(?<![\p{L}])\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
const canonNum = (s: string): string => s.replace(/,/g, ".").replace(/^0+(?=\d)/, "");

/** числові токени зі значень доказів: «12 990 грн» → {12, 990}; «20 %» → {20} */
export function whitelistTokens(values: readonly string[]): { nums: Set<string>; words: string } {
  const nums = new Set<string>();
  for (const v of values) for (const m of normalizeText(v).matchAll(NUM_TOKEN)) nums.add(canonNum(m[0]));
  return { nums, words: ` ${values.map((v) => normalizeText(v).toLowerCase()).join(" ")} ` };
}

/** усталені складні слова з «double», які не є кількістю */
const COMPOUND_OK = new RegExp(`${L}(?:double-(?:check|click|tap|checking|clicking|entry|opt-in|barrel))${R}`, "giu");

/** числа й числівники поза білим списком; дозволені форми коду маскуються тими самими масками, що й лексика */
export function structuralNumberViolations(rawText: string, evidenceValues: readonly string[] = []): Issue[] {
  const t = normalizeText(rawText);
  const wl = whitelistTokens(evidenceValues);
  const masked = applyMasks(t).replace(COMPOUND_OK, " ⟂ ");
  const out: Issue[] = [];
  for (const m of masked.matchAll(NUM_TOKEN)) {
    if (!wl.nums.has(canonNum(m[0]))) out.push(`structural_number: «${m[0]}» немає в білому списку значень з доказів`);
  }
  if (/%|‰/u.test(masked) && !out.length) {
    // «%» без цифри в білому списку: «%» без числа не є значенням
    if (!/\p{Nd}\s?%/u.test(masked)) out.push("structural_number: знак відсотка без числа з білого списку");
  }
  for (const m of masked.matchAll(NUMERAL_WORD_RE)) {
    const w = m[0].toLowerCase();
    if (!wl.words.includes(` ${w} `) && !wl.words.includes(w)) out.push(`structural_number: числівник/кількісне слово «${m[0]}» поза білим списком`);
  }
  return out;
}

// ---------------------------------------------------------------- 3a. відсоток/сума поруч із бізнес-словами
const BIZ = new RegExp(`${L}(?:${CORE_BODY}|market|markets|ринк\\p{L}*|ринок|orders|замовлен\\p{L}*|bounce|abandon\\p{L}*|drop-?offs?|retention|відмов\\p{L}*|покинут\\p{L}*|утриман\\p{L}*)\\p{L}*${R}`, "iu");
const POP_OF = new RegExp(`^\\s*(?:(?:of|від|з|із)\\s+)?(?:(?:all|the|our|your|усіх|наших|ваших|всіх)\\s+)?(?:${POP_WORDS})${R}`, "iu");
const PCT_TOK = new RegExp(`(?:${L}[+-]?${DIGITS}\\s?(?:${PCT_UNIT})${R}|[+-]?${DIGITS}\\s?%)`, "giu");
const MONEY_TOK = new RegExp(`(?:${L}(?:${CURRENCY})\\s?${DIGITS}(?:\\s\\d{3})*\\s?(?:тис\\.?|млн\\.?|млрд\\.?|k|m|bn|thousand|million|billion|тисяч\\p{L}*|мільйон\\p{L}*)?|${L}${DIGITS}(?:\\s\\d{3})*\\s?(?:${CURRENCY})${R})`, "giu");

function windowWords(s: string, index: number, len: number, n: number): string {
  const before = s.slice(0, index).split(/\s+/).slice(-n).join(" ");
  const after = s.slice(index + len).split(/\s+/).slice(0, n).join(" ");
  return `${before} ${after}`;
}

export function businessNumberViolations(rawText: string, evidenceValues: readonly string[] = []): Issue[] {
  const out: Issue[] = [];
  const wl = whitelistTokens(evidenceValues);
  for (const s of splitSentences(applyMasks(normalizeText(rawText)))) {
    for (const m of s.matchAll(PCT_TOK)) {
      const win = windowWords(s, m.index ?? 0, m[0].length, 5);
      const after = s.slice((m.index ?? 0) + m[0].length);
      if (BIZ.test(win) || POP_OF.test(after)) out.push(`business_percent: «${m[0].trim()}» поруч із бізнес-результатом/ринком/людьми — не виводиться з доказів`);
    }
    for (const m of s.matchAll(MONEY_TOK)) {
      const nums = [...m[0].matchAll(NUM_TOKEN)].map((x) => canonNum(x[0]));
      if (nums.every((n) => wl.nums.has(n))) continue;
      if (BIZ.test(windowWords(s, m.index ?? 0, m[0].length, 5))) out.push(`business_amount: «${m[0].trim()}» поруч із продажами/виручкою/ринком — не виводиться з доказів`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 3b. прогнози без чисел (G2, DEV-47/DEV-58)
const OUTCOME = "conversions?|converts?|sales|revenues?|profits?|income|orders|sign-?ups|purchases|bookings|bounce(?:\\s+rate)?|cart\\s+abandonment|abandonment|drop-?offs?|retention|engagement|checkout\\s+completion|"
  + "конверс\\p{L}*|продаж\\p{L}*|вируч\\p{L}*|прибут\\p{L}*|дохід\\p{L}*|доход\\p{L}*|замовлен\\p{L}*|реєстрац\\p{L}*|відмов\\p{L}*|покинут\\p{L}*|утриман\\p{L}*|залучен\\p{L}*";
const FUTURE_EN = "will|would|is\\s+going\\s+to|are\\s+going\\s+to|is\\s+bound\\s+to|is\\s+sure\\s+to|is\\s+certain\\s+to|guarantee[sd]?|shall";
const MOVE_EN = "increase|grow|boost|rise|improve|lift|double|triple|drop|fall|decline|decrease|surge|jump|climb|soar|skyrocket|multiply|recover|shrink|collapse|plunge";
const ADV = "significantly|substantially|dramatically|markedly|noticeably|sharply|greatly|considerably|strongly|massively|steadily|clearly|immediately|quickly|inevitably|automatically";
const FORECAST_LINES: Array<{ id: string; re: RegExp; note: string }> = [
  { id: "forecast_no_number", re: new RegExp(`${L}(?:${OUTCOME})${R}(?:\\s+\\p{L}+){0,3}?\\s+(?:${FUTURE_EN})(?:\\s+(?:${ADV}))?\\s+(?:${MOVE_EN})${R}`, "iu"), note: "прогноз руху бізнес-результату без числа (EN, результат → дієслово)" },
  { id: "forecast_no_number", re: new RegExp(`${L}(?:${FUTURE_EN})(?:\\s+(?:${ADV}))?\\s+(?:${MOVE_EN})${R}(?:\\s+\\p{L}+){0,3}?\\s+(?:${OUTCOME})${R}`, "iu"), note: "прогноз руху бізнес-результату без числа (EN, дієслово → результат)" },
  { id: "forecast_no_number", re: new RegExp(`${L}(?:(?:customers|users|visitors|shoppers|buyers|clients)\\s+(?:will|would)\\s+(?:${ADV}\\s+)?(?:buy|purchase|convert|abandon|leave|trust|love|prefer|choose|complete|return|stay|spend)|(?:more|fewer|less)\\s+(?:customers|users|visitors|shoppers|buyers|clients)\\s+(?:will|would)\\s+\\p{L}+)${R}`, "iu"), note: "прогноз поведінки реальних людей без числа" },
  { id: "forecast_no_number", re: new RegExp(`${L}(?:(?:${ADV})\\s+(?:more|higher|better|greater)\\s+(?:${OUTCOME})|(?:${OUTCOME})\\s+(?:${ADV})\\s+(?:${MOVE_EN})|guarantee[sd]?\\s+(?:\\p{L}+\\s+){0,2}?(?:${OUTCOME}))${R}`, "iu"), note: "«суттєво більше продажів/гарантований результат»" },
  // UK: майбутній час / умовний спосіб + результат; «суттєвий приріст…»
  { id: "forecast_no_number", re: new RegExp(`${L}(?:${OUTCOME})${R}(?:\\s+\\p{L}+){0,3}?\\s+(?:зросту\\p{L}*|виросту\\p{L}*|збільшать\\p{L}*|збільшить\\p{L}*|підвищать\\p{L}*|підвищить\\p{L}*|покращать\\p{L}*|покращить\\p{L}*|поліпшать\\p{L}*|поліпшить\\p{L}*|стрибн\\p{L}*|злетят\\p{L}*|впадуть|впаде|впаду\\p{L}*|скоротят\\p{L}*|скоротить|зменшать\\p{L}*|зменшить|знизят\\p{L}*|знизить|подвоя\\p{L}*|подвоїт\\p{L}*|потроя\\p{L}*|потроїт\\p{L}*|зрост\\p{L}*|збільш\\p{L}*|підвищ\\p{L}*)${R}`, "iu"), note: "прогноз руху бізнес-результату без числа (UK, результат → дієслово)" },
  { id: "forecast_no_number", re: new RegExp(`${L}(?:зросту\\p{L}*|виросту\\p{L}*|збільшать\\p{L}*|збільшить\\p{L}*|підвищать\\p{L}*|підвищить\\p{L}*|покращать\\p{L}*|покращить\\p{L}*|подвоя\\p{L}*|подвоїт\\p{L}*|потроя\\p{L}*|потроїт\\p{L}*|скоротят\\p{L}*|скоротить|зменшать\\p{L}*|зменшить|знизят\\p{L}*|знизить|впадуть|впаде|стрибн\\p{L}*)${R}(?:\\s+\\p{L}+){0,3}?\\s+(?:${OUTCOME})${R}`, "iu"), note: "прогноз руху бізнес-результату без числа (UK, дієслово → результат)" },
  { id: "forecast_no_number", re: new RegExp(`${L}(?:(?:покупці|клієнти|користувачі|відвідувачі)\\s+(?:[\\p{L}']+\\s+){0,2}?(?:купуватимуть|повертатимуть\\p{L}*|залишатимуть\\p{L}*|залишать\\p{L}*|покидатимуть|покинуть|довірятимуть|оберуть|куплять|повернуться|залишаться|охочіше\\p{L}*)|(?:суттєв|значн|різк|стрімк|гарантован|неминуч)\\p{L}*\\s+(?:приріст|зростання|падіння|збільшення|зменшення|скорочення)\\s+(?:${OUTCOME}))${R}`, "iu"), note: "прогноз поведінки людей / «суттєвий приріст» без числа (UK)" },
  { id: "forecast_no_number", re: new RegExp(`${L}(?:(?:${OUTCOME})\\s+(?:суттєво|значно|різко|стрімко|неминуче|обов'язково|точно|гарантовано|набагато)\\s+\\p{L}+|(?:суттєво|значно|різко|стрімко|неминуче|обов'язково|точно|гарантовано|набагато)\\s+(?:більше|вищі|вищий|вища|вище)\\s+(?:${OUTCOME}))${R}`, "iu"), note: "«продажі суттєво …» / «значно більше продажів» (UK)" },
];
export function forecastViolations(rawText: string): Issue[] {
  const out: Issue[] = [];
  for (const s of splitSentences(applyMasks(normalizeText(rawText)))) {
    for (const r of FORECAST_LINES) {
      const m = r.re.exec(s);
      if (m) { out.push(`${r.id}: «${m[0].trim()}» — ${r.note}`); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- композиція
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** повний guard одного тексту */
export function guardText(text: string, ctx: GuardCtx = {}): GuardResult {
  const values = ctx.evidence_values ?? [];
  const corpus = [ctx.evidence_corpus ?? "", ...values].join(" \n ");
  const issues: Issue[] = [];
  if (ctx.structural !== false) issues.push(...structuralNumberViolations(text, values));
  issues.push(...checkTextField(ctx.field ?? "finding_text", text, corpus));
  issues.push(...businessNumberViolations(text, values));
  issues.push(...forecastViolations(text));
  const u = uniq(issues);
  return { ok: u.length === 0, issues: u, rule_ids: uniq(u.map(ruleOf)) };
}

export interface SentenceGuardOutcome { text: string; kept: number; removed: number; rule_ids: string[] }
/** видаляє речення, що порушують guard; решту повертає (склеєні пробілом) */
export function dropViolatingSentences(text: string, ctx: GuardCtx = {}): SentenceGuardOutcome {
  const parts = splitSentences(text);
  const keep: string[] = [];
  const rules: string[] = [];
  for (const s of parts) {
    const r = guardText(s, ctx);
    if (r.ok) keep.push(s); else rules.push(...r.rule_ids);
  }
  return { text: keep.join(" "), kept: keep.length, removed: parts.length - keep.length, rule_ids: uniq(rules) };
}

export type GuardStatusOut = "passed" | "regenerated" | "sentences_removed";
export interface GuardedText { text: string | null; status: GuardStatusOut; attempts: number; rule_ids: string[]; sentences_removed: number }
export const MAX_REGENERATIONS = 2;

/**
 * Політика §33: текст → guard; порушення → до 2 регенерацій (callback отримує перелік порушень) → якщо все ще порушує,
 * порушні речення видаляються з позначкою (status=sentences_removed). Якщо не лишилось жодного речення — text=null
 * (кодовий шаблон підставляє buildReport). Без `regenerate` — одразу видалення (attempts=0).
 */
export async function guardWithRegeneration(text: string, ctx: GuardCtx, regenerate?: (issues: Issue[], attempt: number) => Promise<string | null>): Promise<GuardedText> {
  let cur = text;
  const first = guardText(cur, ctx);
  if (first.ok) return { text: cur, status: "passed", attempts: 0, rule_ids: [], sentences_removed: 0 };
  const rules = [...first.rule_ids];
  let issues = first.issues;
  let attempts = 0;
  while (regenerate && attempts < MAX_REGENERATIONS) {
    attempts++;
    const next = await regenerate(issues, attempts);
    if (next === null) break;
    cur = next;
    const r = guardText(cur, ctx);
    if (r.ok) return { text: cur, status: "regenerated", attempts, rule_ids: uniq(rules), sentences_removed: 0 };
    rules.push(...r.rule_ids);
    issues = r.issues;
  }
  const dropped = dropViolatingSentences(cur, ctx);
  return { text: dropped.text.length > 0 ? dropped.text : null, status: "sentences_removed", attempts, rule_ids: uniq([...rules, ...dropped.rule_ids]), sentences_removed: Math.max(1, dropped.removed) };
}
