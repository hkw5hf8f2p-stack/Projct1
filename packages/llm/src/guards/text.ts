/**
 * Кодові перевірки виходу LLM (SPEC §34, §63, §8; G0-12; DEV-7 «код перевіряє, LLM не вирішує»).
 * Кожне порушення — рядок `<rule>: <опис>`. Межі слів лише через `(?<!\p{L})…(?!\p{L})` (G0-26), не `\b`.
 */
export type Issue = string;
export const ruleOf = (issue: Issue): string => issue.split(":", 1)[0] ?? issue;

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const word = (alts: string[]) => new RegExp(`${L}(?:${alts.join("|")})${R}`, "iu");
const stem = (alts: string[]) => new RegExp(`${L}(?:${alts.join("|")})\\p{L}*${R}`, "iu");

export const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- вигадані числа (§4, §63)
const PERCENT_RE = /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s?(?:%|відсотк\p{L}*|percent|per cent)/giu;
const MARKET_TERMS = [
  word(["TAM", "SAM", "SOM"]),
  stem(["market size", "market share", "розмір\\s+ринку", "обсяг\\s+ринку", "част\\p{L}+\\s+ринку"]),
  word(["conversion rate", "conversion uplift", "uplift", "ARPU", "CAC", "LTV"]),
  stem(["виручк", "revenue", "конверс\\p{L}*\\s+(?:зросте|виросте|підвищ)"]),
  /(?<![\p{L}\p{N}])\d[\d\s.,]*\s?(?:млн|млрд|тис\.?|million|billion|mln|bn)(?![\p{L}\p{N}])/iu,
];

/** відсотки, яких немає в доказах (корпус = видимий текст/метадані сторінок); TAM/uplift/виручка — ніколи */
export function findInventedNumbers(fieldValues: string[], evidenceCorpus: string): Issue[] {
  const out: Issue[] = [];
  const corpus = evidenceCorpus.replace(/\s+/g, " ");
  for (const v of fieldValues) {
    for (const m of v.matchAll(PERCENT_RE)) {
      const num = m[1] as string;
      const seen = new RegExp(`(?<![\\p{L}\\p{N}])${num.replace(".", "[.,]")}\\s?(?:%|відсотк|percent|per cent)`, "iu");
      if (!seen.test(corpus)) out.push(`invented_percent: «${m[0]}» немає в наданих доказах`);
    }
    for (const re of MARKET_TERMS) {
      const m = re.exec(v);
      if (m) out.push(`invented_tam: «${m[0].trim()}» — ринок/виручка/uplift не виводяться з доказів`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- демографія й «% ринку» у лінзах (§8, §63)
const DEMO_WORDS = word([
  "woman", "women", "man", "men", "male", "female", "girl", "girls", "boy", "boys", "gender", "elderly", "pensioner", "pensioners", "retiree", "retirees",
  "teen", "teens", "teenager", "teenagers", "millennial", "millennials", "gen ?z", "boomer", "boomers", "middle-aged", "mom", "mother", "moms", "mothers", "dad", "father",
  "housewife", "homemaker", "low-income", "high-income", "wealthy", "rich", "poor", "immigrant", "immigrants", "ethnic", "ethnicity", "race", "racial",
  "christian", "muslim", "jewish", "catholic", "religious", "nationality", "\\d+[- ]?(?:year|yr)s?[- ]?old", "aged \\d+", "age \\d+",
]);
const DEMO_STEMS = stem([
  "жінк", "чолов", "дівчин", "хлопц", "хлопчик", "пенсіонер", "літн", "підлітк", "молодь", "мам(?=[аиуоє])", "татус", "батьк", "матір", "домогосподар",
  "заможн", "бідн", "малозабезпеч", "національн", "етнічн", "релігій", "християн", "мусульман", "єврей", "\\d+[- ]?річн", "віком\\s+\\d+",
]);
const MARKET_PCT = [
  /\d\s?%/u, stem(["відсотк", "percent"]),
  stem(["част\\p{L}+\\s+(?:ринку|населення|клієнтів|покупців|аудиторії)", "market share", "share of (?:the )?(?:market|population|users|customers)"]),
  stem(["\\d+\\s+(?:of|з|із)\\s+\\d+\\s+(?:users|customers|people|покупців|клієнтів|людей)"]),
];

export function findDemographics(fieldValues: string[]): Issue[] {
  const out: Issue[] = [];
  for (const v of fieldValues) {
    const d = DEMO_WORDS.exec(v) ?? DEMO_STEMS.exec(v);
    if (d) out.push(`lens_demographics: демографічна ознака «${d[0]}» (лінза має бути поведінковою, §8)`);
    for (const re of MARKET_PCT) {
      const m = re.exec(v);
      if (m) { out.push(`lens_market_percent: «${m[0].trim()}» — лінза не має відсотків/частки ринку (§8, §63)`); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- мова (D2, R-19)
export type Lang = "uk" | "en" | "ru" | "unknown";
export function detectLang(text: string): Lang {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = cyr + lat;
  if (total < 20) return "unknown";
  if (cyr / total > 0.6) {
    const ukOnly = /[іїєґІЇЄҐ]/.test(text);
    const ruOnly = /[ыэъёЫЭЪЁ]/.test(text);
    if (ruOnly && !ukOnly) return "ru";
    return "uk";
  }
  if (lat / total > 0.8) return "en";
  return "unknown";
}
export function findWrongLanguage(prose: string[], expected: "uk" | "en"): Issue[] {
  const got = detectLang(prose.join(" "));
  return got !== "unknown" && got !== expected ? [`wrong_language: очікувалась ${expected}, виявлено ${got}`] : [];
}

// ---------------------------------------------------------------- «unknown» у обов'язковому полі
export const UNKNOWN_RE = /^\s*(?:unknown|невідомо|н\/д|n\/a|none|null|-|—)\s*\.?\s*$/iu;
export const isUnknownValue = (s: string): boolean => UNKNOWN_RE.test(s);
export function findUnknownRequired(fields: Record<string, string>): Issue[] {
  return Object.entries(fields).filter(([, v]) => isUnknownValue(v)).map(([k]) => `unknown_required: поле ${k} обов'язкове й не може бути UNKNOWN`);
}

// ---------------------------------------------------------------- відлуння ін'єкції в тексті сторінки (G0-12)
const INJECTION = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+instructions?/iu,
  /disregard\s+(?:the\s+)?(?:system|previous)\s+(?:prompt|instructions?)/iu,
  stem(["ігноруй\\s+(?:усі\\s+)?(?:попередні|вищі)\\s+інструкц"]),
  /you\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak)/iu,
  /<<<\s*(?:END_)?PAGE[_ ]?DATA/iu,
];
export function findInjectionEcho(fieldValues: string[]): Issue[] {
  const out: Issue[] = [];
  for (const v of fieldValues) for (const re of INJECTION) { const m = re.exec(v); if (m) { out.push(`prompt_injection_echo: вихід повторює інструкцію зі сторінки («${m[0].slice(0, 40)}»)`); break; } }
  return out;
}

// ---------------------------------------------------------------- дії агента (§20, §21)
export const ALLOWED_ACTIONS = ["click", "scroll", "back", "navigate_internal_link", "stop_success", "stop_failure"] as const;
export const FORBIDDEN_ACTIONS = ["submit_payment", "send_message", "submit_contact_form", "create_account", "delete", "download_unknown_binary", "external_login"] as const;
