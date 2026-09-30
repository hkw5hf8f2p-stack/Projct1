/**
 * Структурне правило чисел звіту (conclusions/sprint-3 «структурний білий список чисел», DEV-58).
 *
 * Текст звіту = `TemplatedText { template, params }`. Шаблон НЕ містить жодної цифри; кожне число в показаному тексті
 * підставляє код із типізованого поля звіту через плейсхолдер `{name}` → `params.name = { ptr: JSON Pointer, format }`.
 * Для тексту, що його написала модель (`origin: "llm"`), додатково заборонені числівники словами (EN + UK) — модель не
 * може «перефразувати» число. Лексичний guard (packages/reporting, S4) — друга лінія, не перша.
 *
 * Межі слів — лише `(?<![\p{L}\p{N}_'])…(?![\p{L}\p{N}_'])` (G0-26): `\b` у JS не бачить кирилиці.
 * Чисті функції без I/O.
 */

export type Lang = "uk" | "en";

const WL = String.raw`[\p{L}\p{N}_']`;
const B0 = String.raw`(?<!${WL})`;
const B1 = String.raw`(?!${WL})`;
const word = (body: string): RegExp => new RegExp(`${B0}(?:${body})${B1}`, "giu");

/** будь-яка десяткова цифра будь-якої писемності + знаки частки */
export const DIGIT_RE = /[\p{Nd}%‰]/u;

/**
 * Числівники й кількісні слова, заборонені в LLM-тексті. Свідомо НЕ входять (рішення DEV-58, щоб не відхиляти звичайну
 * мову; перевіряється корпусом у тесті): EN `one`, `first`, `second`, `most`, `single`; UK `один/одна/одне/одного`,
 * `перший`, `другий` (без «кожен …»), `обидва`. Порядкові UK частково ловляться стемами (`п'ятий`, `дев'ятий`, `десятий`) —
 * свідоме надобмеження (регенерація дешевша за пропуск); `third(s)`/`третин…` як частка — входять.
 */
const NUMERAL_EN = [
  String.raw`zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve`,
  String.raw`thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen`,
  String.raw`twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety`,
  String.raw`hundreds?|thousands?|millions?|billions?|trillions?|dozens?|score\s+of`,
  String.raw`half|halves|halved|halve|twice|thrice|double[sd]?|doubling|triple[sd]?|tripling|quadruple[sd]?|\p{L}+fold`,
  String.raw`thirds?|quarters?|fifths?|tenths?`,
  String.raw`percent|per\s+cent|percentage|percentages|percentile|basis\s+points?`,
  String.raw`majority|minority`,
  String.raw`every\s+(?:other|second|third|fourth|fifth|tenth)`,
].join("|");

const NUMERAL_UK = [
  String.raw`нуль|нуля`,
  String.raw`два|дві|двох|двом|двома|три|трьох|трьом|трьома|чотир\p{L}*`,
  String.raw`двоє|троє|четверо|п'ятеро|шестеро|семеро|десятеро|дюжин\p{L}*|десятк\p{L}*`,
  String.raw`п'ят\p{L}*|шіст\p{L}*|шість|сім|сім(?:ох|ом|ома)|вісім|вісім(?:ох|ом|ома)|дев'ят\p{L}*|десят\p{L}*`,
  String.raw`одинадцят\p{L}*|дванадцят\p{L}*|тринадцят\p{L}*|чотирнадцят\p{L}*|п'ятнадцят\p{L}*|шістнадцят\p{L}*|сімнадцят\p{L}*|вісімнадцят\p{L}*|дев'ятнадцят\p{L}*`,
  String.raw`двадцят\p{L}*|тридцят\p{L}*|сорок\p{L}*|шістдесят\p{L}*|сімдесят\p{L}*|вісімдесят\p{L}*|дев'яност\p{L}*`,
  String.raw`сто|ста|сотн\p{L}*|сотень|двісті|триста|чотириста|п'ятсот|тисяч\p{L}*|мільйон\p{L}*|мільярд\p{L}*|трильйон\p{L}*`,
  String.raw`половин\p{L}*|третин\p{L}*|чверт\p{L}*|вдвічі|удвічі|вдвоє|удвоє|втричі|утричі|вчетверо|учетверо|\p{L}*кратн\p{L}*`,
  String.raw`подво\p{L}*|потро\p{L}*|відсот\p{L}*|процент\p{L}*|більшість|більшості|меншість|меншості`,
  String.raw`кож(?:ен|н\p{L}*)\s+(?:друг|трет|четверт|п'ят|десят)\p{L}*`,
].join("|");

