/**
 * Метаморфні трансформації фікстур (planning/eval/page-type-tests.md §1): `FIXTURE_TRANSFORM=<id>[,<id>]` (або опція `transforms`).
 * Трансформація змінює всі внутрішні посилання на product/category/configure узгоджено; deny-list посилання (`?action=delete`,
 * `?add-to-cart=`, `/logout`) зберігають тригери; `data-fx` не змінюються. Спільно для shop і shop-clean.
 */
import { esc } from "./layout.js";

export const TRANSFORM_IDS = [
  "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9",
  "V1", "V2", "V3",
  "E1", "E2", "E3",
  "K1", "K2",
  "J1", "J2", "J3",
  "R1", "R2", "R3",
  "T1",
] as const;
export type TransformId = (typeof TRANSFORM_IDS)[number];

export interface Transforms {
  ids: TransformId[];
  /** схема URL (U1–U9); null — базова `/product/<slug>`, `/catalog` */
  u: TransformId | null;
  cta: "V1" | "V2" | null;
  en: boolean;
  ctaEl: "E1" | "E2" | "E3" | null;
  k1: boolean;
  k2: boolean;
  j1: boolean;
  j2: boolean;
  j3: boolean;
  r1: boolean;
  r2: boolean;
  r3: boolean;
  /** T1: «команда» — 3 картки (фото + посилання на профіль, без цін) на /about (DEV-38) */
  t1: boolean;
}

export function parseTransforms(raw: string | string[] | undefined | null): Transforms {
  const ids = (Array.isArray(raw) ? raw : (raw ?? "").split(","))
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .map((x) => {
      if (!(TRANSFORM_IDS as readonly string[]).includes(x)) throw new Error(`невідома трансформація ${x}`);
      return x as TransformId;
    });
  const has = (id: TransformId) => ids.includes(id);
  const us = ids.filter((i) => /^U\d$/.test(i));
  return {
    ids,
    u: us.length ? us[us.length - 1]! : null,
    cta: has("V2") ? "V2" : has("V1") ? "V1" : null,
    en: has("V3"),
    ctaEl: has("E1") ? "E1" : has("E2") ? "E2" : has("E3") ? "E3" : null,
    k1: has("K1"),
    k2: has("K2"),
    j1: has("J1"),
    j2: has("J2"),
    j3: has("J3"),
    r1: has("R1") || has("R2"),
    r2: has("R2"),
    r3: has("R3"),
    t1: has("T1"),
  };
}

// ------------------------------------------------------------------------------------------------ URL-схеми
export interface ProdRef { slug: string; id: number }
export type Route = { kind: "category" } | { kind: "product"; slug: string } | { kind: "configure"; slug: string };
export interface UrlScheme {
  category(): string;
  product(p: ProdRef): string;
  configure(p: ProdRef): string;
  route(url: URL): Route | null;
}

