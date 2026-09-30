/**
 * Кодовий фільтр дій агента (G0-11, SPEC §20, DEV-12). ЧИСТІ функції без браузера: модель лише пропонує, код вирішує.
 * Ніщо з тексту сторінки чи відповіді моделі не обходить цей шар (prompt injection, G0-12).
 *
 * Рівні захисту (кожен окремо доведений тестом):
 *   1. `checkAction`     — дія зі списку §20, локатор семантичний; navigate_internal_link лише same-origin;
 *   2. `checkElement`    — елемент, який агент хоче натиснути: URL (deny-list), origin, текст (deny-list і комерційні дієслова CTA),
 *                          submit форми, `download`, небезпечна схема;
 *   3. `denyUrl`         — той самий deny-list на рівні мережі (context.route у journey.ts): JS-навігація/fetch теж не дійде до цілі;
 *   4. secureLaunch      — блок усіх не-GET/HEAD (не тут).
 * Комерційне дієслово CTA («Add to cart», «В кошик») — НЕ помилка агента: це «знайдено» (кнопка є й доступна), але не «натиснуто».
 */
import { CTA_RE } from "../audit/patterns.js";

export const AGENT_ACTIONS = ["click", "scroll", "back", "navigate_internal_link", "stop_success", "stop_failure"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];
/** SPEC §20 «Never allow» */
export const FORBIDDEN_AGENT_ACTIONS = ["submit_payment", "send_message", "submit_contact_form", "create_account", "delete", "download_unknown_binary", "external_login"] as const;

export const SEMANTIC_ROLES = ["link", "button", "tab", "menuitem", "checkbox", "radio", "option", "heading", "textbox", "combobox", "img", "text", "label"] as const;
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];
export interface SemanticTarget { role: SemanticRole; name: string }
const TARGET_RE = new RegExp(`^(${SEMANTIC_ROLES.join("|")}):"([^"]{1,150})"$`, "u");
const COORDS_RE = /(?:^|[^\p{L}\p{N}])(?:x|y|left|top)\s*[=:]\s*-?\d|-?\d+\s*,\s*-?\d+|\d+\s?px|(?:^|[^\p{L}\p{N}])(?:coords?|coordinates|pixel)/iu;
const CSS_RE = /^[.#[]|>\s|::|\[[a-z-]+=|nth-child|\/\/[a-z*]/iu;
/** `role:"name"` → локатор; координати, CSS/XPath, «сирі» URL → null (§11) */
export function parseTarget(t: string): SemanticTarget | null {
  const s = t.trim();
  if (COORDS_RE.test(s) || CSS_RE.test(s)) return null;
  const m = TARGET_RE.exec(s);
  return m ? { role: m[1] as SemanticRole, name: m[2] as string } : null;
}

// ---------------------------------------------------------------------------------------------------------------- URL
export type UrlRule =
  | "bad_url" | "bad_scheme" | "cross_origin"
  | "add_to_cart" | "cart_mutation" | "checkout" | "logout" | "delete" | "unsubscribe" | "admin" | "action_param" | "binary_download";

const lower = (s: string) => s.toLowerCase();
/** сегмент шляху, обмежений `/ . _ -` або краєм (лише ASCII-роздільники: слова латиницею) */
const seg = (w: string) => new RegExp(`(?:^|[/._-])(?:${w})(?:$|[/._-])`, "i");
const ADD_TO_CART_PATH = seg("add-to-cart|add_to_cart|addtocart|add-to-basket|add-to-bag");
const CART_MUTATION_PATH = /(^|\/)cart\/(add|update|change|remove|clear)(\/|$|\.|\?)/i;
const CHECKOUT_PATH = seg("checkout");
const LOGOUT_PATH = seg("logout|log-out|log_out|signout|sign-out|sign_out|logoff");
const DELETE_PATH = seg("delete|remove-item|remove_item");
const UNSUB_PATH = seg("unsubscribe");
const ADMIN_PATH = /(^|\/)(wp-admin|wp-login\.php)(\/|$|\.)/i;
const BINARY_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|exe|msi|dmg|pkg|apk|deb|rpm|iso|bin|pdf|docx?|xlsx?|pptx?)$/i;
const CART_PARAMS = /^(add-to-cart|add_to_cart|addtocart|remove_item|removed_item|undo_item|empty-cart|clear-cart)$/i;
const STATE_ACTION_VALUE = /(delete|remove|add|logout|log-out|unsubscribe|subscribe|checkout|order|pay|submit|update|clear|empty)/i;

/**
 * Deny-list URL (G0-11). `navigation` — головна навігація (повний список, включно з будь-яким `?action=`);
 * `request` — фонові GET (xhr/fetch/beacon): без загального `?action=` (admin-ajax.php?action=search — легітимний пошук),
 * лише зі станозмінним значенням action. Повертає правило або null.
 */
