/**
 * Фікстурний магазин SPEC §53: 10 навмисних дефектів. Одна кодова база, мутанти — FIXTURE_MUTANT=m<N> (M2, M5–M10):
 * у мутанті виправлено рівно один дефект. Контролі (DEV-17/DEV-19): FIXTURE_CONTROL=post_on_load | banner_stuck.
 * Дефекти: 1 H1 без категорії · 2 доставка лише в /help/shipping · 3 жаргон у назвах · 4 схожі AquaPro X200/X220 ·
 * 5 CTA нижче згину · 6 іконкова кнопка без підпису (≤768px) · 7 таблиця 540px · 8 hero 2 МБ · 9 img без alt ·
 * 10 ціна лише на /configure. Мітки data-fx — лише для перевірки region ∩ елемент, детектори їх не читають.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, layout, LOREM, svgPlaceholder, type BannerMode } from "../_shared/layout.js";
import { startFixtureServer, type FixtureServer, type SiteHandler, type SiteResponse } from "../_shared/server.js";
import { buyControl, CART_EN, CART_UK, cartMain, checkoutMain, ctaLabel, jsonLdItemList, jsonLdProduct, makeScheme, ogProduct, parseTransforms, withQuery, type Transforms } from "../_shared/variants.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type Mutant = "m2" | "m5" | "m6" | "m7" | "m8" | "m9" | "m10";
export type Control = "post_on_load" | "banner_stuck";
export interface ShopOptions {
  mutant?: Mutant | null;
  control?: Control | null;
  /** метаморфні трансформації (page-type-tests.md): id[] або "U5,V2"; за замовчуванням — без змін */
  transforms?: string | string[] | null;
  /** текст ціни (формати P1–P10 метаморфного набору); за замовчуванням "2 499 грн" */
  priceText?: string;
  logFile?: string;
  port?: number;
}

interface Product {
  slug: string;
  id: number;
  name: string;
  nameEn: string;
  lead: string;
  leadEn: string;
  color: string;
  imgAlt: string | null;
  wideTable: boolean;
}

const PRODUCTS: Product[] = [
  { slug: "aquapro-x200", id: 1, name: "AquaPro X200 (система HFX)", nameEn: "AquaPro X200 (HFX system)", lead: "Фільтр для води з проточною кухонною установкою.", leadEn: "Water filter with a flow-through kitchen unit.", color: "#bee3f8", imgAlt: "Фільтр AquaPro X200 на світлому тлі", wideTable: false },
  { slug: "aquapro-x220", id: 2, name: "AquaPro X220 (система HFX)", nameEn: "AquaPro X220 (HFX system)", lead: "Фільтр для води з проточною кухонною установкою.", leadEn: "Water filter with a flow-through kitchen unit.", color: "#c6f6d5", imgAlt: "Фільтр AquaPro X220 на світлому тлі", wideTable: false },
  { slug: "softline-s1", id: 3, name: "Softline S1 (модуль SLT)", nameEn: "Softline S1 (SLT module)", lead: "Пом'якшувач води для побутових потреб.", leadEn: "Water softener for household needs.", color: "#fefcbf", imgAlt: null, wideTable: true },
];
const DEFAULT_PRICE = "2 499 грн";
const NBSP = " ";