const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
/** нормалізація шляху запиту: percent-decode, нижній регістр, без кінцевого слеша */
const normPath = (u: URL): string => dec(u.pathname).toLowerCase().replace(/(.)\/+$/, "$1");
const cap = (slug: string): string => slug.replace(/(^|-)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const HEX = ["7f3a", "2c9d", "b81e", "4d05", "e6a7"];

export function makeScheme(u: TransformId | null, prods: ProdRef[]): UrlScheme {
  const byId = (id: number) => prods.find((p) => p.id === id);
  const idx = (p: ProdRef) => prods.findIndex((x) => x.slug === p.slug);
  const slugOk = (s: string | undefined) => (s && prods.some((p) => p.slug === s.toLowerCase()) ? s.toLowerCase() : null);
  const pathRoute = (rx: RegExp, cfgRx: RegExp, cat: RegExp) => (url: URL): Route | null => {
    const p = normPath(url);
    if (cat.test(p)) return { kind: "category" };
    const c = cfgRx.exec(p);
    if (c && slugOk(c[1])) return { kind: "configure", slug: slugOk(c[1])! };
    const m = rx.exec(p);
    if (m && slugOk(m[1])) return { kind: "product", slug: slugOk(m[1])! };
    return null;
  };
  switch (u) {
    case "U1":
      return {
        category: () => "/index.php?c=catalog",
        product: (p) => `/index.php?p=${p.slug}`,
        configure: (p) => `/index.php?p=${p.slug}&v=cfg`,
        route: (url) => {
          if (normPath(url) !== "/index.php") return null;
          const q = url.searchParams;
          if (q.get("c") === "catalog") return { kind: "category" };
          const s = slugOk(q.get("p") ?? undefined);
          return s ? { kind: q.get("v") === "cfg" ? "configure" : "product", slug: s } : null;
        },
      };
    case "U2":
      return {
        category: () => "/index.php?route=product/category&path=20",
        product: (p) => `/index.php?route=product/product&product_id=${p.id}`,
        configure: (p) => `/index.php?route=product/configure&product_id=${p.id}`,
        route: (url) => {
          if (normPath(url) !== "/index.php") return null;
          const q = url.searchParams;
          const r = q.get("route");
          if (r === "product/category" && q.get("path") === "20") return { kind: "category" };
          const pr = byId(Number(q.get("product_id")));
          if (pr && r === "product/product") return { kind: "product", slug: pr.slug };
          if (pr && r === "product/configure") return { kind: "configure", slug: pr.slug };
          return null;
        },
      };
    case "U3":
      return {
        category: () => "/c/7",
        product: (p) => `/p/${1000 + p.id}`,
        configure: (p) => `/p/${1000 + p.id}/cfg`,
        route: (url) => {
          const p = normPath(url);
          if (p === "/c/7") return { kind: "category" };
          const m = /^\/p\/(\d+)(\/cfg)?$/.exec(p);
          const pr = m ? byId(Number(m[1]) - 1000) : undefined;
          return pr ? { kind: m![2] ? "configure" : "product", slug: pr.slug } : null;
        },
      };
    case "U4":
      return {
        category: () => "/dim/filtry/",
        product: (p) => `/dim/filtry/${p.slug}/`,
        configure: (p) => `/dim/filtry/${p.slug}/nalashtuvannia/`,
        route: pathRoute(/^\/dim\/filtry\/([a-z0-9-]+)$/, /^\/dim\/filtry\/([a-z0-9-]+)\/nalashtuvannia$/, /^\/dim\/filtry$/),
      };
    case "U5":
      return {
        category: () => "/katalog.html",
        product: (p) => `/${p.slug}-${1000 + p.id}.html`,
        configure: (p) => `/${p.slug}-${1000 + p.id}-cfg.html`,
        route: (url) => {
          const p = normPath(url);
          if (p === "/katalog.html") return { kind: "category" };
          const c = /^\/([a-z0-9-]+)-(\d{4})-cfg\.html$/.exec(p);
          if (c && byId(Number(c[2]) - 1000)?.slug === c[1]) return { kind: "configure", slug: c[1]! };
          const m = /^\/([a-z0-9-]+)-(\d{4})\.html$/.exec(p);
          if (m && byId(Number(m[2]) - 1000)?.slug === m[1]) return { kind: "product", slug: m[1]! };
          return null;
        },
      };
    case "U6":
      return {
        category: () => "/catalog/",
        product: (p) => `/product/${p.slug}/`,
        configure: (p) => `/product/${p.slug}/configure/`,
        route: pathRoute(/^\/product\/([a-z0-9-]+)$/, /^\/product\/([a-z0-9-]+)\/configure$/, /^\/catalog$/),
      };
    case "U7":
      return {
        category: () => "/CATALOG",
        product: (p) => `/PRODUCT/${cap(p.slug)}`,
        configure: (p) => `/PRODUCT/${cap(p.slug)}/CONFIGURE`,
        route: pathRoute(/^\/product\/([a-z0-9-]+)$/, /^\/product\/([a-z0-9-]+)\/configure$/, /^\/catalog$/),
      };
    case "U8": {
      const seg = (p: ProdRef) => ["/uk/tovary", "/pl/produkty", "/%D1%82%D0%BE%D0%B2%D0%B0%D1%80"][idx(p) % 3]!;
      return {
        category: () => "/uk/katalog",
        product: (p) => `${seg(p)}/${p.slug}`,
        configure: (p) => `${seg(p)}/${p.slug}/nalashtuvannia`,
        route: (url) => {
          const p = normPath(url);
          if (p === "/uk/katalog") return { kind: "category" };
          const m = /^(?:\/uk\/tovary|\/pl\/produkty|\/товар)\/([a-z0-9-]+)(\/nalashtuvannia)?$/.exec(p);
          const s = m ? slugOk(m[1]) : null;
          return s ? { kind: m![2] ? "configure" : "product", slug: s } : null;
        },
      };
    }
    case "U9":
      return {
        category: () => "/y/2b",
        product: (p) => `/x/${HEX[idx(p) % HEX.length]}`,
        configure: (p) => `/x/${HEX[idx(p) % HEX.length]}/z`,
        route: (url) => {
          const p = normPath(url);
          if (p === "/y/2b") return { kind: "category" };
          const m = /^\/x\/([0-9a-f]{4})(\/z)?$/.exec(p);
          const i = m ? HEX.indexOf(m[1]!) : -1;
          const pr = i >= 0 ? prods[i] : undefined;
          return pr ? { kind: m![2] ? "configure" : "product", slug: pr.slug } : null;
        },
      };
    default:
      return {
        category: () => "/catalog",
        product: (p) => `/product/${p.slug}`,
        configure: (p) => `/product/${p.slug}/configure`,
        route: pathRoute(/^\/product\/([a-z0-9-]+)$/, /^\/product\/([a-z0-9-]+)\/configure$/, /^\/catalog$/),
      };
  }
}

/** додає параметр до URL (з урахуванням наявного query) */
export const withQuery = (url: string, key: string, value: string | number): string => `${url}${url.includes("?") ? "&" : "?"}${key}=${value}`;

// ------------------------------------------------------------------------------------------------ CTA
/** Мітка CTA за трансформацією: V1 — синоніми, V2 — поза словником, V3 — англійська; інакше `dflt`. */
export function ctaLabel(t: Transforms, i: number, dflt: string): { text: string; aria?: string } {
  if (t.cta === "V1") return { text: ["Add to basket", "Dodaj do koszyka", "Замовити зараз"][i % 3]! };
  if (t.cta === "V2") return i % 3 === 2 ? { text: "→", aria: "Далі" } : { text: "Далі" };
  if (t.en) return { text: "Add to cart" };
  return { text: dflt };
}

/** Кнопка/посилання «додати в кошик» (E1–E3 змінюють елемент, не текст). */
export function buyControl(t: Transforms, o: { i: number; label: { text: string; aria?: string }; hiddenName: string; hiddenValue: string | number; addHref: string; fx?: string }): string {
  const fx = o.fx ? ` data-fx="${o.fx}"` : "";
  const aria = o.label.aria ? ` aria-label="${esc(o.label.aria)}"` : "";
  const txt = esc(o.label.text);
  const hidden = `<input type="hidden" name="${o.hiddenName}" value="${o.hiddenValue}">`;
  switch (t.ctaEl) {
    case "E1":
      return `<a class="btn buy-btn" href="${esc(o.addHref)}"${fx}${aria}>${txt}</a>`;
    case "E2":
      return `<form method="post" action="/cart" class="buy">${hidden}<input type="submit" class="buy-btn" value="${txt}"${fx}${aria}></form>`;
    case "E3":
      return o.i % 2 === 1
        ? `<div role="button" tabindex="0" class="buy-btn"${fx}${aria}>${txt}</div>`
        : `<a role="button" class="buy-btn" href="${esc(o.addHref)}"${fx}${aria}>${txt}</a>`;
    default:
      return `<form method="post" action="/cart" class="buy">${hidden}<button type="submit" class="buy-btn"${fx}${aria}>${txt}</button></form>`;
  }
}

// ------------------------------------------------------------------------------------------------ структуровані дані
export const jsonLdProduct = (name: string, description: string): string =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name, description })}</script>`;
export const ogProduct = (): string => `<meta property="og:type" content="product">`;
export const jsonLdItemList = (items: Array<{ name: string; url: string }>): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "Product", name: it.name, url: it.url } })),
  })}</script>`;

