/**
 * Розпізнавання бот-захисту й відмов (SPEC §48, DEV-42): Cloudflare/challenge/captcha/403/429/503.
 * Чиста функція над полями захоплення (статус, вибрані заголовки, title, видимий текст, DOM-маркери).
 * Результат — ПОМИЛКА сторінки з причиною й ознаками, не аналіз: на такій сторінці 0 доказів і 0 знахідок.
 * Жодного обходу: ми лише розпізнаємо й зупиняємось.
 */

/** DOM-маркери, які збирає `captureViewport` (селектор → ім'я). Порядок стабільний. */
export const BOT_DOM_MARKERS: Array<[string, string]> = [
  ["#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running, .cf-browser-verification, #cf-wrapper, #cf-error-details", "cf_challenge_dom"],
  ["iframe[src*='challenges.cloudflare.com'], .cf-turnstile, script[src*='challenges.cloudflare.com']", "cf_turnstile"],
  ["script[src*='/cdn-cgi/challenge-platform/'], form[action*='/cdn-cgi/']", "cf_challenge_platform"],
  ["iframe[src*='recaptcha'], .g-recaptcha, script[src*='recaptcha/api']", "recaptcha"],
  ["iframe[src*='hcaptcha'], .h-captcha, script[src*='hcaptcha.com']", "hcaptcha"],
  ["#px-captcha, [id^='px-captcha']", "perimeterx"],
  ["iframe[src*='captcha-delivery.com'], script[src*='captcha-delivery.com'], script[src*='geo.captcha-delivery.com']", "datadome"],
  ["form[action*='captcha' i], input[name*='captcha' i], img[src*='captcha' i]", "captcha_generic"],
];

/** Заголовки, які зберігаємо в захопленні (без cookie й будь-яких секретів). */
export const KEPT_RESPONSE_HEADERS = ["server", "content-type", "retry-after", "x-datadome", "x-sucuri-id", "x-akamai-edgescape", "x-cache", "via"];
export const keepHeader = (name: string): boolean => KEPT_RESPONSE_HEADERS.includes(name) || name.startsWith("cf-") || name.startsWith("x-px");

export interface BotInput {
  http_status: number | null;
  headers: Record<string, string>;
  title: string;
  visible_text: string;
  markers: string[];
}

export type BotKind = "cloudflare_challenge" | "captcha" | "http_403" | "http_429" | "http_503" | "bot_wall";
export interface BotVerdict {
  blocked: boolean;
  kind: BotKind | null;
  /** статус, заголовки cf-*, DOM-маркери, збіг title/тексту — усе, що привело до рішення */
  signals: string[];
  /** людське пояснення для звіту (§48 «Show a useful error») */
  reason: string | null;
}

const TITLE_RE = /just a moment|attention required|checking your browser|access denied|are you (a )?(human|robot)|verify you are human|security check|перевірка браузера|доступ заборонено|потрібна перевірка|please wait while we|one more step|pardon our interruption|request blocked/i;
const TEXT_RE = /verify you are human|are you a robot|checking your browser|enable javascript and cookies to continue|complete the security check|ray id:|please complete the captcha|перевірка браузера|підтвердіть, що ви не робот|cloudflare/i;
const SMALL_TEXT = 1500;

export function detectBotProtection(i: BotInput): BotVerdict {
  const s = i.http_status;
  const signals: string[] = [];
  const h = i.headers;
  const text = i.visible_text.trim();
  const small = text.length < SMALL_TEXT;
  if (s !== null && s >= 400) signals.push(`http_status:${s}`);
  const cf = Object.keys(h).filter((k) => k.startsWith("cf-"));
  for (const k of cf) if (["cf-mitigated", "cf-chl-bypass", "cf-ray"].includes(k)) signals.push(`header:${k}${k === "cf-mitigated" ? "=" + h[k] : ""}`);
  if (/cloudflare/i.test(h["server"] ?? "")) signals.push("header:server=cloudflare");
  if (h["x-datadome"] !== undefined || /datadome/i.test(h["server"] ?? "")) signals.push("header:datadome");
  if (Object.keys(h).some((k) => k.startsWith("x-px"))) signals.push("header:perimeterx");
  if (h["retry-after"] !== undefined) signals.push(`header:retry-after=${h["retry-after"]}`);
  for (const m of i.markers) signals.push(`dom:${m}`);
  const titleHit = TITLE_RE.test(i.title);
  if (titleHit) signals.push(`title:${i.title.slice(0, 60)}`);
  const textHit = TEXT_RE.test(text);
  if (textHit && small) signals.push("text:challenge_phrase");

  const has = (m: string) => i.markers.includes(m);
  const cfChallenge = h["cf-mitigated"] === "challenge" || has("cf_challenge_dom") || has("cf_challenge_platform") || (has("cf_turnstile") && small);
  const captchaWidget = ["recaptcha", "hcaptcha", "perimeterx", "datadome", "captcha_generic"].some(has);
  const blocked = (kind: BotKind, reason: string): BotVerdict => ({ blocked: true, kind, signals, reason });

  // сильні ознаки першими; капча-віджет на довгій нормальній сторінці (форма контактів) — НЕ блок
  if (cfChallenge) return blocked("cloudflare_challenge", "Сторінка-виклик Cloudflare (challenge): сайт не віддав вміст автоматизованому клієнту. Аналізу немає; обхід не виконується.");
  if (s === 429) return blocked("http_429", `HTTP 429 (забагато запитів)${h["retry-after"] ? `, Retry-After: ${h["retry-after"]}` : ""}: сайт обмежує звернення. Аналізу немає; повторіть пізніше.`);
  if (s === 403) return blocked("http_403", `HTTP 403: доступ заборонено${cf.length ? " (заголовки Cloudflare)" : ""}. Ймовірно бот-захист або блок за UA/IP. Аналізу немає; обхід не виконується.`);
  if (s === 503) return blocked("http_503", `HTTP 503${cf.length ? " (Cloudflare)" : ""}: сервіс недоступний або перевірка браузера. Аналізу немає.`);
  if (captchaWidget && small && (titleHit || textHit || text.length < 400)) return blocked("captcha", "Сторінка вимагає капчу/перевірку «ви не робот». Аналізу немає; капчу не розв'язуємо.");
  if ((titleHit || textHit) && small) return blocked("bot_wall", "Сторінка схожа на бот-стіну (заголовок/текст перевірки браузера). Аналізу немає.");
  return { blocked: false, kind: null, signals, reason: null };
}
