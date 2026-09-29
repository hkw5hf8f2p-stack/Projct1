/**
 * v1 (S1a, 7c5cae8, тег s1a-detectors-frozen): класифікатор типу сторінки й посилань за URL/словником CTA. Збережено ЛИШЕ як контроль
 * метаморфного набору (`engine: 'v1'`): набір мусить уміти падати на старому коді. У продакшн-шляху не використовується.
 */
import { CTA_RE_V1, PRODUCT_PATH_RE } from "./patterns.js";
import type { LinkClass } from "./crawl.js";
import type { ViewportCapture } from "./types.js";

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

export type PageTypeV1 = "product" | "category" | "unknown";

export function classifyPageTypeV1(c: ViewportCapture): PageTypeV1 {
  let p = "/";
  try {
    p = new URL(c.final_url).pathname;
  } catch {
    /* лишаємо / */
  }
  if (c.jsonld_types.some((t) => /^product$/i.test(t))) return "product";
  if (PRODUCT_PATH_RE.test(p)) return "product";
  if (productLinkTargetsV1(c).size >= 3) return "category";
  if (c.h1_count === 1 && c.interactive.some((i) => CTA_RE_V1.test(i.name.trim()))) return "product";
  return "unknown";
}

export function productLinkTargetsV1(c: ViewportCapture): Set<string> {
  const out = new Set<string>();
  for (const l of c.links) {
    if (!l.visible || !sameOrigin(l.abs, c.final_url)) continue;
    try {
      const u = new URL(l.abs);
      if (PRODUCT_PATH_RE.test(u.pathname)) out.add(u.origin + u.pathname.replace(/\/$/, ""));
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function classifyLinkV1(url: string, text: string): LinkClass {
  let p = "/";
  try {
    p = new URL(url).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  const t = text.toLowerCase();
  if (p === "/" || p === "") return "homepage";
  if (PRODUCT_PATH_RE.test(p)) return "product";
  const rules: Array<[LinkClass, RegExp]> = [
    ["shop_category", /(^|\/)(catalog|catalogue|shop|store|category|categories|collections?)(\/|$)|^(каталог|магазин|catalog|shop)$/i],
    ["pricing", /(^|\/)(pricing|prices?|plans?|tarif\w*)(\/|$)|^(ціни|тарифи|pricing|prices)$/i],
    ["services", /(^|\/)(services?|solutions?|poslugi)(\/|$)|^(послуги|services)$/i],
    ["shipping", /shipping|delivery|dostavka|доставк/i],
    ["faq", /(^|\/)(faq|help|support|questions)(\/|$)|^(допомога|faq|питання)/i],
    ["about", /(^|\/)(about|about-us|pro-nas)(\/|$)|^(про нас|про-нас|about)/i],
    ["contact", /(^|\/)(contacts?|kontakty)(\/|$)|^(контакти|contact)/i],
    ["blog", /(^|\/)(blog|news|articles?)(\/|$)|^(блог|новини|blog)$/i],
    ["legal", /privacy|terms|policy|cookies?|legal|umovy|політик|умови/i],
  ];
  for (const [cls, re] of rules) if (re.test(p) || re.test(t)) return cls;
  return "other";
}