export function denyUrl(raw: string, kind: "navigation" | "request" = "navigation"): UrlRule | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "bad_url"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "bad_scheme";
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* лишаємо сирий шлях */ }
  const p = lower(path);
  for (const k of u.searchParams.keys()) if (CART_PARAMS.test(k)) return "add_to_cart";
  if (ADD_TO_CART_PATH.test(p)) return "add_to_cart";
  if (CART_MUTATION_PATH.test(p)) return "cart_mutation";
  if (CHECKOUT_PATH.test(p)) return "checkout";
  if (LOGOUT_PATH.test(p)) return "logout";
  if (DELETE_PATH.test(p)) return "delete";
  if (UNSUB_PATH.test(p)) return "unsubscribe";
  if (ADMIN_PATH.test(p) && !/admin-ajax\.php$/i.test(p)) return "admin";
  if (BINARY_EXT.test(p)) return "binary_download";
  for (const [k, v] of u.searchParams) {
    if (lower(k) !== "action") continue;
    if (kind === "navigation" || STATE_ACTION_VALUE.test(v)) return /delete|remove/i.test(v) ? "delete" : /logout|log-out/i.test(v) ? "logout" : "action_param";
  }
  if (/[?&](logout|log-out|signout)(=|&|$)/i.test(u.search)) return "logout";
  return null;
}

export const sameOrigin = (a: string, b: string): boolean => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

// ---------------------------------------------------------------------------------------------------------------- текст
/** Станозмінні дієслова (не комерційні): вихід/реєстрація/підписка/видалення/оплата. Лише початок тексту або весь короткий текст. */
export const DENY_TEXT_RE = new RegExp(
  "^(?:(?:sign|log)\\s?(?:out|off|in)|logout|login|register|sign\\s?up|create\\s+(?:an\\s+)?account|subscribe|unsubscribe|delete|remove|clear|empty|pay(?:\\s+now)?|place\\s+(?:an\\s+)?order|confirm\\s+order|send|submit|" +
  "вийти|вихід|увійти|вхід|зареєструватися|реєстрація|створити\\s+акаунт|підписатися|підписатись|відписатися|відписатись|видалити|прибрати|очистити|оплатити|сплатити|підтвердити\\s+замовлення|надіслати|відправити)(?![\\p{L}])",
  "iu",
);

export type TextRule = "state_text" | "commercial_cta";
/** `commercial_cta` — фіксується як «знайдено», не натискається; `state_text` — заборона без «знайдено». */
export function classifyElementText(text: string): TextRule | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (DENY_TEXT_RE.test(t)) return "state_text";
  if (CTA_RE.test(t)) return "commercial_cta";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------- дія
export interface ProposedAction { action: string; target: string }
export type ActionVerdict =
  | { ok: true; target: SemanticTarget | null }
  | { ok: false; rule: "forbidden_action" | "unknown_action" | "bad_target"; detail: string };

/** Рівень 1: дія зі списку §20 і семантичний локатор без координат/CSS/URL. */
export function checkAction(a: ProposedAction): ActionVerdict {
  if ((FORBIDDEN_AGENT_ACTIONS as readonly string[]).includes(a.action)) return { ok: false, rule: "forbidden_action", detail: `${a.action} заборонено (§20)` };
  if (!(AGENT_ACTIONS as readonly string[]).includes(a.action)) return { ok: false, rule: "unknown_action", detail: `${a.action} поза списком дозволених (§20)` };
  if (a.action === "click" || a.action === "navigate_internal_link") {
    const t = parseTarget(a.target);
    return t ? { ok: true, target: t } : { ok: false, rule: "bad_target", detail: `«${a.target.slice(0, 60)}» не семантичний локатор (§11)` };
  }
  if (a.action === "scroll") return ["down", "up", "top"].includes(a.target) ? { ok: true, target: null } : { ok: false, rule: "bad_target", detail: "scroll: лише down|up|top" };
  return a.target === "" ? { ok: true, target: null } : { ok: false, rule: "bad_target", detail: "для back і stop_* target порожній" };
}

/** Що код прочитав з елемента, який агент хоче натиснути (DOM, не модель). */
export interface ElementFacts {
  tag: string;
  text: string;
  href: string | null;
  /** submit/button всередині форми з не-GET методом або input[type=submit|image] */
  submits_form: boolean;
  has_download_attr: boolean;
}
export type ElementVerdict =
  | { ok: true }
  | { ok: false; rule: UrlRule | TextRule | "form_submit" | "download_attr" | "not_a_link"; detail: string };

/**
 * Рівень 2: перевірка елемента ПЕРЕД дією. `origin` — origin початку журналу.
 * `commercial_cta` повертається як відмова з правилом `commercial_cta`: викликач фіксує «знайдено», але не тисне.
 */
export function checkElement(action: "click" | "navigate_internal_link", el: ElementFacts, origin: string): ElementVerdict {
  if (action === "navigate_internal_link" && !el.href) return { ok: false, rule: "not_a_link", detail: "navigate_internal_link потребує посилання з href" };
  if (el.href) {
    const r = denyUrl(el.href, "navigation");
    if (r) return { ok: false, rule: r, detail: `href ${el.href.slice(0, 120)} у deny-list (${r})` };
    if (!sameOrigin(el.href, origin)) return { ok: false, rule: "cross_origin", detail: `href ${el.href.slice(0, 120)} поза origin ${origin}` };
  }
  if (el.has_download_attr) return { ok: false, rule: "download_attr", detail: "елемент із download" };
  const t = classifyElementText(el.text);
  if (t) return { ok: false, rule: t, detail: `текст «${el.text.slice(0, 60)}» → ${t}` };
  if (el.submits_form) return { ok: false, rule: "form_submit", detail: "натискання надіслало б форму (не-GET)" };
  return { ok: true };
}
