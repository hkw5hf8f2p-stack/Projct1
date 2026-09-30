/**
 * Перевірка доказу friction (SPEC §23, DEV-63 → DEV-91, SCORING_SPEC §14.1). Чиста функція, без I/O.
 * Міряє ПРАВДИВІСТЬ (чи є цей текст на сторінці), а не форму лапок: цитата в будь-яких парних лапках або голий текст без
 * лапок приймається, якщо після нормалізації дослівно міститься у видимому тексті/a11y-outline сторінки friction і має
 * мінімальну довжину. Вигадана/перефразована цитата відхиляється. `NOT_FOUND: …` — твердження відсутності.
 * Нормалізація — лише для порівняння; `excerpt` повертається як у моделі (без обгорток).
 */

export type QuoteRejectReason = "no_verifiable_evidence" | "quote_not_on_page" | "quote_too_short";
export type QuoteVerdict =
  | { ok: true; kind: "quote"; excerpt: string }
  | { ok: true; kind: "absence" }
  | { ok: false; reason: QuoteRejectReason };

/** SCORING_SPEC §14.1: цитата ≥ 12 символів АБО ≥ 3 слова (після нормалізації й зняття країв). */
export const QUOTE_MIN = { chars: 12, words: 3 } as const;

const NOT_FOUND_RE = /^\s*NOT_FOUND\s*:\s*\S/iu;
/** парні лапки; ASCII `'` навмисно ні (апостроф: «пом'якшувач»); `‘…’` лише з відкривальною ‘ */
const SPAN_RE = /"([^"]{1,300})"|«([^»]{1,300})»|“([^”"]{1,300})”|„([^“”]{1,300})[“”]|‘([^’]{1,300})’/gu;
const WRAP_CHARS = "\"'`«»“”„‘’‹›";
const WRAP_EDGE_RE = new RegExp(`^[\\s${WRAP_CHARS}]+|[\\s${WRAP_CHARS}]+$`, "gu");

/** нормалізація для порівняння (не для показу) */
export function normQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/[\u2019\u02BC\u2018\u2032`]/gu, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, "-")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/** зняти з країв нормалізованої цитати три крапки й завершальну пунктуацію (лише вкорочує цитату) */
function trimEdges(n: string): string {
  let s = n, prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(?:…|\.\.\.)\s*/u, "").replace(/\s*(?:…|\.\.\.)$/u, "").replace(/[.,;:]+$/u, "").trim();
  }
  return s;
}

/** нормалізація + зняття країв (для звірки цитати зі сторінкою та з якорем E1, SCORING_SPEC §14.1–§14.2) */
export const normForMatch = (s: string): string => trimEdges(normQuote(s));

export const wordCount = (n: string): number => (n.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? []).length;
export const quoteLongEnough = (n: string): boolean => [...n].length >= QUOTE_MIN.chars || wordCount(n) >= QUOTE_MIN.words;

/** спани в парних лапках (сирий текст) */
export function extractQuoteSpans(evidence: string): string[] {
  return [...evidence.matchAll(SPAN_RE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]) as string);
}
export const stripWrappers = (s: string): string => s.replace(WRAP_EDGE_RE, "");

/** одна цитата: нормалізована з країв, на сторінці? довга? */
function checkOne(raw: string, corpusN: string): { onPage: boolean; long: boolean; n: string } {
  const n = normForMatch(raw);
  return { n, onPage: n.length > 0 && corpusN.includes(n), long: quoteLongEnough(n) };
}

/**
 * @param corpus видимий текст (усі viewport) + a11y-outline сторінки ЦІЄЇ friction; можна передати вже нормалізований через `normQuote`
 */
export function verifyFrictionEvidence(evidence: string, corpus: string): QuoteVerdict {
  if (NOT_FOUND_RE.test(evidence)) return { ok: true, kind: "absence" };
  const corpusN = normQuote(corpus);
  const spans = extractQuoteSpans(evidence);
  if (spans.length > 0) {
    const checked = spans.map((s) => ({ raw: s.trim(), ...checkOne(s, corpusN) }));
    if (!checked.every((c) => c.onPage)) return { ok: false, reason: "quote_not_on_page" };
    const long = checked.filter((c) => c.long).sort((a, b) => b.n.length - a.n.length);
    if (long.length === 0) return { ok: false, reason: "quote_too_short" };
    return { ok: true, kind: "quote", excerpt: long[0]!.raw };
  }
  const bare = stripWrappers(evidence.trim());
  const c = checkOne(bare, corpusN);
  if (!c.onPage) return { ok: false, reason: "no_verifiable_evidence" };
  if (!c.long) return { ok: false, reason: "quote_too_short" };
  return { ok: true, kind: "quote", excerpt: bare };
}
