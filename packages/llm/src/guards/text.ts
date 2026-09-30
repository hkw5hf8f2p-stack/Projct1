/**
 * Кодові перевірки виходу LLM (SPEC §34, §63, §8; G0-12; DEV-7 «код перевіряє, LLM не вирішує»).
 * Кожне порушення — рядок `<rule>: <опис>`. Межі слів лише через `(?<!\p{L})…(?!\p{L})` (G0-26), не `\b`.
 */
import { numericViolations, demographicViolations } from "./report-rules.js";
export type Issue = string;
export const ruleOf = (issue: Issue): string => issue.split(":", 1)[0] ?? issue;

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const stem = (alts: string[]) => new RegExp(`${L}(?:${alts.join("|")})\\p{L}*${R}`, "iu");

export const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- вигадані числа й демографія (S3-Fix-1: report-rules.ts)
/** відсотки, яких немає в доказах (корпус = видимий текст/метадані сторінок); TAM/uplift/виручка/кратність/частки — ніколи */
export function findInventedNumbers(fieldValues: string[], evidenceCorpus: string): Issue[] {
  return fieldValues.flatMap((v) => numericViolations(v, evidenceCorpus));
}
/** лінзи поведінкові: жодної демографії/особистих ознак і жодних відсотків/часток популяції (§8, §63) */
export function findDemographics(fieldValues: string[]): Issue[] {
  return fieldValues.flatMap((v) => demographicViolations(v));
}

// ---------------------------------------------------------------- ланцюг guard-ів за полем виходу (S3-Fix-1)
export type GuardedField = "reason_summary" | "finding_text" | "recommendation" | "lens_description" | "site_profile";
/** числовий guard — для всіх полів; демографія й «% ринку» — лише для лінз і профілю сайту */
export function checkTextField(field: GuardedField, text: string, evidenceCorpus = ""): Issue[] {
  const out = findInventedNumbers([text], evidenceCorpus);
  if (field === "lens_description" || field === "site_profile") out.push(...findDemographics([text]));
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
