/**
 * Класифікатор типу сторінки за СТРУКТУРНИМИ ознаками (planning/eval/page-type-spec.md, DEV-32). Чиста функція над полями
 * захоплення (spec §7): без браузера, без часу, без назв/шляхів/слів конкретних фікстур чи двійників. URL і словник —
 * лише підсилення ≤ 0,5 і ніколи не достатні самі. Пороги — зі специфікації, закоміченої до коду (b271c1e).
 */
import { ABOUT_LEX_RE, BOT_RE, CTA_RE, SHIP_RE, TOTAL_RE, urlCartHint, urlCategoryHint, urlProductHint } from "./patterns.js";
import type { CardGroup, InteractiveRow, PageType, PriceRow, Rect, UnknownReason, ViewportCapture } from "./types.js";

export type View = Pick<
  ViewportCapture,
  | "final_url" | "width" | "height" | "title" | "headings" | "links" | "images" | "interactive" | "text_nodes" | "visible_text"
  | "jsonld_types" | "jsonld_top" | "og_type" | "canonical" | "microdata_types" | "h1_count" | "h1_rect" | "main_rect" | "card_groups"
  | "prices" | "autocomplete_tokens" | "details_count" | "question_headings" | "ship_paragraphs" | "listing_controls" | "cart_rows"
> & { completeness: Pick<ViewportCapture["completeness"], "http_status" | "navigation_completed" | "visible_text_length"> };

export interface ViewResult {
  type: PageType;
  reason: UnknownReason | null;
  /** правило пріоритетів §4, що спрацювало */
  rule: string;
  P: number;
  K: number;
  C: number;
  features: string[];
  /** первинна дія (P3), що пройшла перевірку ролі; null — немає або роль не та */
  primary: { selector: string; name: string; rect: Rect } | null;
}

export interface PageClassification {
  page_type: PageType;
  reason: UnknownReason | null;
  is_home: boolean;
  scores: { P: number; K: number; C: number };
  features: string[];
  rule: string;
  primary_action: { selector: string; name: string; rect: Rect } | null;
  per_view: { D: ViewResult; M: ViewResult };
}

// ------------------------------------------------------------------------------------------------ допоміжне
const path = (u: string): string => {
  try {
    return new URL(u).pathname;
  } catch {
    return "/";
  }
};
const normUrl = (u: string): string => {
  try {
    const x = new URL(u);
    x.hash = "";
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
    return x.href;
  } catch {
    return u;
  }
};
const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};
const area = (r: Rect): number => r.w * r.h;
const h1Text = (v: View): string => v.headings.filter((h) => h.level === 1).map((h) => h.text).join(" ");

export function isHomePage(v: View, seedUrl?: string): boolean {
  const p = path(v.final_url);
  if (p === "/" || p === "") return true;
  if (seedUrl && normUrl(seedUrl) === normUrl(v.final_url)) return true;
  if (v.canonical && sameOrigin(v.canonical, v.final_url) && path(v.canonical) === "/") return true;
  return false;
}

/** п.0: захоплення недостатнє (map §4 п.3): не 2xx, навігація не завершена, бот-стіна / порожня сторінка без навігації */
export function captureInsufficient(v: View): string | null {
  const c = v.completeness;
  if (!(c.http_status !== null && c.http_status >= 200 && c.http_status < 300)) return `http_status:${c.http_status}`;
  if (!c.navigation_completed) return "navigation_incomplete";
  const navLinks = v.links.filter((l) => l.visible && sameOrigin(l.abs, v.final_url)).length;
  // DEV-34: спец. «visible_text_length < 200» читається як ознака бот-стіни лише разом зі слабкою структурою (< 3 внутрішніх посилань),
  // інакше короткі, але цілком справжні інфо-сторінки (доставка, про нас) стали б unknown(capture)
  if (c.visible_text_length < 200 && navLinks < 3) return "thin_text_no_navigation";
  if (c.visible_text_length < 1000 && BOT_RE.test(`${v.title} ${v.visible_text.slice(0, 600)}`)) return "bot_wall";
  return null;
}

