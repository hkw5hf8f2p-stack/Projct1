/**
 * Обмежений crawl (SPEC §13, G0-11, DEV-18): ≤ 12 сторінок, глибина ≤ 3, пріоритети §13, ≤ 3 «різних» продукти,
 * лише same-origin http(s), deny-list URL дій (net/url-guard.ts, sl-security) не відкривається ніколи — пропуск
 * фіксується в `skipped`. Крок = захоплення (D+M); між навігаціями throttle (≥ 1500 мс на живих, 0 для фікстури).
 */
import { isDeniedActionUrl } from "../net/url-guard.js";
import { classifyLinkV1 } from "./legacy-page-type.js";
import { urlAccountHint, urlCartHint, urlCategoryHint, urlProductHint } from "./patterns.js";
import type { Landmark, PageCapture, LinkRow } from "./types.js";

export const CRAWL_LIMITS = { maxPages: 12, maxDepth: 3, maxProducts: 3 } as const;

export type LinkClass = "homepage" | "shop_category" | "product" | "pricing" | "services" | "shipping" | "faq" | "about" | "contact" | "blog" | "legal" | "cart" | "other";
export const PRIORITY: Record<LinkClass, number> = { homepage: 1.0, shop_category: 0.95, product: 0.95, pricing: 0.95, services: 0.9, shipping: 0.8, faq: 0.75, about: 0.6, contact: 0.55, blog: 0.2, legal: 0.1, cart: 0.1, other: 0.3 };

/** Контекст посилання на сторінці-джерелі (spec §6): клас береться з контексту, URL — лише розв'язання нічиїх. */
export interface LinkContext {
  url: string;
  text: string;
  landmark: Landmark;
  /** основне посилання картки з групи K1 */
  card_primary?: boolean;
  /** іконка з лічильником (кошик) */
  has_counter?: boolean;
  /** найпомітніше посилання/кнопка в main головної */
  prominent_home?: boolean;
}
export interface LinkClassification { cls: LinkClass; priority: number; basis: string }

const INFO_RULES: Array<[LinkClass, RegExp]> = [
  ["shipping", /shipping|delivery|dostavka|dostawa|wysy[łl]ka|доставк|відправк/i],
  ["faq", /(^|\/)(faq|help|support|questions|pomoc)(\/|$)|^(допомога|faq|питання|pytania|pomoc)/i],
  ["about", /(^|\/)(about|about-us|pro-nas|o-nas)(\/|$)|^(про нас|про-нас|about|o nas)/i],
  ["contact", /(^|\/)(contacts?|kontakty|kontakt)(\/|$)|^(контакти|contact|kontakt)/i],
  ["blog", /(^|\/)(blog|news|articles?|aktualnosci)(\/|$)|^(блог|новини|blog|aktualności)$/i],
  ["legal", /privacy|terms|policy|cookies?|legal|umovy|regulamin|polityka|політик|умови/i],
  ["pricing", /(^|\/)(pricing|prices?|plans?|tarif\w*)(\/|$)|^(ціни|тарифи|pricing|prices)$/i],
  ["services", /(^|\/)(services?|solutions?|poslugi)(\/|$)|^(послуги|services)$/i],
];

export function classifyLink(ctx: LinkContext): LinkClassification {
  let p = "/";
  let hasQuery = false;
  try {
    const u = new URL(ctx.url);
    p = u.pathname.toLowerCase();
    hasQuery = u.search !== "";
  } catch {
    /* ignore */
  }
  const t = ctx.text.toLowerCase();
  const mk = (cls: LinkClass, basis: string, priority = PRIORITY[cls]): LinkClassification => ({ cls, priority, basis });
  if ((p === "/" || p === "") && !hasQuery) return mk("homepage", "root");
  if (urlCartHint(ctx.url) || urlAccountHint(ctx.url) || ctx.has_counter) return mk("cart", "cart_account_url_or_counter");
  if (ctx.card_primary) return mk("product", "card_group");
  for (const [cls, re] of INFO_RULES) if (re.test(p) || re.test(t)) return mk(cls, "info_lexicon");
  if (ctx.prominent_home) return mk("shop_category", "prominent_main_home");
  if (ctx.landmark === "nav" || ctx.landmark === "header") return mk("shop_category", "nav_item", 0.9);
  return mk("other", "default", PRIORITY.other + (urlProductHint(ctx.url) || urlCategoryHint(ctx.url) ? 0.05 : 0));
}

/** нормалізація для дедуплікації: без hash, без кінцевого слеша (окрім кореня) */
export function normalizeCrawlUrl(u: string, base?: string): string | null {
  try {
    const x = new URL(u, base);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    x.hash = "";
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
    return x.href;
  } catch {
    return null;
  }
}

const BINARY_EXT = /\.(pdf|zip|rar|7z|gz|tar|exe|dmg|apk|msi|iso|docx?|xlsx?|pptx?|csv|mp3|mp4|mov|avi|jpg|jpeg|png|gif|webp|svg)$/i;

const lev = (a: string, b: string): number => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
};
const dist = (a: string, b: string) => (a.length || b.length ? lev(a, b) / Math.max(a.length, b.length) : 0);

