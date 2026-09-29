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

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type Mutant = "m2" | "m5" | "m6" | "m7" | "m8" | "m9" | "m10";
export type Control = "post_on_load" | "banner_stuck";
export interface ShopOptions {
  mutant?: Mutant | null;
  control?: Control | null;
  logFile?: string;
  port?: number;
}

interface Product {
  slug: string;
  id: number;
  name: string;
  lead: string;
  color: string;
  imgAlt: string | null;
  wideTable: boolean;
}

const PRODUCTS: Product[] = [
  { slug: "aquapro-x200", id: 1, name: "AquaPro X200 (система HFX)", lead: "Фільтр для води з проточною кухонною установкою.", color: "#bee3f8", imgAlt: "Фільтр AquaPro X200 на світлому тлі", wideTable: false },
  { slug: "aquapro-x220", id: 2, name: "AquaPro X220 (система HFX)", lead: "Фільтр для води з проточною кухонною установкою.", color: "#c6f6d5", imgAlt: "Фільтр AquaPro X220 на світлому тлі", wideTable: false },
  { slug: "softline-s1", id: 3, name: "Softline S1 (модуль SLT)", lead: "Пом'якшувач води для побутових потреб.", color: "#fefcbf", imgAlt: null, wideTable: true },
];
const PRICE = "2 499 грн";

const NAV: Array<[string, string]> = [
  ["/catalog", "Каталог"],
  ["/about", "Про нас"],
  ["/logout", "Вийти"],
];
const FOOTER: Array<[string, string]> = [
  ["/help", "Допомога"],
  ["/about", "Про нас"],
];

