/**
 * Чистий магазин (SPEC §57; E3a, база E3c): ті самі шаблони, але жодного з 10 дефектів. Очікування: 0 спрацювань
 * усіх детермінованих детекторів на D і M. Сторінки: /, /catalog, /product/<a|b|c>, /shipping, /about.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, layout, LOREM, svgPlaceholder } from "../_shared/layout.js";
import { startFixtureServer, type FixtureServer, type SiteHandler, type SiteResponse } from "../_shared/server.js";
import { buyControl, CART_EN, CART_UK, cartMain, checkoutMain, ctaLabel, jsonLdItemList, jsonLdProduct, makeScheme, ogProduct, parseTransforms } from "../_shared/variants.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Product { slug: string; id: number; name: string; nameEn: string; lead: string; leadEn: string; color: string; price: string; priceEn: string; oldPrice: string }
const PRODUCTS: Product[] = [
  { slug: "glass-kettle", id: 1, name: "Скляний чайник", nameEn: "Glass kettle", lead: "Місткий чайник для щоденного чаю.", leadEn: "A roomy kettle for everyday tea.", color: "#bee3f8", price: "1 299 грн", priceEn: "1,299 UAH", oldPrice: "1 599 грн" },
  { slug: "travel-thermos", id: 2, name: "Дорожній термос", nameEn: "Travel thermos", lead: "Тримає тепло дванадцять годин.", leadEn: "Keeps heat for twelve hours.", color: "#c6f6d5", price: "749 грн", priceEn: "749 UAH", oldPrice: "899 грн" },
  { slug: "wooden-board", id: 3, name: "Дерев'яна дошка", nameEn: "Wooden board", lead: "Дошка з бука для кухні.", leadEn: "A beech board for the kitchen.", color: "#fefcbf", price: "459 грн", priceEn: "459 UAH", oldPrice: "549 грн" },
];

export interface ShopCleanOptions {
  /** метаморфні трансформації (page-type-tests.md): id[] або "U5,V2" */
  transforms?: string | string[] | null;
  logFile?: string;
  port?: number;
}