// ------------------------------------------------------------------------------------------------ ознаки товару
const isStructured = (v: View): string | null => {
  if (v.jsonld_top.some((t) => /^(Product|ProductGroup)$/i.test(t))) return "jsonld";
  if (v.microdata_types.some((m) => /^Product$/i.test(m.type) && !m.in_card)) return "microdata";
  if (v.og_type && /^(product|product\.item|og:product)$/.test(v.og_type)) return "og";
  return null;
};

const isActionKind = (i: InteractiveRow): boolean =>
  i.tag === "button" || (i.tag === "input" && ["submit", "button", "image"].includes(i.input_type ?? "")) || i.role === "button" || (i.is_link && (i.bg_opaque || i.border) && i.pad_y >= 6 && i.pad_x >= 6);

/** P3: найпомітніша дія в main поза картками (площа × (фон ? 1 : 0,5)); `valid` — роль дії (без вільного тексту у формі, не навігація) */
export function primaryAction(v: View, navHrefs: Set<string> = new Set()): { row: InteractiveRow; valid: boolean } | null {
  const cands = v.interactive.filter((i) => i.landmark === "main" && !i.in_card && !i.disabled && area(i.rect) >= 1800 && i.rect.h >= 32 && isActionKind(i));
  if (cands.length === 0) return null;
  const prom = (i: InteractiveRow) => area(i.rect) * (i.bg_opaque ? 1 : 0.5);
  cands.sort((a, b) => prom(b) - prom(a) || a.rect.y - b.rect.y || a.selector.localeCompare(b.selector));
  const row = cands[0]!;
  const valid = !(row.form && row.form.free_text) && !(row.is_link && (row.nav_target || (row.href !== null && navHrefs.has(normUrl(row.href)))));
  return { row, valid };
}

/** P2: одна головна ціна поза картками, у межах 1·vh від h1 (кластер цін ≤ 200 px — одна ціна) */
export function mainPrice(v: View): PriceRow | null {
  const ps = v.prices.filter((p) => p.landmark === "main" && !p.in_card).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (ps.length === 0) return null;
  const clusters: PriceRow[][] = [];
  for (const p of ps) {
    const last = clusters[clusters.length - 1];
    if (last && p.rect.y - last[last.length - 1]!.rect.y <= 200) last.push(p);
    else clusters.push([p]);
  }
  const score = (p: PriceRow) => p.font_size * area(p.rect);
  const ranked = clusters.map((c) => ({ best: [...c].sort((a, b) => score(b) - score(a))[0]!, s: Math.max(...c.map(score)) })).sort((a, b) => b.s - a.s);
  const top = ranked[0]!;
  const unique = ranked.length === 1 || top.s >= 1.5 * ranked[1]!.s;
  const near = v.h1_rect ? Math.abs(top.best.rect.y - v.h1_rect.y) <= v.height : top.best.rect.y <= 2 * v.height;
  return unique && near ? top.best : null;
}

const nearH1 = (v: View, y: number): boolean => (v.h1_rect ? Math.abs(y - v.h1_rect.y) <= v.height : y <= v.height);

// ------------------------------------------------------------------------------------------------ кошик/оформлення
const CART_SET = new Set(["email", "tel", "name", "street-address", "address-line1", "postal-code", "cc-number"]);
export function cartScore(v: View): { C: number; checkout: boolean; features: string[] } {
  const f: string[] = [];
  let C = 0;
  const rows = v.cart_rows.filter((r) => r.price !== null);
  const c1 = v.cart_rows.some((r) => r.price !== null && r.has_qty) || v.cart_rows.filter((r) => r.price !== null && r.has_remove).length >= 2;
  if (c1) {
    C += 2;
    f.push("C1");
  }
  if (rows.length >= 1) {
    const sum = rows.reduce((a, r) => a + (r.price ?? 0), 0);
    const lastBottom = Math.max(...rows.map((r) => r.rect.y + r.rect.h));
    const inRow = (p: PriceRow) => rows.some((r) => p.rect.y >= r.rect.y - 1 && p.rect.y + p.rect.h <= r.rect.y + r.rect.h + 1);
    const totals = v.prices.filter((p) => !inRow(p) && !p.in_card);
    const c2 = totals.some((p) => (sum > 0 && Math.abs(p.value - sum) <= 0.01 * sum) || (p.font_weight >= 600 && p.rect.y >= lastBottom - 1));
    if (c2) {
      C += 1;
      f.push("C2");
    }
  }
  const tokens = new Set(v.autocomplete_tokens.filter((t) => CART_SET.has(t) || t.startsWith("shipping")));
  const c3 = tokens.size >= 2;
  if (c3) {
    C += 2;
    f.push("C3");
  }
  if (urlCartHint(v.final_url)) {
    C += 0.5;
    f.push("C4");
  }
  if (v.text_nodes.some((n) => n.t.length <= 60 && TOTAL_RE.test(n.t))) {
    C += 0.5;
    f.push("C5");
  }
  return { C, checkout: c3, features: f };
}

