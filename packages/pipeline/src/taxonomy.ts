/**
 * Таксономія помилок SPEC §48 (12 класів): людські повідомлення (uk/en) і класифікатор збоїв захоплення.
 * Принцип §48: збій захоплення → помилка з поясненням, НІКОЛИ не аналіз (0 доказів, 0 знахідок).
 * Класифікатор — чиста функція над сигналами захоплення й рішеннями egress-проксі (тестується без браузера).
 */
import { ERROR_CLASSES, type ErrorClass } from "@sitelens/schemas";

export type Lang = "uk" | "en";
export { ERROR_CLASSES };
export type { ErrorClass };

interface Info { uk: string; en: string; transient: boolean }
const INFO: Record<ErrorClass, Info> = {
  invalid_url: { uk: "Некоректна або заборонена адреса: приймаються лише публічні http/https URL без логіна в адресі; локальні, приватні й службові адреси не перевіряються.", en: "Invalid or disallowed address: only public http/https URLs without credentials are accepted; local, private and metadata addresses are not audited.", transient: false },
  dns_failure: { uk: "Домен не вдалося знайти (помилка DNS). Перевірте написання адреси. Аналізу немає.", en: "The domain could not be resolved (DNS failure). Check the spelling of the address. No analysis was performed.", transient: false },
  ssl_failure: { uk: "Не вдалося встановити захищене з'єднання: недійсний або самопідписаний сертифікат HTTPS. Аналізу немає; перевірки сертифіката ми не обходимо.", en: "Could not establish a secure connection: invalid or self-signed HTTPS certificate. No analysis was performed; certificate checks are never bypassed.", transient: false },
  timeout: { uk: "Сайт не відповів вчасно (тайм-аут) або з'єднання не встановлено. Аналізу немає; спробуйте пізніше.", en: "The site did not respond in time (timeout) or the connection could not be established. No analysis was performed; try again later.", transient: true },
  bot_protection: { uk: "Сайт блокує автоматизований доступ (бот-захист / HTTP 403·429·503). Аналізу немає; обхід захисту не виконується.", en: "The site blocks automated access (bot protection / HTTP 403·429·503). No analysis was performed; protection is never bypassed.", transient: false },
  captcha: { uk: "Сторінка вимагає капчу («ви не робот»). Аналізу немає; капчу не розв'язуємо.", en: "The page requires a CAPTCHA. No analysis was performed; CAPTCHAs are never solved.", transient: false },
  browser_crash: { uk: "Браузер аварійно завершився під час захоплення. Аналізу немає для цієї сторінки; повторіть аудит.", en: "The browser crashed during capture. No analysis for this page; please retry the audit.", transient: true },
  page_crash: { uk: "Сторінка аварійно завершилась у браузері (crash вкладки). Аналізу немає для цієї сторінки.", en: "The page crashed in the browser (tab crash). No analysis for this page.", transient: true },
  redirect_loop: { uk: "Сторінка зациклена на переадресаціях (redirect loop). Аналізу немає.", en: "The page is stuck in a redirect loop. No analysis was performed.", transient: false },
  unsupported_site: { uk: "Сайт не підтримується: відповідь не є звичайною HTML-сторінкою або сайт відповів помилкою HTTP (4xx/5xx). Аналізу немає.", en: "Unsupported site: the response is not a regular HTML page or the site answered with an HTTP error (4xx/5xx). No analysis was performed.", transient: false },
  empty_page: { uk: "Сторінка порожня: після завантаження немає видимого вмісту. Аналізу немає.", en: "The page is empty: there is no visible content after loading. No analysis was performed.", transient: false },
  js_rendering_failure: { uk: "Сторінка не відмалювалась: помилки JavaScript залишили її без вмісту. Аналізу немає.", en: "The page failed to render: JavaScript errors left it without content. No analysis was performed.", transient: false },
};

export const isTransient = (c: ErrorClass): boolean => INFO[c].transient;
export function humanMessage(c: ErrorClass, lang: Lang = "uk", detail?: string): string {
  const base = INFO[c][lang];
  return detail ? `${base} (${detail})` : base;
}

export class ClassifiedError extends Error {
  constructor(public readonly errorClass: ErrorClass, public readonly detail: string) {
    super(`${errorClass}: ${detail}`);
  }
}

// ---------------------------------------------------------------- класифікатор

export interface ProxyDecisionLite { host: string; decision: string; reason: string }
export interface CaptureSignals {
  /** з ViewportCapture */
  navigation_completed: boolean;
  http_status: number | null;
  content_type: string | null;
  /** errorText із requestfailed для document/головного запиту, напр. "net::ERR_CERT_AUTHORITY_INVALID" */
  document_failures: string[];
  visible_text_length: number;
  visible_links: number;
  js_error_count: number;
  console_error_count: number;
  visible_text_sample: string;
  /** результат detectBotProtection */
  bot: { blocked: boolean; kind: string | null; signals: string[] };
  /** рішення проксі для хоста цілі за час захоплення */
  proxy: ProxyDecisionLite[];
  target_host: string;
}
export interface Classified { errorClass: ErrorClass; detail: string }

