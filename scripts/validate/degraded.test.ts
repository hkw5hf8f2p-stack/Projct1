/**
 * shop-clean-degraded (E3c, DEV-16/DEV-74), без браузера: (1) shop-clean за замовчуванням байт-ідентичний до S1a (хеші знято з
 * HEAD до правки); (2) кожна з 5 змін міняє рівно свої сторінки; (3) сліпота — слова «degraded» ніде немає; (4) контроль: тест
 * уміє впасти (підставлена «протікаюча» копія ловиться).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SiteHandler, SiteResponse } from "../../fixtures/_shared/server.js";
import { createShopCleanHandler, DEGRADATIONS, type Degradation } from "../../fixtures/shop-clean/server.js";
import { createShopCleanDegradedHandler } from "../../fixtures/shop-clean-degraded/server.js";

const ROUTES = ["/", "/catalog", "/product/glass-kettle", "/product/travel-thermos", "/product/wooden-board", "/shipping", "/about", "/nope"];
const get = (h: SiteHandler, r: string): SiteResponse => h({ method: "GET", url: new URL("http://x" + r), cookies: {} }) ?? { status: 404 };
const body = (h: SiteHandler, r: string): string => String(get(h, r).body ?? "");
const hash = (x: SiteResponse): string => createHash("sha256").update(String(x.body ?? "") + "|" + x.status).digest("hex").slice(0, 16);

/** sha256(тіло|статус)[:16] shop-clean з HEAD ДО правки S4 (знято тимчасовою копією HEAD-версії) */
const HEAD_HASH: Record<string, string> = {
  "/": "ebae09e37d4793a7", "/catalog": "a76f5a5dd12b0be2", "/product/glass-kettle": "b003edc51e6ed6f0", "/product/travel-thermos": "50ac66e9985b8bd5",
  "/product/wooden-board": "23f7a2b1650fad2f", "/shipping": "4d8e241d33dd3e79", "/about": "8db20891094cfec4", "/nope": "985233c35f7eb576",
};

describe("shop-clean не змінився (степінь: байт)", () => {
  it("degrade не задано → усі маршрути мають хеш HEAD", () => {
    const h = createShopCleanHandler();
    for (const r of ROUTES) expect(hash(get(h, r)), r).toBe(HEAD_HASH[r]);
  });
  it("контроль: із будь-якою зміною хоч один маршрут відрізняється (перевірка вміє впасти)", () => {
    for (const d of DEGRADATIONS) {
      const h = createShopCleanHandler({ degrade: [d] });
      expect(ROUTES.some((r) => hash(get(h, r)) !== HEAD_HASH[r]), d).toBe(true);
    }
  });
});

describe("5 змін §67: кожна міняє рівно свої сторінки", () => {
  const changed = (d: Degradation): string[] => {
    const h = createShopCleanHandler({ degrade: [d] });
    return ROUTES.filter((r) => hash(get(h, r)) !== HEAD_HASH[r]);
  };
  // shipping/trust: зникають посилання в шапці/футері → змінюються ВСІ сторінки з макетом; тому перевіряємо зміст, а не лише список
  it("shipping: /shipping → 404; на товарі немає слова доставки; посилання «Доставка й оплата» зникли всюди", () => {
    const h = createShopCleanHandler({ degrade: ["shipping"] });
    expect(get(h, "/shipping").status).toBe(404);
    for (const r of ["/", "/catalog", "/product/glass-kettle", "/about"]) expect(body(h, r), r).not.toMatch(/Доставк/u);
    expect(body(createShopCleanHandler(), "/product/glass-kettle")).toMatch(/Доставк/u);
  });
  it("cta: кнопка купівлі стоїть ПІСЛЯ опису висотою 1650px; без зміни — до опису", () => {
    const at = (b: string, needle: string): number => b.indexOf(needle);
    const d = body(createShopCleanHandler({ degrade: ["cta"] }), "/product/glass-kettle");
    const c = body(createShopCleanHandler(), "/product/glass-kettle");
    expect(at(d, 'class="buy-btn"')).toBeGreaterThan(at(d, 'aria-label="Опис"'));
    expect(at(c, 'class="buy-btn"')).toBeLessThan(at(c, 'aria-label="Опис"'));
    expect(d).toContain("height:1650px");
    expect(changed("cta")).toEqual(["/product/glass-kettle", "/product/travel-thermos", "/product/wooden-board"]);
  });
  it("headline: змінюється лише головна; H1 без «Каталог»", () => {
    expect(changed("headline")).toEqual(["/"]);
    expect(body(createShopCleanHandler({ degrade: ["headline"] }), "/")).toMatch(/<h1>Якість, що надихає<\/h1>/u);
  });
  it("comparison: змінюється лише каталог; цін на картках немає", () => {
    expect(changed("comparison")).toEqual(["/catalog"]);
    const d = body(createShopCleanHandler({ degrade: ["comparison"] }), "/catalog");
    expect(d).not.toMatch(/грн/u);
    expect(body(createShopCleanHandler(), "/catalog")).toMatch(/1 299 грн/u);
  });
  it("trust: /about → 404; посилань «Про нас» немає; на товарі немає «Гарантійний»", () => {
    const h = createShopCleanHandler({ degrade: ["trust"] });
    expect(get(h, "/about").status).toBe(404);
    for (const r of ["/", "/catalog", "/product/glass-kettle", "/shipping"]) expect(body(h, r), r).not.toMatch(/Про нас/u);
    expect(body(h, "/product/glass-kettle")).not.toMatch(/Гарантійн/u);
    expect(body(createShopCleanHandler(), "/product/glass-kettle")).toMatch(/Гарантійн/u);
  });
});

describe("shop-clean-degraded = усі 5 змін разом; сліпота", () => {
  const D = createShopCleanDegradedHandler();
  const ALL = createShopCleanHandler({ degrade: DEGRADATIONS });
  it("ідентичний shop-clean{degrade: усі п'ять} на всіх маршрутах", () => {
    for (const r of ROUTES) expect(hash(get(D, r)), r).toBe(hash(get(ALL, r)));
  });
  it("слова «degraded»/«degrade» немає в жодному тілі, заголовку, шляху", () => {
    for (const r of [...ROUTES, "/img/glass-kettle.svg"]) {
      const x = get(D, r);
      expect(JSON.stringify({ ...x, body: typeof x.body === "string" ? x.body : "" }), r).not.toMatch(/degrad/i);
    }
  });
  it("контроль сліпоти: підкладена копія з «degraded» у title ЛОВИТЬСЯ тим самим предикатом", () => {
    const leaky: SiteHandler = (q) => {
      const r = D(q);
      return r ? { ...r, body: String(r.body ?? "").replace("<title>", "<title>degraded ") } : r;
    };
    expect(JSON.stringify(get(leaky, "/"))).toMatch(/degrad/i);
  });
});