export function createShopCleanHandler(opts: ShopCleanOptions = {}): SiteHandler {
  const t = parseTransforms(opts.transforms ?? null);
  const en = t.en;
  const L = (uk: string, e: string): string => (en ? e : uk);
  const scheme = makeScheme(t.u, PRODUCTS);
  const cat = scheme.category();
  const brand = L("ЧистийДім", "CleanHome");
  const NAV: Array<[string, string]> = [
    [cat, L("Каталог", "Catalog")],
    ["/shipping", L("Доставка й оплата", "Shipping & payment")],
    ["/about", L("Про нас", "About us")],
    ...(t.r1 ? ([["/cart-view", L("Кошик", "Cart")]] as Array<[string, string]>) : []),
  ];
  const FOOTER: Array<[string, string]> = [
    ["/shipping", L("Доставка й оплата", "Shipping & payment")],
    ["/about", L("Про нас", "About us")],
    ...(t.r2 ? ([["/checkout-view", L("Оформлення", "Checkout")]] as Array<[string, string]>) : []),
  ];
  const pName = (p: Product) => (en ? p.nameEn : p.name);
  const pLead = (p: Product) => (en ? p.leadEn : p.lead);
  const pPrice = (p: Product) => (en ? p.priceEn : p.price);
  const priceHtml = (p: Product) => (t.k2 ? `<p class="price"><s>${p.oldPrice}</s> <b>${pPrice(p)}</b></p>` : `<p class="price">${pPrice(p)}</p>`);

  const page = (req: { cookies: Record<string, string> }, logical: string, o: { title: string; description: string; main: string; wide?: boolean; headExtra?: string }): SiteResponse => ({
    status: 200,
    logical,
    body: layout({
      ...o,
      brand,
      navLinks: NAV,
      footerLinks: FOOTER,
      menuLabel: L("Меню", "Menu"),
      banner: "normal",
      consentGiven: Boolean(req.cookies["sl_consent"]),
      lang: en ? "en" : "uk",
    }),
  });
  const visible = t.k1 ? PRODUCTS.slice(0, 2) : PRODUCTS;
  const cards = (list: Product[], altBlank: boolean) =>
    list.map((x, i) => `<li class="card"><img src="/img/${x.slug}.svg" alt="${altBlank && i === 1 ? "" : esc(pName(x))}" width="80" height="80"><div><h2><a href="${esc(scheme.product(x))}">${esc(pName(x))}</a></h2>${priceHtml(x)}</div></li>`).join("");

  return (req) => {
    const { method, url } = req;
    const p = url.pathname;
    if (method === "POST") {
      if (p === "/cart") return { status: 200, body: "<!doctype html><title>Кошик</title><p>Додано (POST)</p>" };
      return { status: 204 };
    }
    if (method !== "GET" && method !== "HEAD") return { status: 405, type: "text/plain", body: "method not allowed" };

    const svg = /^\/img\/([a-z0-9-]+)\.svg$/.exec(p);
    if (svg) {
      const prod = PRODUCTS.find((x) => x.slug === svg[1]);
      return { status: 200, type: "image/svg+xml", body: svgPlaceholder(prod?.name ?? "img", prod?.color ?? "#e2e8f0") };
    }
    if (p === "/img/hero.jpg") return { status: 200, type: "image/jpeg", body: readFileSync(path.join(HERE, "img", "hero.jpg")) };

    if (p === "/") {
      return page(req, "home", {
        title: L("ЧистийДім — головна", "CleanHome — home"),
        description: L("Каталог товарів для дому.", "Catalog of home goods."),
        wide: true,
        main: `<img class="hero" src="/img/hero.jpg" alt="${esc(L("Полиці з посудом і текстилем у світлій кімнаті", "Shelves with dishes and textiles in a bright room"))}" width="1440" height="480">
<div class="pad"><h1>${esc(L("Каталог товарів для дому", "Catalog of home goods"))}</h1><p>${esc(L("Небагато речей, але добре вибраних. Ціни й умови видно одразу.", "Few things, well chosen. Prices and terms are visible at once."))}</p><p><a href="${esc(cat)}">${esc(L("Відкрити каталог", "Open the catalog"))}</a></p>${t.k1 ? `\n<p><a href="${esc(scheme.product(PRODUCTS[2]!))}">${esc(L("Новинка", "New arrival"))}</a></p>` : ""}</div>`,
      });
    }
    if (p === "/shipping") {
      return page(req, "shipping", {
        title: L("Доставка й оплата — ЧистийДім", "Shipping & payment — CleanHome"),
        description: L("Умови доставки й оплати.", "Shipping and payment terms."),
        main: `<h1>${esc(L("Доставка й оплата", "Shipping & payment"))}</h1><p>${esc(L("Доставка Новою поштою: 1–2 дні, від 70 грн. Оплата при отриманні.", "Shipping by courier: 1–2 days, from 70 UAH. Payment on delivery."))}</p>`,
      });
    }
    if (p === "/about") {
      return page(req, "about", {
        title: L("Про нас — ЧистийДім", "About us — CleanHome"),
        description: L("Про магазин.", "About the store."),
        main: `<h1>${esc(L("Про нас", "About us"))}</h1><p>${esc(L("Ми відбираємо небагато речей і чесно описуємо, що в них є, а чого немає.", "We pick a few things and honestly describe what they have and what they lack."))}</p>`,
      });
    }
    if (t.r1 && p === "/cart-view") return page(req, "cart-view", { title: L("Кошик — ЧистийДім", "Cart — CleanHome"), description: L("Ваш кошик.", "Your cart."), main: cartMain(en ? CART_EN : CART_UK, t.r2 ? "/checkout-view" : null, en) });
    if (t.r2 && p === "/checkout-view") return page(req, "checkout-view", { title: L("Оформлення — ЧистийДім", "Checkout — CleanHome"), description: L("Оформлення замовлення.", "Place your order."), main: checkoutMain(en ? CART_EN : CART_UK) });

    const r = scheme.route(url);
    if (r?.kind === "category") {
      return page(req, "catalog", {
        title: L("Каталог — ЧистийДім", "Catalog — CleanHome"),
        description: L("Товари для дому з цінами.", "Home goods with prices."),
        headExtra: t.j3 ? jsonLdItemList(visible.map((x) => ({ name: pName(x), url: scheme.product(x) }))) : "",
        main: `<h1>${esc(L("Каталог", "Catalog"))}</h1>
<ul class="cards">${cards(visible, true)}</ul>`,
      });
    }
    if (r?.kind === "product") {
      const x = PRODUCTS.find((q) => q.slug === r.slug);
      if (x) {
        const i = PRODUCTS.indexOf(x);
        const buy = buyControl(t, { i, label: ctaLabel(t, i, L("Додати в кошик", "Add to cart")), hiddenName: "slug", hiddenValue: x.slug, addHref: `${scheme.product(x)}${scheme.product(x).includes("?") ? "&" : "?"}add-to-cart=${x.id}` });
        return page(req, `product:${x.slug}`, {
          title: `${pName(x)} — ${brand}`,
          description: pLead(x),
          headExtra: `${t.j1 ? jsonLdProduct(pName(x), pLead(x)) : ""}${t.j2 ? ogProduct() : ""}`,
          main: `<h1>${esc(pName(x))}</h1>
<p class="price">${pPrice(x)}</p>
${buy}
<p>${esc(pLead(x))}</p>
<section aria-label="${esc(L("Доставка", "Shipping"))}"><p>${en ? `Shipping by courier: 1–2 days, from 70 UAH. See the <a href="/shipping">Shipping &amp; payment</a> page.` : `Доставка Новою поштою: 1–2 дні, від 70 грн. Докладніше — на сторінці <a href="/shipping">Доставка й оплата</a>.`}</p></section>
<img class="gallery" src="/img/${x.slug}.svg" alt="${esc(pName(x))}${esc(L(" на світлому тлі", " on a light background"))}" width="390" height="240">
<section aria-label="Опис">${LOREM.map((q) => `<p>${q}</p>`).join("")}</section>${t.r3 ? `\n<section aria-label="${esc(L("Схожі товари", "Similar products"))}"><h2>${esc(L("Схожі товари", "Similar products"))}</h2><ul class="cards">${cards(PRODUCTS, false)}</ul></section>` : ""}`,
        });
      }
    }
    return null;
  };
}

export async function startShopClean(opts: ShopCleanOptions = {}): Promise<FixtureServer> {
  return startFixtureServer({ handler: createShopCleanHandler(opts), logFile: opts.logFile, port: opts.port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startShopClean({ transforms: process.env.FIXTURE_TRANSFORM ?? null, logFile: process.env.FIXTURE_LOG, port: process.env.PORT ? Number(process.env.PORT) : 4211 });
  console.log(`shop-clean fixture on ${s.origin}`);
}