export const NUMERAL_WORD_RE = word(`${NUMERAL_EN}|${NUMERAL_UK}`);

/** апострофи → ' (як у guard, SCORING_SPEC §7.1) */
export const normalizeText = (t: string): string => t.normalize("NFKC").replace(/[’ʼ`]/g, "'");

export interface NumberViolation { kind: "digit" | "numeral_word"; span: string }

/** Порушення структурного правила в сирому шаблоні. `llm=false` — лише цифри (шаблони коду). */
export function numberViolations(template: string, llm: boolean): NumberViolation[] {
  const t = normalizeText(template);
  const out: NumberViolation[] = [];
  const d = t.match(new RegExp(DIGIT_RE.source, "gu"));
  if (d) for (const s of d) out.push({ kind: "digit", span: s });
  if (llm) for (const m of t.matchAll(NUMERAL_WORD_RE)) out.push({ kind: "numeral_word", span: m[0] });
  return out;
}

/**
 * DEV-98: число в LLM-тексті не відкидає весь текст. Речення з числівником-словом («вдвічі», «половина», «double») або
 * зі знаком частки (% ‰) видаляється цілком (такі речення — типова форма прогнозу/частки, маскування сховало б сигнал guard);
 * у решті речень кожна цифрова послідовність маскується «…» (ціни, розміри, строки з цитат сайту). Плейсхолдери `{name}`
 * не чіпаються. `null` — нічого змістовного не лишилось (< 2 слів) або правило все одно порушене (fail-closed).
 */
export const NUMBER_MASK = "…";
export function maskNumberSpans(text: string): { text: string; masked: number; sentences_removed: number } | null {
  let masked = 0;
  let removed = 0;
  const sentences = normalizeText(text).split(/(?<=[.!?])\s+/u);
  const kept: string[] = [];
  for (const sent of sentences) {
    const bare = sent.replace(/\{[a-z][a-z0-9_]*\}/g, " ");
    NUMERAL_WORD_RE.lastIndex = 0;
    if (/[%‰]/u.test(bare) || NUMERAL_WORD_RE.test(bare)) { removed++; continue; }
    const parts = sent.split(/(\{[a-z][a-z0-9_]*\})/g);
    kept.push(parts.map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/[+\-−±~≈]?[\p{Nd}](?:[\p{Nd}.,:\/\u00A0\u202F ]*[\p{Nd}])?/gu, () => { masked++; return NUMBER_MASK; }))).join(""));
  }
  NUMERAL_WORD_RE.lastIndex = 0;
  const out = kept.join(" ").replace(/…(?:[\s\-–—,]*…)+/gu, NUMBER_MASK).replace(/\s{2,}/g, " ").trim();
  const words = out.replace(/\{[a-z][a-z0-9_]*\}/g, " ").match(/\p{L}{2,}/gu) ?? [];
  if (words.length < 2 || numberViolations(out, true).length > 0) return null;
  return { text: out, masked, sentences_removed: removed };
}

export const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]*)\}/g;
/** імена плейсхолдерів у порядку появи (без повторів) */
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string))];
}
/** фігурні дужки поза плейсхолдерами заборонені (щоб `{` не маскувала підстановку) */
export const strayBraces = (template: string): boolean => /[{}]/.test(template.replace(PLACEHOLDER_RE, ""));

// ---------------------------------------------------------------- JSON Pointer (RFC 6901)
export function resolvePointer(root: unknown, ptr: string): { ok: true; value: unknown; path: string[] } | { ok: false } {
  if (ptr === "") return { ok: true, value: root, path: [] };
  if (!ptr.startsWith("/")) return { ok: false };
  const path = ptr.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const k of path) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(k)) return { ok: false };
      cur = cur[Number(k)];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, k)) return { ok: false };
      cur = (cur as Record<string, unknown>)[k];
    } else return { ok: false };
    if (cur === undefined) return { ok: false };
  }
  return { ok: true, value: cur, path };
}

// ---------------------------------------------------------------- рендер
export type ParamFormatName = "int" | "decimal" | "text" | "n_of_m" | "priority";
export interface TemplateParamLike { ptr: string; format: ParamFormatName }
export interface TemplatedTextLike { template: string; params: Record<string, TemplateParamLike>; origin: "code" | "llm" }

const UNIT: Record<Lang, Record<string, string>> = {
  en: { lenses: "lenses", sessions: "sessions", journeys: "journeys", tasks: "tasks", evaluations: "evaluations" },
  uk: { lenses: "лінз", sessions: "сесій", journeys: "журналів", tasks: "задач", evaluations: "оцінок" },
};

export interface ParamProblem { name: string; message: string }

/** значення параметра з поля звіту; повертає рядок для підстановки або проблему */
export function formatParam(report: unknown, p: TemplateParamLike, lang: Lang): string | { error: string } {
  const r = resolvePointer(report, p.ptr);
  if (!r.ok) return { error: `ptr ${p.ptr} не резолвиться` };
  // заборона: вказівник усередину іншого тексту (числа мусять жити в типізованих полях, не в тексті)
  if (r.path.some((k) => k === "template" || k === "params")) return { error: `ptr ${p.ptr} веде в текст, а не в типізоване поле` };
  const v = r.value;
  switch (p.format) {
    case "int":
      return typeof v === "number" && Number.isInteger(v) ? String(v) : { error: `int: ${p.ptr} не ціле` };
    case "decimal":
      return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : { error: `decimal: ${p.ptr} не число` };
    case "text":
      return typeof v === "string" && v.length > 0 ? v : { error: `text: ${p.ptr} не рядок` };
    case "priority":
      return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? (lang === "uk" ? `Пріоритет ${v}/100` : `Priority ${v}/100`) : { error: `priority: ${p.ptr} не 0..100` };
    case "n_of_m": {
      const o = v as { n?: unknown; m?: unknown; unit?: unknown; form?: unknown };
      if (!o || typeof o !== "object" || o.form !== "n_of_m_synthetic" || typeof o.n !== "number" || typeof o.m !== "number" || typeof o.unit !== "string") {
        return { error: `n_of_m: ${p.ptr} не SyntheticCount` };
      }
      const u = UNIT[lang][o.unit];
      if (!u) return { error: `n_of_m: невідома одиниця ${o.unit}` };
      return lang === "uk" ? `${o.n} з ${o.m} синтетичних ${u}` : `${o.n} of ${o.m} synthetic ${u}`;
    }
  }
}

/** перевірка тексту проти звіту: плейсхолдери ↔ params, вказівники резолвляться, структурне правило чисел */
export function templatedTextProblems(t: TemplatedTextLike, report: unknown, lang: Lang = "en"): string[] {
  const out: string[] = [];
  const ph = placeholders(t.template);
  const keys = Object.keys(t.params);
  for (const n of ph) if (!keys.includes(n)) out.push(`плейсхолдер {${n}} без params`);
  for (const k of keys) if (!ph.includes(k)) out.push(`params.${k} не використано в шаблоні`);
  if (strayBraces(t.template)) out.push("фігурні дужки поза плейсхолдером");
  for (const v of numberViolations(t.template, t.origin === "llm")) out.push(`число в шаблоні (${v.kind}): «${v.span}»`);
  for (const k of keys) {
    const r = formatParam(report, t.params[k] as TemplateParamLike, lang);
    if (typeof r !== "string") out.push(`params.${k}: ${r.error}`);
  }
  return out;
}

/** показаний текст; кидає, якщо текст порушує контракт (UI не має показувати «сирий» шаблон) */
export function renderText(t: TemplatedTextLike, report: unknown, lang: Lang): string {
  const probs = templatedTextProblems(t, report, lang);
  if (probs.length) throw new Error(`renderText: ${probs.join("; ")}`);
  return t.template.replace(PLACEHOLDER_RE, (_m, name: string) => formatParam(report, t.params[name] as TemplateParamLike, lang) as string);
}

/** обхід довільного JSON: усі об'єкти-тексти (мають template + params + origin) з їхнім JSON Pointer */
export function collectTexts(root: unknown): Array<{ ptr: string; text: TemplatedTextLike }> {
  const out: Array<{ ptr: string; text: TemplatedTextLike }> = [];
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (v: unknown, ptr: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o["template"] === "string" && o["params"] && typeof o["params"] === "object" && (o["origin"] === "code" || o["origin"] === "llm")) {
        out.push({ ptr, text: o as unknown as TemplatedTextLike });
        return;
      }
      for (const k of Object.keys(o).sort()) walk(o[k], `${ptr}/${esc(k)}`);
    }
  };
  walk(root, "");
  return out;
}
