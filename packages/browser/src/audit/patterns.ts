/**
 * Заморожені предикати детекторів (planning/eval/fixture-defect-map.md §3). Межі слів — лише `(?<!\p{L})…(?!\p{L})`
 * (G0-26), `\b` заборонено. Джерела (рядки) передаються і в сторінку (extract.js), і в Node.
 */
export const SHIP_SRC = String.raw`(?<!\p{L})(доставк\p{L}*|відправк\p{L}*|shipping|delivery|нова пошта|укрпошта)(?!\p{L})`;
export const SHIP_PATH_SRC = String.raw`/shipping|/delivery|/dostavka`;
/** v1 (S1a, 7c5cae8): вузький словник; лишається лише для контрольного прогону `engine:'v1'` (доказ, що метаморфний набір вміє впасти). */
export const CTA_SRC_V1 = String.raw`^(купити|придбати|замовити|оформити( замовлення)?|(додати )?(в|у|до)\s+кошик[аи]?|buy( now)?|add to (cart|bag|basket)|order( now)?)(?!\p{L})`;
/** v2 (DEV-32): зовнішня таксономія дієслів CTA e-commerce EN/UK/PL(+RU) — лише підсилення +0,5, ніколи не достатня умова. */
export const CTA_SRC = String.raw`^(купити|придбати|замовити|оформити( замовлення)?|(додати\s+)?(в|у|до)\s+(кошик|кошика|кошику|корзину)|додати\s+до\s+замовлення|купить|заказать|(добавить\s+)?в\s+корзину|оформить\s+заказ|buy(\s+(it|now))?|purchase|add(\s+item)?\s+to\s+(cart|bag|basket|trolley|order)|order(\s+now)?|place\s+(an\s+)?order|(proceed\s+to\s+)?checkout|get\s+it\s+now|kup(\s+teraz)?|dodaj\s+do\s+(koszyka|zamówienia)|do\s+koszyka|zamów(\s+teraz)?|złóż\s+zamówienie|zamawiam)(?!\p{L})`;
const SP = "\\u00a0\\u202f\\u2009 ";
export const PRICE_SRC =
  String.raw`(?<![\p{L}\d])(?:[$€£₴]\s?(?:\d{1,3}(?:[${SP}.,]\d{3})+|\d+)(?:[.,]\d{1,2})?|(?:\d{1,3}(?:[${SP}.,]\d{3})+|\d+)(?:[.,]\d{1,2})?[${SP}]?(?:грн\.?|₴|uah|usd|eur|gbp|pln|zł|\$|€|£))(?!\p{L})`;
export const PRICE_EXCL_SRC = String.raw`(?<!\p{L})(від|from|економія|знижка|save)(?!\p{L})`;

export const SHIP_RE = new RegExp(SHIP_SRC, "iu");
export const SHIP_PATH_RE = new RegExp(SHIP_PATH_SRC, "i");
export const CTA_RE = new RegExp(CTA_SRC, "iu");
export const CTA_RE_V1 = new RegExp(CTA_SRC_V1, "iu");
export const PRICE_RE = new RegExp(PRICE_SRC, "iu");

export const PATTERN_SOURCES = { SHIP_SRC, CTA_SRC, PRICE_SRC, PRICE_EXCL_SRC };

// ---- лексикон/URL-підказки класифікатора типу (page-type-spec.md §2): лише підсилення ≤ 0,5, самі не достатні.
/** C5: підсумок кошика */
export const TOTAL_RE = /(?<!\p{L})(разом|підсумок|всього\s+до\s+сплати|загалом|итого|total|subtotal|razem|do\s+zapłaty)(?!\p{L})/iu;
/** A1: about у h1/URL */
export const ABOUT_LEX_RE = /(?<!\p{L})(про\s+нас|про\s+компанію|про\s+магазин|о\s+нас|about(\s+us)?|our\s+story|who\s+we\s+are|o\s+nas|über\s+uns)(?!\p{L})|(^|\/)(about|about-us|pro-nas|o-nas|ueber-uns)(\/|\.|$)/iu;
/** бот-стіна/капча (лише разом із малим текстом) */
export const BOT_RE = /(verify you are human|are you a robot|captcha|just a moment|checking your browser|access denied|attention required|перевірка браузера|підтвердіть, що ви не робот)/i;

const decodePath = (p: string): string => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};
const parseUrl = (u: string): URL | null => {
  try {
    return new URL(u, "http://x.invalid");
  } catch {
    return null;
  }
};
/** P7: URL-підказка товару в БУДЬ-ЯКІЙ формі; регістр і кінцевий слеш ігноруються. */
export function urlProductHint(u: string): boolean {
  const x = parseUrl(u);
  if (!x) return false;
  const p = decodePath(x.pathname).toLowerCase().replace(/\/+$/, "");
  if (/(^|\/)(product|products|p|item|goods|dp|produkt|tovar\w*)(\/|$)/.test(p)) return true;
  if (/[-_/]\d{3,}(\.html?)?$/.test(p)) return true;
  const q = x.search.toLowerCase();
  return /[?&](product_)?id=|[?&]p=|route=product(%2f|\/)product/.test(q);
}
/** URL-підказка лістингу (+0,5) */
export function urlCategoryHint(u: string): boolean {
  const x = parseUrl(u);
  if (!x) return false;
  const p = decodePath(x.pathname).toLowerCase().replace(/\/+$/, "");
  if (/(^|\/)(catalog|catalogue|category|categories|shop|store|collections?|katalog\w*|kategor\w*|tovary|produkty|products?|listing|c)(\/|\.|$)/.test(p)) return true;
  return /[?&](c|cat|category|path)=|route=product(%2f|\/)category/.test(x.search.toLowerCase());
}
/** C4: кошик/оформлення (сегмент шляху) */
export function urlCartHint(u: string): boolean {
  const x = parseUrl(u);
  if (!x) return false;
  const p = decodePath(x.pathname).toLowerCase();
  return /(^|[/_.-])(cart|checkout|basket|bag|kosh\w*|koszyk\w*|korzin\w*|warenkorb|panier|orders?)($|[/_.-])/.test(p);
}
/** акаунт/логін (клас cart 0,10 для посилань crawl) */
export function urlAccountHint(u: string): boolean {
  const x = parseUrl(u);
  if (!x) return false;
  return /(^|[/_.-])(login|signin|sign-in|register|signup|account|my-account|profile|cabinet|kabinet|wishlist|compare)($|[/_.-])/.test(decodePath(x.pathname).toLowerCase());
}

/** product-шлях: рівно один сегмент після кореня (DEV-26: підшляхи не product) */
export const PRODUCT_PATH_RE = /^\/(product|products|p|item|tovar)\/[^/]+\/?$/i;

export const SIZE_THRESHOLD_BYTES = 512_000;
export const CTA_VIS_THRESHOLD = 0.5;
export const OVERFLOW_MIN_PX = 2;