export function createShopHandler(opts: ShopOptions = {}): SiteHandler {
  const m = opts.mutant ?? null;
  const control = opts.control ?? null;
  const t: Transforms = parseTransforms(opts.transforms ?? null);
  const en = t.en;
  const L = (uk: string, e: string): string => (en ? e : uk);
  const scheme = makeScheme(t.u, PRODUCTS);
  const PRICE = opts.priceText ?? (en ? `2,499${NBSP}UAH` : DEFAULT_PRICE);
  const banner: BannerMode = control === "banner_stuck" ? "stuck" : "normal";
  const heroFile = m === "m8" ? "hero-small.jpg" : "hero-large.jpg";
  const pName = (p: Product) => (en ? p.nameEn : p.name);
  const pLead = (p: Product) => (en ? p.leadEn : p.lead);
  const cat = scheme.category();
  const NAV: Array<[string, string]> = [
    [cat, L("Каталог", "Catalog")],
    ["/about", L("Про нас", "About us")],
    ...(t.r1 ? ([["/cart-view", L("Кошик", "Cart")]] as Array<[string, string]>) : []),
    ["/logout", L("Вийти", "Log out")],
  ];
  const FOOTER: Array<[string, string]> = [
    ["/help", L("Допомога", "Help")],
    ["/about", L("Про нас", "About us")],
    ...(t.r2 ? ([["/checkout-view", L("Оформлення", "Checkout")]] as Array<[string, string]>) : []),
  ];

  const page = (req: { cookies: Record<string, string> }, logical: string, o: { title: string; description: string; main: string; wide?: boolean; headExtra?: string }): SiteResponse => ({
    status: 200,
    logical,
    body: layout({
      ...o,
      brand: L("ТехноДім", "TechHome"),
      navLinks: NAV,
      footerLinks: FOOTER,
      menuLabel: m === "m6" ? L("Меню", "Menu") : null,
      menuMarker: "d6",
      footerMarker: "d2",
      banner,
      postOnLoad: control === "post_on_load",
      consentGiven: Boolean(req.cookies["sl_consent"]),
      lang: en ? "en" : "uk",
    }),
  });

  const priceLine = (cls = "price") => `<p class="${cls}">${PRICE}</p>`;
  const cardPrice = () => (t.k2 ? `<p class="price"><s>3${NBSP}100${NBSP}грн</s> <b>${PRICE}</b></p>` : priceLine());
  const visibleProducts = t.k1 ? PRODUCTS.slice(0, 2) : PRODUCTS;

  const cardsHtml = (list: Product[], withPrice: boolean, fxAttr: boolean) =>
    list
      .map((p, i) => {
        const lab = ctaLabel(t, PRODUCTS.indexOf(p), L("В кошик", "Add to cart"));
        return `<li class="card"><img src="/img/${p.slug}.svg" alt="${esc(p.imgAlt ?? pName(p))}" width="120" height="120">
<div><h2><a href="${esc(scheme.product(p))}"${fxAttr && p.id <= 2 ? ' data-fx="d4"' : ""}>${esc(pName(p))}</a></h2><p>${esc(pLead(p))}</p>${withPrice ? cardPrice() : ""}<a class="btn" href="${esc(withQuery(cat, "add-to-cart", p.id))}"${lab.aria ? ` aria-label="${esc(lab.aria)}"` : ""}>${esc(lab.text === "→" ? "→" : lab.text)}</a></div></li>`;
      })
      .join("");

  const home = (req: { cookies: Record<string, string> }) =>
    page(req, "home", {
      title: L("ТехноДім — головна", "TechHome — home"),
      description: L("Магазин речей для дому.", "Home goods store."),
      wide: true,
      main: `<img class="hero" src="/img/hero.jpg" alt="${esc(L("Світла вітрина магазину з речами для дому", "Bright storefront with home goods"))}" width="1440" height="480" data-fx="d8">
<div class="pad"><h1 data-fx="d1">${esc(L("Ідеї, що змінюють будні", "Ideas that change everyday life"))}</h1>
<p>${esc(L("Ми підбираємо речі, які роблять день простішим. Заходьте й дивіться самі.", "We pick things that make the day simpler. Come in and see for yourself."))}</p>
<p><a href="${esc(cat)}">${esc(L("Переглянути асортимент", "Browse the range"))}</a></p>${t.k1 ? `\n<p><a href="${esc(scheme.product(PRODUCTS[2]!))}">${esc(L("Новинка", "New arrival"))}</a></p>` : ""}</div>`,
    });

  const catalog = (req: { cookies: Record<string, string> }) =>
    page(req, "catalog", {
      title: L("Каталог — ТехноДім", "Catalog — TechHome"),
      description: L("Три моделі для щоденного вжитку.", "Three models for everyday use."),
      headExtra: t.j3 ? jsonLdItemList(visibleProducts.map((p) => ({ name: pName(p), url: scheme.product(p) }))) : "",
      main: `<h1>${esc(L("Каталог", "Catalog"))}</h1>
<p>${esc(L("Три моделі для щоденного вжитку.", "Three models for everyday use."))} <a href="${esc(withQuery(cat, "action", "delete&list=compare"))}">${esc(L("Очистити порівняння", "Clear comparison"))}</a></p>
<ul class="cards" data-fx="d10">${cardsHtml(visibleProducts, m === "m10", true)}</ul>`,
    });

  /** T1 (DEV-38): «команда» — 3 однакові картки «фото + ім'я-посилання», без цін і без product-подібних URL (посилання ?member= дублюють /about) */
  const teamHtml = () =>
    `<section aria-label="${esc(L("Команда", "Team"))}"><h2>${esc(L("Наша команда", "Our team"))}</h2><ul class="cards">${["Анна", "Богдан", "Оксана"]
      .map((n, i) => `<li class="card"><img src="/img/aquapro-x200.svg" alt="${esc(L("Фото", "Photo"))}: ${esc(n)}" width="120" height="120"><div><h3><a href="/about?member=${i + 1}">${esc(n)}</a></h3><p>${esc(L("Керує напрямком", "Team member"))}</p></div></li>`)
      .join("")}</ul></section>`;

  const product = (req: { cookies: Record<string, string> }, p: Product) => {
    const pi = PRODUCTS.indexOf(p);
    const lab = ctaLabel(t, pi, L("Додати в кошик", "Add to cart"));
    const buy = buyControl(t, { i: pi, label: lab, hiddenName: "id", hiddenValue: p.id, addHref: withQuery(scheme.product(p), "add-to-cart", p.id), fx: "d5" });
    const alt = m === "m9" && p.imgAlt === null ? ` alt="Пом'якшувач Softline S1 на світлому тлі"` : p.imgAlt === null ? "" : ` alt="${esc(p.imgAlt)}"`;
    const table = p.wideTable
      ? (() => {
          const tb = `<table class="specs" data-fx="d7"><caption>Характеристики</caption><thead><tr><th scope="col">Параметр</th><th scope="col">Значення</th><th scope="col">Примітка</th></tr></thead><tbody><tr><td>Тип</td><td>Пом'якшувач</td><td>Побутовий</td></tr><tr><td>Кольори</td><td>Білий, сірий</td><td>На вибір</td></tr></tbody></table>`;
          return m === "m7" ? `<div class="scroll" tabindex="0" role="region" aria-label="Таблиця характеристик">${tb}</div>` : tb;
        })()
      : "";
    const ship = m === "m2" ? `<section aria-label="Доставка"><p data-fx="d2">Доставка: 1–2 дні, від 70 грн.</p></section>` : "";
    const related = t.r3
      ? `<section aria-label="${esc(L("Схожі товари", "Similar products"))}"><h2>${esc(L("Схожі товари", "Similar products"))}</h2><ul class="cards">${cardsHtml(PRODUCTS, false, false)}</ul></section>`
      : "";
    return page(req, `product:${p.slug}`, {
      title: `${pName(p)} — ${L("ТехноДім", "TechHome")}`,
      description: pLead(p),
      headExtra: `${t.j1 ? jsonLdProduct(pName(p), pLead(p)) : ""}${t.j2 ? ogProduct() : ""}`,
      main: `<h1>${esc(pName(p))}</h1>
${m === "m5" ? buy : ""}
<section data-fx="d10">${m === "m10" ? priceLine() : ""}<img class="gallery" src="/img/${p.slug}.svg"${alt} width="390" height="240"${p.imgAlt === null ? ' data-fx="d9"' : ""}>
<p>${esc(pLead(p))}</p>
<p><a href="${esc(scheme.configure(p))}">${esc(L("Налаштувати комплектацію", "Configure options"))}</a></p>
<p><a href="${esc(withQuery(scheme.product(p), "action", "delete&id=" + p.id))}">${esc(L("Прибрати з порівняння", "Remove from comparison"))}</a></p></section>
<section class="desc" style="height:1650px" aria-label="Опис">${LOREM.map((x) => `<p>${x}</p>`).join("")}${table}</section>
${m === "m5" ? "" : buy}
${ship}
${related}`,
    });
  };

  const configure = (req: { cookies: Record<string, string> }, p: Product) =>
    page(req, `configure:${p.slug}`, {
      title: `${L("Комплектація", "Configuration")} ${pName(p)} — ${L("ТехноДім", "TechHome")}`,
      description: L("Налаштування комплектації.", "Configuration options."),
      main: `<h1>${esc(L("Комплектація", "Configuration"))}</h1><p>${esc(L("Обрана модель:", "Selected model:"))} ${esc(pName(p))}</p><section aria-label="${esc(L("Ціна", "Price"))}">${priceLine()}</section><p><a href="${esc(scheme.product(p))}">${esc(L("Назад до моделі", "Back to the model"))}</a></p>`,
    });

  return (req) => {
    const { method, url } = req;
    const p = url.pathname;
    if (method === "POST") {
      if (p === "/cart") return { status: 200, body: "<!doctype html><title>Кошик</title><p>Додано (POST)</p>" };
      if (p === "/contact") return { status: 200, body: "<!doctype html><title>Дякуємо</title><p>Повідомлення отримано (POST)</p>" };
      return { status: 204 };
    }
    if (method !== "GET" && method !== "HEAD") return { status: 405, type: "text/plain", body: "method not allowed" };

    const svg = /^\/img\/([a-z0-9-]+)\.svg$/.exec(p);
    if (svg) {
      const prod = PRODUCTS.find((x) => x.slug === svg[1]);
      return { status: 200, type: "image/svg+xml", body: svgPlaceholder(prod?.name.split(" (")[0] ?? "img", prod?.color ?? "#e2e8f0") };
    }
    if (p === "/img/hero.jpg") return { status: 200, type: "image/jpeg", body: readFileSync(path.join(HERE, "img", heroFile)) };

    if (p === "/logout") return { status: 200, logical: "logout", body: "<!doctype html><title>Вихід</title><p>Ви вийшли (GET змінив стан)</p>" };
    if (p === "/") return home(req);
    if (p === "/help") {
      return page(req, "help", {
        title: L("Допомога — ТехноДім", "Help — TechHome"),
        description: L("Відповіді на поширені запитання.", "Answers to common questions."),
        main: `<h1>${esc(L("Допомога", "Help"))}</h1><ul><li><a href="/help/shipping">${esc(L("Доставка й оплата", "Shipping & payment"))}</a></li><li><a href="/about">${esc(L("Контакти", "Contacts"))}</a></li></ul>`,
      });
    }
    if (p === "/help/shipping") {
      return page(req, "help-shipping", {
        title: L("Доставка й оплата — ТехноДім", "Shipping & payment — TechHome"),
        description: L("Умови доставки й оплати.", "Shipping and payment terms."),
        main: `<h1>${esc(L("Доставка й оплата", "Shipping & payment"))}</h1><p>${esc(L("Доставка Новою поштою: 1–2 дні, від 70 грн. Оплата при отриманні.", "Shipping by courier: 1–2 days, from 70 UAH. Payment on delivery."))}</p>`,
      });
    }
    if (p === "/about") {
      return page(req, "about", {
        title: L("Про нас — ТехноДім", "About us — TechHome"),
        description: L("Про магазин.", "About the store."),
        main: `<h1>${esc(L("Про нас", "About us"))}</h1><p>${esc(L("Ми — невеликий магазин, який відбирає речі для дому й пояснює, чим вони відрізняються.", "We are a small store that picks things for the home and explains how they differ."))}</p>
${t.t1 ? teamHtml() : ""}
<form method="post" action="/contact"><p><label for="msg">${esc(L("Ваше повідомлення", "Your message"))}</label><br><textarea id="msg" name="msg" rows="3" cols="40"></textarea></p><p><button type="submit" class="buy-btn">${esc(L("Надіслати", "Send"))}</button></p></form>`,
      });
    }
    if (t.r1 && p === "/cart-view") return page(req, "cart-view", { title: L("Кошик — ТехноДім", "Cart — TechHome"), description: L("Ваш кошик.", "Your cart."), main: cartMain(en ? CART_EN : CART_UK, t.r2 ? "/checkout-view" : null, en) });
    if (t.r2 && p === "/checkout-view") return page(req, "checkout-view", { title: L("Оформлення — ТехноДім", "Checkout — TechHome"), description: L("Оформлення замовлення.", "Place your order."), main: checkoutMain(en ? CART_EN : CART_UK) });

    const r = scheme.route(url);
    if (r?.kind === "category") return catalog(req);
    if (r && (r.kind === "product" || r.kind === "configure")) {
      const prod = PRODUCTS.find((x) => x.slug === r.slug);
      if (prod) return r.kind === "configure" ? configure(req, prod) : product(req, prod);
    }
    return null;
  };
}

export async function startShop(opts: ShopOptions = {}): Promise<FixtureServer> {
  return startFixtureServer({ handler: createShopHandler(opts), logFile: opts.logFile, port: opts.port });
}

// CLI: FIXTURE_MUTANT=m5 FIXTURE_TRANSFORM=U5,V2 PORT=4210 tsx fixtures/shop/server.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startShop({
    mutant: (process.env.FIXTURE_MUTANT as Mutant | undefined) ?? null,
    control: (process.env.FIXTURE_CONTROL as Control | undefined) ?? null,
    transforms: process.env.FIXTURE_TRANSFORM ?? null,
    logFile: process.env.FIXTURE_LOG,
    port: process.env.PORT ? Number(process.env.PORT) : 4210,
  });
  console.log(`shop fixture on ${s.origin}`);
}