const DNS_RE = /резолв не вдався|резолвер не повернув адрес|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i;
const SSL_RE = /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL|SSL_ERROR|certificate/i;
const INVALID_RE = /ERR_UNSAFE_PORT|ERR_UNSAFE_REDIRECT|ERR_DISALLOWED_URL_SCHEME|ERR_INVALID_URL|ERR_ADDRESS_INVALID/i;
const LOOP_RE = /ERR_TOO_MANY_REDIRECTS/i;
const JS_NEEDED_RE = /enable javascript|javascript (is )?(required|disabled)|you need to enable javascript|потрібно ввімкнути javascript|увімкніть javascript/i;

/** null → захоплення придатне до аналізу. Порядок: рішення проксі → мережа → HTTP → бот → вміст. */
export function classifyCapture(s: CaptureSignals): Classified | null {
  // 1. рішення egress-проксі про хост цілі (перед усім: заблоковане проксі виглядає для браузера як 403/502)
  const host = s.proxy.filter((p) => p.host === s.target_host);
  const deny = host.find((p) => p.decision === "deny");
  if (deny) {
    if (DNS_RE.test(deny.reason)) return { errorClass: "dns_failure", detail: deny.reason };
    return { errorClass: "invalid_url", detail: `адресу заблоковано egress-проксі: ${deny.reason}` };
  }
  const upErr = host.find((p) => p.decision === "error");
  const fails = s.document_failures.join(" | ");
  // 2. мережеві збої документа
  if (!s.navigation_completed || s.http_status === null) {
    if (INVALID_RE.test(fails)) return { errorClass: "invalid_url", detail: `браузер відмовився від адреси: ${fails}` };
    if (LOOP_RE.test(fails)) return { errorClass: "redirect_loop", detail: fails };
    if (/ERR_ABORTED/i.test(fails) && !/ERR_CERT|ERR_SSL/i.test(fails) && !upErr) return { errorClass: "unsupported_site", detail: `навігацію перервано (${fails}): ймовірно не HTML-сторінка (завантаження файлу)` };
    if (SSL_RE.test(fails)) return { errorClass: "ssl_failure", detail: fails };
    if (DNS_RE.test(fails)) return { errorClass: "dns_failure", detail: fails };
    if (upErr && DNS_RE.test(upErr.reason)) return { errorClass: "dns_failure", detail: upErr.reason };
    return { errorClass: "timeout", detail: fails || (upErr ? upErr.reason : "навігація не завершилась за 30 с") };
  }
  // 3. бот-захист (S1a, DEV-42): статуси 403/429/503, challenge, капча
  if (s.bot.blocked) return { errorClass: s.bot.kind === "captcha" ? "captcha" : "bot_protection", detail: s.bot.signals.slice(0, 6).join(", ") };
  // 4. HTTP-помилка / не-HTML
  if (s.http_status >= 400) return { errorClass: "unsupported_site", detail: `HTTP ${s.http_status}` };
  if (s.content_type !== null && !/^(text\/html|application\/xhtml\+xml)/i.test(s.content_type)) return { errorClass: "unsupported_site", detail: `Content-Type ${s.content_type}` };
  // 5. вміст
  const almostEmpty = s.visible_text_length < 20 && s.visible_links === 0;
  if (almostEmpty) {
    if (s.js_error_count > 0 || s.console_error_count > 0) return { errorClass: "js_rendering_failure", detail: `pageerror=${s.js_error_count}, console.error=${s.console_error_count}` };
    return { errorClass: "empty_page", detail: `видимого тексту ${s.visible_text_length} символів` };
  }
  if (s.visible_text_length < 400 && s.visible_links === 0 && JS_NEEDED_RE.test(s.visible_text_sample)) return { errorClass: "js_rendering_failure", detail: "сторінка вимагає JavaScript, вмісту немає" };
  return null;
}

/** Виняток під час захоплення → клас (краш вкладки/браузера, watchdog). */
export function classifyThrown(err: unknown, opts: { browserConnected: boolean }): Classified {
  const m = err instanceof Error ? err.message : String(err);
  if (/page crashed|target crashed|crashed/i.test(m) && !/browser has been closed/i.test(m)) return { errorClass: "page_crash", detail: m.slice(0, 200) };
  if (!opts.browserConnected || /browser has been closed|browser closed|target page, context or browser has been closed|connection closed|browser\.newcontext|browser\.close|has been disconnected/i.test(m)) return { errorClass: "browser_crash", detail: m.slice(0, 200) };
  if (/watchdog|timeout/i.test(m)) return { errorClass: "timeout", detail: m.slice(0, 200) };
  if (err instanceof ClassifiedError) return { errorClass: err.errorClass, detail: err.detail };
  return { errorClass: "browser_crash", detail: `неочікувана помилка захоплення: ${m.slice(0, 200)}` };
}