/** Вибір ≤ n «різних» продуктів (farthest-first за назвою): різні за позиціонуванням, а не перші n у DOM. */
export function pickDiverseProducts(cands: Array<{ url: string; name: string }>, n: number): Array<{ url: string; name: string }> {
  if (cands.length <= n) return cands;
  const chosen = [cands[0]!];
  while (chosen.length < n) {
    let best: { url: string; name: string } | null = null;
    let bestD = -1;
    for (const c of cands) {
      if (chosen.includes(c)) continue;
      const d = Math.min(...chosen.map((x) => dist(x.name.toLowerCase(), c.name.toLowerCase())));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

export interface CrawlEdge { from: string; to: string }
export interface CrawlResult {
  pages: PageCapture[];
  edges: CrawlEdge[];
  log: Array<{ url: string; depth: number; class: LinkClass; priority: number; order: number; page_type: string }>;
  skipped: Array<{ url: string; reason: string; rule?: string; from: string }>;
}

export async function crawl(opts: {
  seedUrl: string;
  capture: (url: string) => Promise<PageCapture>;
  limits?: { maxPages: number; maxDepth: number; maxProducts: number };
  /** 'v1' — старий URL-класифікатор посилань (лише контроль метаморфного набору) */
  engine?: "v1" | "v2";
}): Promise<CrawlResult> {
  const lim = opts.limits ?? CRAWL_LIMITS;
  const v1 = opts.engine === "v1";
  const seed = normalizeCrawlUrl(opts.seedUrl)!;
  const origin = new URL(seed).origin;
  const result: CrawlResult = { pages: [], edges: [], log: [], skipped: [] };
  interface Item { url: string; depth: number; cls: LinkClass; priority: number; seq: number; from: string }
  const frontier: Item[] = [{ url: seed, depth: 0, cls: "homepage", priority: 1, seq: 0, from: "" }];
  const seen = new Set<string>([seed]);
  let seq = 1;
  let productsQueued = 0;
  let productsCaptured = 0;

  while (frontier.length > 0 && result.pages.length < lim.maxPages) {
    frontier.sort((a, b) => b.priority - a.priority || a.depth - b.depth || a.seq - b.seq);
    const item = frontier.shift()!;
    // v2: кап «≤ N продуктів» рахує ЗАХОПЛЕНІ сторінки типу product; прогноз, що виявився category, кап не витрачає
    if (!v1 && item.cls === "product" && productsCaptured >= lim.maxProducts) {
      result.skipped.push({ url: item.url, reason: "product_cap", from: item.from });
      continue;
    }
    const page = await opts.capture(item.url);
    result.log.push({ url: item.url, depth: item.depth, class: item.cls, priority: item.priority, order: result.pages.length, page_type: page.page_type });
    result.pages.push(page);
    if (page.page_type === "product") productsCaptured++;
    if (item.depth >= lim.maxDepth) continue;

    // посилання з обох viewport (мобільна навігація може відрізнятися), у детермінованому порядку
    const links: LinkRow[] = [...page.D.links, ...page.M.links].filter((l) => l.visible);
    // найпомітніше посилання в main головної (за площею; нічия — порядок DOM)
    let prominentUrl: string | null = null;
    if (!v1 && page.classification?.is_home) {
      let bestArea = -1;
      for (const l of links) {
        if (l.landmark !== "main" || l.in_card) continue;
        const a = l.rect.w * l.rect.h;
        if (a > bestArea) {
          bestArea = a;
          prominentUrl = normalizeCrawlUrl(l.abs, page.url);
        }
      }
    }
    const best = new Map<string, { cls: LinkClass; priority: number; name: string }>();
    for (const l of links) {
      const url = normalizeCrawlUrl(l.abs, page.url);
      if (!url) continue;
      if (new URL(url).origin !== origin) {
        if (!seen.has("ext:" + url)) {
          seen.add("ext:" + url);
          result.skipped.push({ url, reason: "external", from: page.url });
        }
        continue;
      }
      const deny = isDeniedActionUrl(url);
      if (deny.denied) {
        if (!seen.has("deny:" + url)) {
          seen.add("deny:" + url);
          result.skipped.push({ url, reason: "deny_list", rule: deny.rule ?? undefined, from: page.url });
        }
        continue;
      }
      if (BINARY_EXT.test(new URL(url).pathname)) {
        result.skipped.push({ url, reason: "binary_extension", from: page.url });
        continue;
      }
      result.edges.push({ from: page.url, to: url });
      if (seen.has(url)) continue;
      const name = l.name || l.text;
      const c: { cls: LinkClass; priority: number } = v1
        ? (() => {
            const cls = classifyLinkV1(url, name);
            return { cls, priority: PRIORITY[cls] };
          })()
        : classifyLink({ url, text: name, landmark: l.landmark, card_primary: l.card_primary, has_counter: l.has_counter, prominent_home: prominentUrl !== null && url === prominentUrl });
      const prev = best.get(url);
      if (!prev || c.priority > prev.priority) best.set(url, { ...c, name });
    }
    const productCands: Array<{ url: string; name: string }> = [];
    for (const [url, c] of best) {
      if (c.cls === "product") {
        productCands.push({ url, name: c.name });
        continue;
      }
      seen.add(url);
      frontier.push({ url, depth: item.depth + 1, cls: c.cls, priority: c.priority, seq: seq++, from: page.url });
    }
    const room = v1 ? Math.max(0, lim.maxProducts - productsQueued) : lim.maxProducts;
    const picked = pickDiverseProducts(productCands, room);
    for (const c of productCands) {
      seen.add(c.url);
      if (picked.includes(c)) {
        productsQueued++;
        frontier.push({ url: c.url, depth: item.depth + 1, cls: "product", priority: PRIORITY.product, seq: seq++, from: page.url });
      } else {
        result.skipped.push({ url: c.url, reason: "product_cap", from: page.url });
      }
    }
  }
  return result;
}
