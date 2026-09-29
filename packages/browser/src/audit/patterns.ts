/**
 * Заморожені предикати детекторів (planning/eval/fixture-defect-map.md §3). Межі слів — лише `(?<!\p{L})…(?!\p{L})`
 * (G0-26), `\b` заборонено. Джерела (рядки) передаються і в сторінку (extract.js), і в Node.
 */
export const SHIP_SRC = String.raw`(?<!\p{L})(доставк\p{L}*|відправк\p{L}*|shipping|delivery|нова пошта|укрпошта)(?!\p{L})`;
export const SHIP_PATH_SRC = String.raw`/shipping|/delivery|/dostavka`;
export const CTA_SRC = String.raw`^(купити|придбати|замовити|оформити( замовлення)?|(додати )?(в|у|до)\s+кошик[аи]?|buy( now)?|add to (cart|bag|basket)|order( now)?)(?!\p{L})`;
const SP = "\\u00a0\\u202f\\u2009 ";
export const PRICE_SRC =
  String.raw`(?<![\p{L}\d])(?:[$€£₴]\s?(?:\d{1,3}(?:[${SP}.,]\d{3})+|\d+)(?:[.,]\d{1,2})?|(?:\d{1,3}(?:[${SP}.,]\d{3})+|\d+)(?:[.,]\d{1,2})?[${SP}]?(?:грн\.?|₴|uah|usd|eur|zł|\$|€))(?!\p{L})`;
export const PRICE_EXCL_SRC = String.raw`(?<!\p{L})(від|from|економія|знижка|save)(?!\p{L})`;

export const SHIP_RE = new RegExp(SHIP_SRC, "iu");
export const SHIP_PATH_RE = new RegExp(SHIP_PATH_SRC, "i");
export const CTA_RE = new RegExp(CTA_SRC, "iu");
export const PRICE_RE = new RegExp(PRICE_SRC, "iu");

export const PATTERN_SOURCES = { SHIP_SRC, CTA_SRC, PRICE_SRC, PRICE_EXCL_SRC };

/** product-шлях: рівно один сегмент після кореня (DEV-26: підшляхи не product) */
export const PRODUCT_PATH_RE = /^\/(product|products|p|item|tovar)\/[^/]+\/?$/i;

export const SIZE_THRESHOLD_BYTES = 512_000;
export const CTA_VIS_THRESHOLD = 0.5;
export const OVERFLOW_MIN_PX = 2;