// ------------------------------------------------------------------------------------------------ кошик / оформлення (R1, R2)
export interface CartText { h1: string; th: string[]; item: string; qtyLabel: string; total: string; checkout: string; email: string; phone: string; address: string; confirm: string; checkoutH1: string }
export const CART_UK: CartText = { h1: "Кошик", th: ["Товар", "Кількість", "Сума"], item: "Фільтр для води", qtyLabel: "Кількість", total: "Разом:", checkout: "Оформити", email: "Електронна пошта", phone: "Телефон", address: "Адреса доставки", confirm: "Підтвердити замовлення", checkoutH1: "Оформлення замовлення" };
export const CART_EN: CartText = { h1: "Cart", th: ["Item", "Quantity", "Amount"], item: "Water filter", qtyLabel: "Quantity", total: "Total:", checkout: "Checkout", email: "Email", phone: "Phone", address: "Delivery address", confirm: "Confirm order", checkoutH1: "Checkout" };
const NB = " ";
export const cartMain = (t: CartText, checkoutHref: string | null, en: boolean): string => {
  const price = en ? `1,200${NB}UAH` : `1${NB}200${NB}грн`;
  const btn = checkoutHref ? `<a class="btn" href="${esc(checkoutHref)}">${esc(t.checkout)}</a>` : `<button type="button" class="buy-btn">${esc(t.checkout)}</button>`;
  return `<h1>${esc(t.h1)}</h1>
<table class="cart"><thead><tr><th scope="col">${t.th.map(esc).join('</th><th scope="col">')}</th></tr></thead><tbody><tr><td>${esc(t.item)}</td><td><input type="number" name="qty" value="1" min="1" aria-label="${esc(t.qtyLabel)}"></td><td>${price}</td></tr></tbody></table>
<p class="total">${esc(t.total)} <strong>${price}</strong></p>
${btn}`;
};
export const checkoutMain = (t: CartText): string => `<h1>${esc(t.checkoutH1)}</h1>
<form method="post" action="/checkout-view" class="checkout"><label for="em">${esc(t.email)}</label><input id="em" type="email" name="email" autocomplete="email"><label for="ph">${esc(t.phone)}</label><input id="ph" type="tel" name="phone" autocomplete="tel"><label for="ad">${esc(t.address)}</label><input id="ad" type="text" name="address" autocomplete="street-address"><p><button type="submit" class="buy-btn">${esc(t.confirm)}</button></p></form>
<p class="total">${esc(t.total)} <strong>${en0(t)}</strong></p>`;
const en0 = (t: CartText): string => (t === CART_EN ? `1,200${NB}UAH` : `1${NB}200${NB}грн`);
