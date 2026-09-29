/**
 * Обмежений crawl (SPEC §13, G0-11, DEV-18): ≤ 12 сторінок, глибина ≤ 3, пріоритети §13, ≤ 3 «різних» продукти,
 * лише same-origin http(s), deny-list URL дій (net/url-guard.ts, sl-security) не відкривається ніколи — пропуск
 * фіксується в `skipped`. Крок = захоплення (D+M); між навігаціями throttle (≥ 1500 мс на живих, 0 для фікстури).
 */
import { isDeniedActionUrl } from "../net/url-guard.js";
import { PRODUCT_PATH_RE } from "./patterns.js";
import type { PageCapture, LinkRow } from "./types.js";

export const CRAWL_LIMITS = { maxPages: 12, maxDepth: 3, maxProducts: 3 } as const;

export type LinkClass = "homepage" | "shop_category" | "product" | "pricing" | "services" | "shipping" | "faq" | "about" | "contact" | "blog" | "legal" | "other";
export const PRIORITY: Record<LinkClass, number> = { homepage: 1.0, shop_category: 0.95, product: 0.95, pricing: 0.95, services: 0.9, shipping: 0.8, faq: 0.75, about: 0.6, contact: 0.55, blog: 0.2, legal: 0.1, other: 0.3 };

export function classifyLink(url: string, text: string): LinkClass {
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
  log: Array<{ url: string; depth: number; class: LinkClass; priority: number; order: number }>;
  skipped: Array<{ url: string; reason: string; rule?: string; from: string }>;
}

export async function crawl(opts: {
  seedUrl: string;
  capture: (url: string) => Promise<PageCapture>;
  limits?: { maxPages: number; maxDepth: number; maxProducts: number };
}): Promise<CrawlResult> {
  const lim = opts.limits ?? CRAWL_LIMITS;
  const seed = normalizeCrawlUrl(opts.seedUrl)!;
  const origin = new URL(seed).origin;
  const result: CrawlResult = { pages: [], edges: [], log: [], skipped: [] };
  interface Item { url: string; depth: number; cls: LinkClass; priority: number; seq: number }
  const frontier: Item[] = [{ url: seed, depth: 0, cls: "homepage", priority: 1, seq: 0 }];
  const seen = new Set<string>([seed]);
  let seq = 1;
  let productsQueued = 0;

  while (frontier.length > 0 && result.pages.length < lim.maxPages) {
    frontier.sort((a, b) => b.priority - a.priority || a.depth - b.depth || a.seq - b.seq);
    const item = frontier.shift()!;
    const page = await opts.capture(item.url);
    result.log.push({ url: item.url, depth: item.depth, class: item.cls, priority: item.priority, order: result.pages.length });
    result.pages.push(page);
    if (item.depth >= lim.maxDepth) continue;

    // посилання з обох viewport (мобільна навігація може відрізнятися), у детермінованому порядку
    const links: LinkRow[] = [...page.D.links, ...page.M.links].filter((l) => l.visible);
    const productCands: Array<{ url: string; name: string }> = [];
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
      const cls = classifyLink(url, l.name || l.text);
      if (cls === "product") {
        if (!productCands.some((c) => c.url === url)) productCands.push({ url, name: l.name || l.text });
        continue;
      }
      seen.add(url);
      frontier.push({ url, depth: item.depth + 1, cls, priority: PRIORITY[cls], seq: seq++ });
    }
    const picked = pickDiverseProducts(productCands, Math.max(0, lim.maxProducts - productsQueued));
    for (const c of productCands) {
      if (seen.has(c.url)) continue;
      if (picked.includes(c)) {
        seen.add(c.url);
        productsQueued++;
        frontier.push({ url: c.url, depth: item.depth + 1, cls: "product", priority: PRIORITY.product, seq: seq++ });
      } else {
        seen.add(c.url);
        result.skipped.push({ url: c.url, reason: "product_cap", from: page.url });
      }
    }
  }
  return result;
}