// ------------------------------------------------------------------------------------------------ категорія
const topGroup = (v: View): CardGroup | null => [...v.card_groups].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count || a.rect.y - b.rect.y)[0] ?? null;

export function categoryScore(v: View): { K: number; k1: boolean; features: string[] } {
  const g = topGroup(v);
  if (!g) return { K: 0, k1: false, features: [] };
  const f = [`K1:${g.count}`];
  let K = 3;
  if (g.count >= 3 || g.with_price > 0) {
    K += 1;
    f.push("K+1");
  }
  if (v.jsonld_types.some((t) => /^(ItemList|CollectionPage)$/i.test(t))) {
    K += 1;
    f.push("Klist");
  }
  if (v.listing_controls) {
    K += 0.5;
    f.push("Kpage");
  }
  if (urlCategoryHint(v.final_url)) {
    K += 0.5;
    f.push("Kurl");
  }
  return { K, k1: true, features: f };
}

// ------------------------------------------------------------------------------------------------ один viewport
export function classifyView(v: View, isHome: boolean, navHrefs: Set<string> = new Set()): ViewResult {
  const base = { P: 0, K: 0, C: 0, features: [] as string[], primary: null };
  const cap = captureInsufficient(v);
  if (cap) return { ...base, type: "unknown", reason: "capture", rule: `0:capture(${cap})` };

  // --- product
  const feats: string[] = [];
  let P = 0;
  const p1 = isStructured(v);
  if (p1) {
    P += 3;
    feats.push(`P1:${p1}`);
  }
  const price = mainPrice(v);
  if (price) {
    P += 2;
    feats.push("P2");
  }
  const pa = primaryAction(v, navHrefs);
  const p3 = pa && pa.valid ? pa.row : null;
  if (p3) {
    P += 2;
    feats.push("P3");
    if (CTA_RE.test(p3.name.trim())) {
      P += 0.5;
      feats.push("P3lex");
    }
    if (nearH1(v, p3.rect.y) || (price && Math.abs(p3.rect.y - price.rect.y) <= v.height)) {
      P += 0.5;
      feats.push("P3prox");
    }
  }
  if (v.h1_count === 1) {
    P += 1;
    feats.push("P4");
  }
  const media = v.images.some((i) => !i.is_background && i.landmark === "main" && !i.in_card && (area(i.rect) >= 60000 || (v.main_rect.w > 0 && i.rect.w >= 0.4 * v.main_rect.w)) && nearH1(v, i.rect.y));
  if (media) {
    P += 1;
    feats.push("P5");
  }
  if (p3?.form?.has_variants) {
    P += 0.5;
    feats.push("P6");
  }
  if (urlProductHint(v.final_url)) {
    P += 0.5;
    feats.push("P7");
  }
  const g = topGroup(v);
  if (g && p3 && v.main_rect.h > 0 && g.rect.h >= 0.4 * v.main_rect.h && g.rect.y < p3.rect.y) {
    P -= 3;
    feats.push("Ppen");
  }
  const cat = categoryScore(v);
  const cart = cartScore(v);
  const all = [...feats, ...cat.features, ...cart.features];
  const primary = p3 ? { selector: p3.selector, name: p3.name, rect: p3.rect } : null;
  const mk = (type: PageType, rule: string, reason: UnknownReason | null = null): ViewResult => ({ type, reason, rule, P, K: cat.K, C: cart.C, features: all, primary });

  // 1. вето кошика/оформлення
  if (cart.C >= 2 && (cart.features.includes("C1") || cart.features.includes("C2") || cart.features.includes("C3"))) return mk(cart.checkout ? "checkout" : "cart", "1:cart_veto");
  const prodPass = P >= 4 && (!!p1 || !!p3);
  const catPass = cat.k1 && cat.K >= 3;
  // 3. головна
  if (isHome) return prodPass ? mk("product", "3:home_product") : mk("homepage", "3:home");
  // 2. product і category разом
  if (prodPass && catPass) {
    const h1Above = !!v.h1_rect && !!g && v.h1_rect.y <= g.rect.y;
    return p3 && h1Above ? mk("product", "2:product_over_category") : mk("category", "2:category_over_product");
  }
  if (prodPass) return mk("product", "4:product");
  if (catPass) return mk("category", "5:category");
  if (P >= 2.5 && P < 4 && (!!p1 || !!p3)) return mk("unknown", "6:product_likely", "product_likely");
  // 7. інфо-типи (словник дозволений: вони не гейтять №2/№5/№10)
  if (v.jsonld_types.some((t) => /^FAQPage$/i.test(t)) || v.details_count >= 3 || v.question_headings >= 3) return mk("faq", "7:faq");
  if (SHIP_RE.test(h1Text(v)) || SHIP_RE.test(v.title) || v.ship_paragraphs >= 2) return mk("info_shipping", "7:info_shipping");
  if (v.jsonld_top.some((t) => /^AboutPage$/i.test(t)) || v.jsonld_top[0] === "Organization" || ABOUT_LEX_RE.test(h1Text(v)) || ABOUT_LEX_RE.test(path(v.final_url))) return mk("about", "7:about");
  return mk("other", "8:other");
}

