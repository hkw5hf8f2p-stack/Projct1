/**
 * Чистий магазин (SPEC §57; E3a, база E3c): ті самі шаблони, але жодного з 10 дефектів. Очікування: 0 спрацювань
 * усіх детермінованих детекторів на D і M. Сторінки: /, /catalog, /product/<a|b|c>, /shipping, /about.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc, layout, LOREM, svgPlaceholder } from "../_shared/layout.js";
import { startFixtureServer, type FixtureServer, type SiteHandler, type SiteResponse } from "../_shared/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Product { slug: string; name: string; lead: string; color: string; price: string }
const PRODUCTS: Product[] = [
  { slug: "glass-kettle", name: "Скляний чайник", lead: "Місткий чайник для щоденного чаю.", color: "#bee3f8", price: "1 299 грн" },
  { slug: "travel-thermos", name: "Дорожній термос", lead: "Тримає тепло дванадцять годин.", color: "#c6f6d5", price: "749 грн" },
  { slug: "wooden-board", name: "Дерев'яна дошка", lead: "Дошка з бука для кухні.", color: "#fefcbf", price: "459 грн" },
];
const NAV: Array<[string, string]> = [
  ["/catalog", "Каталог"],
  ["/shipping", "Доставка й оплата"],
  ["/about", "Про нас"],
];
const FOOTER: Array<[string, string]> = [
  ["/shipping", "Доставка й оплата"],
  ["/about", "Про нас"],
];

export function createShopCleanHandler(): SiteHandler {
  const page = (req: { cookies: Record<string, string> }, o: { title: string; description: string; main: string; wide?: boolean }): SiteResponse => ({
    status: 200,
    body: layout({
      ...o,
      brand: "ЧистийДім",
      navLinks: NAV,
      footerLinks: FOOTER,
      menuLabel: "Меню",
      banner: "normal",
      consentGiven: Boolean(req.cookies["sl_consent"]),
    }),
  });

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
      return page(req, {
        title: "ЧистийДім — головна",
        description: "Каталог товарів для дому.",
        wide: true,
        main: `<img class="hero" src="/img/hero.jpg" alt="Полиці з посудом і текстилем у світлій кімнаті" width="1440" height="480">
<div class="pad"><h1>Каталог товарів для дому</h1><p>Небагато речей, але добре вибраних. Ціни й умови видно одразу.</p><p><a href="/catalog">Відкрити каталог</a></p></div>`,
      });
    }
    if (p === "/catalog") {
      return page(req, {
        title: "Каталог — ЧистийДім",
        description: "Товари для дому з цінами.",
        main: `<h1>Каталог</h1>
<ul class="cards">${PRODUCTS.map(
          (x, i) => `<li class="card"><img src="/img/${x.slug}.svg" alt="${i === 1 ? "" : esc(x.name)}" width="80" height="80"><div><h2><a href="/product/${x.slug}">${esc(x.name)}</a></h2><p class="price">${x.price}</p></div></li>`,
        ).join("")}</ul>`,
      });
    }
    const pm = /^\/product\/([a-z0-9-]+)\/?$/.exec(p);
    if (pm) {
      const x = PRODUCTS.find((q) => q.slug === pm[1]);
      if (x) {
        return page(req, {
          title: `${x.name} — ЧистийДім`,
          description: x.lead,
          main: `<h1>${esc(x.name)}</h1>
<p class="price">${x.price}</p>
<form method="post" action="/cart"><input type="hidden" name="slug" value="${x.slug}"><button type="submit" class="buy-btn">Додати в кошик</button></form>
<p>${esc(x.lead)}</p>
<section aria-label="Доставка"><p>Доставка Новою поштою: 1–2 дні, від 70 грн. Докладніше — на сторінці <a href="/shipping">Доставка й оплата</a>.</p></section>
<img class="gallery" src="/img/${x.slug}.svg" alt="${esc(x.name)} на світлому тлі" width="390" height="240">
<section aria-label="Опис">${LOREM.map((t) => `<p>${t}</p>`).join("")}</section>`,
        });
      }
    }
    if (p === "/shipping") {
      return page(req, {
        title: "Доставка й оплата — ЧистийДім",
        description: "Умови доставки й оплати.",
        main: `<h1>Доставка й оплата</h1><p>Доставка Новою поштою: 1–2 дні, від 70 грн. Оплата при отриманні.</p>`,
      });
    }
    if (p === "/about") {
      return page(req, {
        title: "Про нас — ЧистийДім",
        description: "Про магазин.",
        main: `<h1>Про нас</h1><p>Ми відбираємо небагато речей і чесно описуємо, що в них є, а чого немає.</p>`,
      });
    }
    return null;
  };
}

export async function startShopClean(opts: { logFile?: string; port?: number } = {}): Promise<FixtureServer> {
  return startFixtureServer({ handler: createShopCleanHandler(), logFile: opts.logFile, port: opts.port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startShopClean({ logFile: process.env.FIXTURE_LOG, port: process.env.PORT ? Number(process.env.PORT) : 4211 });
  console.log(`shop-clean fixture on ${s.origin}`);
}