export function createShopHandler(opts: ShopOptions = {}): SiteHandler {
  const m = opts.mutant ?? null;
  const control = opts.control ?? null;
  const banner: BannerMode = control === "banner_stuck" ? "stuck" : "normal";
  const heroFile = m === "m8" ? "hero-small.jpg" : "hero-large.jpg";

  const page = (req: { cookies: Record<string, string> }, o: { title: string; description: string; main: string; wide?: boolean }): SiteResponse => ({
    status: 200,
    body: layout({
      ...o,
      brand: "ТехноДім",
      navLinks: NAV,
      footerLinks: FOOTER,
      menuLabel: m === "m6" ? "Меню" : null,
      menuMarker: "d6",
      footerMarker: "d2",
      banner,
      postOnLoad: control === "post_on_load",
      consentGiven: Boolean(req.cookies["sl_consent"]),
    }),
  });

  const priceLine = (cls = "price") => `<p class="${cls}">${PRICE}</p>`;

  const home = (req: { cookies: Record<string, string> }) =>
    page(req, {
      title: "ТехноДім — головна",
      description: "Магазин речей для дому.",
      wide: true,
      main: `<img class="hero" src="/img/hero.jpg" alt="Світла вітрина магазину з речами для дому" width="1440" height="480" data-fx="d8">
<div class="pad"><h1 data-fx="d1">Ідеї, що змінюють будні</h1>
<p>Ми підбираємо речі, які роблять день простішим. Заходьте й дивіться самі.</p>
<p><a href="/catalog">Переглянути асортимент</a></p></div>`,
    });

  const catalog = (req: { cookies: Record<string, string> }) =>
    page(req, {
      title: "Каталог — ТехноДім",
      description: "Три моделі для щоденного вжитку.",
      main: `<h1>Каталог</h1>
<p>Три моделі для щоденного вжитку. <a href="/catalog?action=delete&amp;list=compare">Очистити порівняння</a></p>
<ul class="cards" data-fx="d10">${PRODUCTS.map(
        (p) => `<li class="card"><img src="/img/${p.slug}.svg" alt="${esc(p.imgAlt ?? p.name)}" width="120" height="120">
<div><h2><a href="/product/${p.slug}"${p.id <= 2 ? ' data-fx="d4"' : ""}>${esc(p.name)}</a></h2><p>${esc(p.lead)}</p>${m === "m10" ? priceLine() : ""}<a class="btn" href="/catalog?add-to-cart=${p.id}">В кошик</a></div></li>`,
      ).join("")}</ul>`,
    });

  const product = (req: { cookies: Record<string, string> }, p: Product) => {
    const buy = `<form method="post" action="/cart" class="buy"><input type="hidden" name="id" value="${p.id}"><button type="submit" class="buy-btn" data-fx="d5">Додати в кошик</button></form>`;
    const alt = m === "m9" && p.imgAlt === null ? ` alt="Пом'якшувач Softline S1 на світлому тлі"` : p.imgAlt === null ? "" : ` alt="${esc(p.imgAlt)}"`;
    const table = p.wideTable
      ? (() => {
          const t = `<table class="specs" data-fx="d7"><caption>Характеристики</caption><thead><tr><th scope="col">Параметр</th><th scope="col">Значення</th><th scope="col">Примітка</th></tr></thead><tbody><tr><td>Тип</td><td>Пом'якшувач</td><td>Побутовий</td></tr><tr><td>Кольори</td><td>Білий, сірий</td><td>На вибір</td></tr></tbody></table>`;
          return m === "m7" ? `<div class="scroll" tabindex="0" role="region" aria-label="Таблиця характеристик">${t}</div>` : t;
        })()
      : "";
    const ship = m === "m2" ? `<section aria-label="Доставка"><p data-fx="d2">Доставка: 1–2 дні, від 70 грн.</p></section>` : "";
    return page(req, {
      title: `${p.name} — ТехноДім`,
      description: p.lead,
      main: `<h1>${esc(p.name)}</h1>
${m === "m5" ? buy : ""}
<section data-fx="d10">${m === "m10" ? priceLine() : ""}<img class="gallery" src="/img/${p.slug}.svg"${alt} width="390" height="240"${p.imgAlt === null ? ' data-fx="d9"' : ""}>
<p>${esc(p.lead)}</p>
<p><a href="/product/${p.slug}/configure">Налаштувати комплектацію</a></p>
<p><a href="/product/${p.slug}?action=delete&amp;id=${p.id}">Прибрати з порівняння</a></p></section>
<section class="desc" style="height:1650px" aria-label="Опис">${LOREM.map((t) => `<p>${t}</p>`).join("")}${table}</section>
${m === "m5" ? "" : buy}
${ship}`,
    });
  };

  const configure = (req: { cookies: Record<string, string> }, p: Product) =>
    page(req, {
      title: `Комплектація ${p.name} — ТехноДім`,
      description: "Налаштування комплектації.",
      main: `<h1>Комплектація</h1><p>Обрана модель: ${esc(p.name)}</p><section aria-label="Ціна">${priceLine()}</section><p><a href="/product/${p.slug}">Назад до моделі</a></p>`,
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

    if (p === "/logout") return { status: 200, body: "<!doctype html><title>Вихід</title><p>Ви вийшли (GET змінив стан)</p>" };
    if (p === "/") return home(req);
    if (p === "/catalog") return catalog(req);
    if (p === "/help") {
      return page(req, {
        title: "Допомога — ТехноДім",
        description: "Відповіді на поширені запитання.",
        main: `<h1>Допомога</h1><ul><li><a href="/help/shipping">Доставка й оплата</a></li><li><a href="/about">Контакти</a></li></ul>`,
      });
    }
    if (p === "/help/shipping") {
      return page(req, {
        title: "Доставка й оплата — ТехноДім",
        description: "Умови доставки й оплати.",
        main: `<h1>Доставка й оплата</h1><p>Доставка Новою поштою: 1–2 дні, від 70 грн. Оплата при отриманні.</p>`,
      });
    }
    if (p === "/about") {
      return page(req, {
        title: "Про нас — ТехноДім",
        description: "Про магазин.",
        main: `<h1>Про нас</h1><p>Ми — невеликий магазин, який відбирає речі для дому й пояснює, чим вони відрізняються.</p>
<form method="post" action="/contact"><p><label for="msg">Ваше повідомлення</label><br><textarea id="msg" name="msg" rows="3" cols="40"></textarea></p><p><button type="submit" class="buy-btn">Надіслати</button></p></form>`,
      });
    }
    const prodM = /^\/product\/([a-z0-9-]+)(\/configure)?\/?$/.exec(p);
    if (prodM) {
      const prod = PRODUCTS.find((x) => x.slug === prodM[1]);
      if (prod) return prodM[2] ? configure(req, prod) : product(req, prod);
    }
    return null;
  };
}

export async function startShop(opts: ShopOptions = {}): Promise<FixtureServer> {
  return startFixtureServer({ handler: createShopHandler(opts), logFile: opts.logFile, port: opts.port });
}

// CLI: FIXTURE_MUTANT=m5 PORT=4210 tsx fixtures/shop/server.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startShop({
    mutant: (process.env.FIXTURE_MUTANT as Mutant | undefined) ?? null,
    control: (process.env.FIXTURE_CONTROL as Control | undefined) ?? null,
    logFile: process.env.FIXTURE_LOG,
    port: process.env.PORT ? Number(process.env.PORT) : 4210,
  });
  console.log(`shop fixture on ${s.origin}`);
}