// ------------------------------------------------------------------------------------------------ D + M
export function classifyPageType(D: View, M: View = D, opts: { seed_url?: string } = {}): PageClassification {
  const is_home = isHomePage(D, opts.seed_url);
  // навігаційні цілі — з ОБОХ viewport і незалежно від видимості (на мобільному меню згорнуте: кнопка героя вела б туди ж, куди й пункт nav)
  const navHrefs = new Set<string>();
  for (const v of [D, M]) for (const l of v.links) if (l.landmark === "header" || l.landmark === "nav" || l.landmark === "footer") navHrefs.add(normUrl(l.abs));
  const d = classifyView(D, is_home, navHrefs);
  const m = classifyView(M, is_home, navHrefs);
  let type: PageType = d.type;
  let reason: UnknownReason | null = d.reason;
  let rule = d.rule;
  if (d.reason === "capture" || m.reason === "capture") {
    type = "unknown";
    reason = "capture";
    rule = d.reason === "capture" ? d.rule : m.rule;
  } else if (d.type !== m.type || d.reason !== m.reason) {
    const prodInvolved = d.type === "product" || m.type === "product" || d.reason === "product_likely" || m.reason === "product_likely";
    const sameKind = d.type === m.type && d.reason === m.reason;
    if (!sameKind && prodInvolved) {
      // розбіжність D/M з участю product: невизначеність; max(P) ≥ 2,5 → product_likely, інакше other
      if (Math.max(d.P, m.P) >= 2.5) {
        type = "unknown";
        reason = "product_likely";
        rule = `dm_mismatch(${d.type}/${m.type})`;
      } else {
        type = "other";
        reason = null;
        rule = `dm_mismatch_low(${d.type}/${m.type})`;
      }
    }
  }
  return {
    page_type: type,
    reason,
    is_home,
    scores: { P: d.P, K: d.K, C: d.C },
    features: d.features,
    rule,
    primary_action: d.primary,
    per_view: { D: d, M: m },
  };
}
