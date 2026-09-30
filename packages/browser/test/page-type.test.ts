/**
 * Юніт-кейси класифікатора типу сторінки (planning/eval/page-type-tests.md §2), парсера цін і classifyLink (spec §6).
 * Чиста функція над полями захоплення (spec §7): без браузера. Кожен кейс будується з ознак, а не з розмітки фікстур.
 */
import { describe, expect, it } from "vitest";
import { classifyPageType, type View } from "../src/audit/classify.js";
import { applicability } from "../src/audit/detectors.js";
import { classifyLink, PRIORITY } from "../src/audit/crawl.js";
import { CTA_RE, urlCartHint, urlProductHint } from "../src/audit/patterns.js";
import { parsePrice, parsePrices } from "../src/audit/price-parser.js";
import type { CardGroup, InteractiveRow, PriceRow, Rect } from "../src/audit/types.js";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const NB = " ";
const LONG = "x".repeat(400);

function view(o: Partial<View> = {}): View {
  return {
    final_url: "https://shop.test/x",
    width: 1440,
    height: 1000,
    title: "Сторінка",
    headings: [{ level: 1, text: "Назва" }],
    links: [],
    images: [],
    interactive: [],
    text_nodes: [],
    visible_text: LONG,
    jsonld_types: [],
    jsonld_top: [],
    og_type: null,
    canonical: null,
    microdata_types: [],
    h1_count: 1,
    h1_rect: R(100, 100, 600, 40),
    main_rect: R(100, 80, 1100, 2400),
    card_groups: [],
    prices: [],
    autocomplete_tokens: [],
    details_count: 0,
    question_headings: 0,
    ship_paragraphs: 0,
    listing_controls: false,
    cart_rows: [],
    completeness: { http_status: 200, navigation_completed: true, visible_text_length: 1200 },
    ...o,
  };
}
const h1none: Partial<View> = { h1_count: 0, h1_rect: null, headings: [{ level: 2, text: "Назва" }] };
const btn = (name: string, o: Partial<InteractiveRow> = {}): InteractiveRow => ({
  selector: `#b-${name}`, tag: "button", name, rect: R(200, 1800, 170, 44), vis: 0, role: null, input_type: "submit", disabled: false, is_link: false, href: null, nav_target: false,
  bg_opaque: true, border: false, pad_y: 10, pad_x: 18, font_size: 16, landmark: "main", in_card: false, form: { method: "post", free_text: false, has_variants: false }, ...o,
});
const styledLink = (name: string, o: Partial<InteractiveRow> = {}): InteractiveRow => btn(name, { tag: "a", input_type: null, is_link: true, href: "https://shop.test/buy", form: null, ...o });
const media = (w: number, h: number, y = 160) => ({ selector: "img.g", src: "/g.svg", current_src: "https://shop.test/g.svg", alt: "x", natural_w: w, natural_h: h, rect: R(100, y, w, h), is_background: false, landmark: "main" as const, in_card: false });
const price = (text: string, value: number, o: Partial<PriceRow> = {}): PriceRow => ({ selector: `p.pr${value}`, value, currency: "UAH", text, rect: R(100, 160, 120, 34), font_size: 26, font_weight: 700, in_card: false, landmark: "main", prefix_from: false, ...o });
function cards(n: number, o: { y?: number; img?: boolean; price?: boolean; h?: number } = {}): CardGroup {
  const y = o.y ?? 260;
  const h = o.h ?? 150;
  const nodes = Array.from({ length: n }, (_, i) => R(100, y + i * (h + 16), 1100, h));
  return {
    signature: "li(div(h2(a),p),img)", count: n, rect: R(100, y, 1100, n * (h + 16)), nodes,
    with_img: o.img === false ? 0 : n, with_price: o.price ? n : 0, urls: nodes.map((_, i) => `https://shop.test/i/${i}`), names: nodes.map((_, i) => `Товар ${i}`),
  };
}
const cardPrices = (g: CardGroup): PriceRow[] => g.nodes.map((r, i) => price(`${100 + i} грн`, 100 + i, { rect: R(r.x + 200, r.y + 60, 90, 24), in_card: true, font_size: 18 }));
const ship = (t: string) => ({ t, a: false });

describe("classifyPageType: 20 кейсів page-type-tests.md §2", () => {
  it("1. P3(button у POST-формі, лише hidden)+lex, P4, P5 390×240 під h1, URL /product/x → product, P=5", () => {
    const c = classifyPageType(view({ final_url: "https://shop.test/product/x", interactive: [btn("Додати в кошик")], images: [media(390, 240)] }));
    expect(c.page_type).toBe("product");
    expect(c.scores.P).toBe(5);
  });
  it("2. як 1, URL /x-1001.html, CTA «Далі» без lex → product, P=4,5", () => {
    const c = classifyPageType(view({ final_url: "https://shop.test/x-1001.html", interactive: [btn("Далі")], images: [media(390, 240)] }));
    expect(c.page_type).toBe("product");
    expect(c.scores.P).toBe(4.5);
    expect(CTA_RE.test("Далі")).toBe(false);
  });
  it("3. P2 «1 200 грн» (NBSP) під h1, P3=<a> з фоном поруч із ціною (не lex), P5, плоский URL → product, P=6,5", () => {
    const c = classifyPageType(view({ final_url: "https://shop.test/aquapro.html", prices: [price(`1${NB}200${NB}грн`, 1200)], interactive: [styledLink("Перейти", { rect: R(240, 210, 180, 44) })], images: [media(390, 240, 270)] }));
    expect(c.page_type).toBe("product");
    expect(c.scores.P).toBe(6.5);
  });
  it("4. P4, P2, без P3/P5, URL /product/x/configure → other (P=3,5, без P1/P3)", () => {
    const c = classifyPageType(view({ final_url: "https://shop.test/product/x/configure", prices: [price("2 499 грн", 2499)] }));
    expect(c.page_type).toBe("other");
    expect(c.scores.P).toBe(3.5);
  });
  it("5. P4 + 3 картки (img+посилання+.btn «В кошик» у картці), без цін → category (K=4, P3=0)", () => {
    const g = cards(3);
    const c = classifyPageType(view({ card_groups: [g], interactive: [btn("В кошик", { in_card: true, rect: R(400, 300, 120, 40) })] }));
    expect(c.page_type).toBe("category");
    expect(c.scores.K).toBe(4);
    expect(c.per_view.D.primary).toBeNull();
  });
  it("6. 2 картки (img+посилання), без цін, URL без підказки → category (K=3)", () => {
    const c = classifyPageType(view({ card_groups: [cards(2)] }));
    expect(c.page_type).toBe("category");
    expect(c.scores.K).toBe(3);
  });
  it("6b. DEV-40: about з 3 картками «команда» (img+профіль, без цін, URL без підказок) → about, не category; контроль: ті самі картки поза about → category; картки з цінами на about → category", () => {
    const team = classifyPageType(view({ final_url: "https://shop.test/about", headings: [{ level: 1, text: "Про нас" }], card_groups: [cards(3)] }));
    expect(team.page_type).toBe("about");
    expect(team.features).toContain("Kteam_veto");
    expect(classifyPageType(view({ final_url: "https://shop.test/x", card_groups: [cards(3)] })).page_type).toBe("category");
    const gp = cards(3, { price: true });
    expect(classifyPageType(view({ final_url: "https://shop.test/about", headings: [{ level: 1, text: "Про нас" }], card_groups: [gp], prices: cardPrices(gp) })).page_type).toBe("category");
    const g = cards(3);
    g.urls = ["https://shop.test/product/a", "https://shop.test/product/b", "https://shop.test/product/c"];
    expect(classifyPageType(view({ final_url: "https://shop.test/about", headings: [{ level: 1, text: "Про нас" }], card_groups: [g] })).page_type).toBe("category");
  });
  it("7. 2 картки з цінами, без img → category (K=4)", () => {
    const g = cards(2, { img: false, price: true });
    const c = classifyPageType(view({ card_groups: [g], prices: cardPrices(g) }));
    expect(c.page_type).toBe("category");
    expect(c.scores.K).toBe(4);
  });
  it("8. кошик: h1 «Кошик», 1 рядок (кількість+ціна), сума = ціна рядка, кнопка «Оформити», URL kosh.html → cart (вето), а не product", () => {
    const row = price(`1${NB}200${NB}грн`, 1200, { rect: R(700, 260, 100, 24), font_weight: 400, font_size: 16 });
    const total = price(`1${NB}200${NB}грн`, 1200, { rect: R(300, 340, 110, 26), font_weight: 700 });
    const c = classifyPageType(
      view({ final_url: "https://shop.test/kosh.html", prices: [row, total], cart_rows: [{ price: 1200, rect: R(100, 250, 1000, 44), has_qty: true, has_remove: false }], interactive: [btn("Оформити", { rect: R(100, 400, 180, 44) })], text_nodes: [ship("Разом:")] }),
    );
    expect(c.page_type).toBe("cart");
    expect(c.per_view.D.P).toBeGreaterThanOrEqual(4); // за балами це був би product — саме випадок двійника-1
    expect(c.scores.C).toBeGreaterThanOrEqual(3.5);
  });
  it("9. форма з autocomplete email+tel+street-address, одна сума, submit → checkout", () => {
    const c = classifyPageType(view({ autocomplete_tokens: ["email", "tel", "street-address"], interactive: [btn("Підтвердити", { form: { method: "post", free_text: true, has_variants: false } })] }));
    expect(c.page_type).toBe("checkout");
    expect(c.scores.C).toBeGreaterThanOrEqual(2);
  });
  it("10. JSON-LD Product (верхній рівень), h1 відсутній (назва в h2), P2, P3 → product, P=7", () => {
    const c = classifyPageType(view({ ...h1none, jsonld_top: ["Product"], jsonld_types: ["Product"], prices: [price("2 499 грн", 2499, { rect: R(100, 100, 120, 34) })], interactive: [btn("Придбати", { rect: R(100, 160, 180, 44) })] }));
    expect(c.page_type).toBe("product");
    expect(c.scores.P).toBeGreaterThanOrEqual(7);
  });
  it("11. JSON-LD ItemList із 12 Product, 12 карток із цінами, пагінація → category (K=5,5, P1=0)", () => {
    const g = cards(12, { price: true, h: 80 });
    const c = classifyPageType(view({ card_groups: [g], prices: cardPrices(g), jsonld_types: ["ItemList", "Product"], jsonld_top: ["ItemList"], listing_controls: true }));
    expect(c.page_type).toBe("category");
    expect(c.scores.K).toBe(5.5);
    expect(c.features.some((f) => f.startsWith("P1"))).toBe(false);
  });
  it("12. product-ознаки (P2,P3,P4,P5) + 4 картки «Схожі» нижче P3 → product (правило 2)", () => {
    const g = cards(4, { y: 2100 });
    const c = classifyPageType(view({ final_url: "https://shop.test/z", prices: [price("2 499 грн", 2499)], interactive: [btn("Далі", { rect: R(100, 1800, 180, 44) })], images: [media(390, 240)], card_groups: [g] }));
    expect(c.page_type).toBe("product");
    expect(c.per_view.D.rule).toBe("2:product_over_category");
    expect(c.scores.K).toBeGreaterThanOrEqual(3);
  });
  it("13. is_home, 4 картки «Популярне», hero-зображення, без P3 → homepage", () => {
    const c = classifyPageType(view({ final_url: "https://shop.test/", card_groups: [cards(4)], images: [media(1440, 480, 0)] }));
    expect(c.is_home).toBe(true);
    expect(c.page_type).toBe("homepage");
  });
  it("14. is_home, JSON-LD Product, P2, P3 (односторінковий магазин) → product", () => {
    const c = classifyPageType(view({ final_url: "https://shop.test/", jsonld_top: ["Product"], prices: [price("990 грн", 990)], interactive: [btn("Купити", { rect: R(100, 210, 180, 44) })] }));
    expect(c.page_type).toBe("product");
    expect(c.scores.P).toBeGreaterThanOrEqual(8);
  });
  it("15. POST-форма з textarea+email, кнопка «Надіслати», h1 «Про нас» → about, P3=0", () => {
    const c = classifyPageType(view({ headings: [{ level: 1, text: "Про нас" }], interactive: [btn("Надіслати", { form: { method: "post", free_text: true, has_variants: false } })] }));
    expect(c.page_type).toBe("about");
    expect(c.per_view.D.primary).toBeNull();
  });
  it("16. 6 × details>summary, P4 → faq", () => {
    expect(classifyPageType(view({ details_count: 6 })).page_type).toBe("faq");
  });
  it("17. P3 = button «Далі» (форма без полів), img 120×120, без ціни, без P1 → unknown(product_likely), P=3; №2/№10 ET-INC, №5 ≤ HYPOTHESIS", () => {
    const c = classifyPageType(view({ interactive: [btn("Далі")], images: [media(120, 120)] }));
    expect(c.page_type).toBe("unknown");
    expect(c.reason).toBe("product_likely");
    expect(c.scores.P).toBe(3);
    for (const d of ["shipping_depth", "cta_below_fold", "price_first_viewport"] as const) expect(applicability(d, c.page_type, c.reason)).toBe("likely");
  });
  it("18. og:type=product, P4, P3 → product (P=6)", () => {
    const c = classifyPageType(view({ og_type: "product", interactive: [btn("Далі")] }));
    expect(c.page_type).toBe("product");
    expect(c.scores.P).toBe(6);
  });
  it("19. HTTP 200, visible_text_length = 90 (бот-стіна) → unknown(capture): утримання", () => {
    const c = classifyPageType(view({ completeness: { http_status: 200, navigation_completed: true, visible_text_length: 90 }, headings: [], h1_count: 0, h1_rect: null }));
    expect(c.page_type).toBe("unknown");
    expect(c.reason).toBe("capture");
    for (const d of ["shipping_depth", "cta_below_fold", "price_first_viewport"] as const) expect(applicability(d, c.page_type, c.reason)).toBe("withheld");
  });
  it("20. D: product (P=4,5); M: P3 прихована (P=2,5) → розбіжність D/M → unknown(product_likely)", () => {
    const D = view({ interactive: [btn("Далі")], images: [media(390, 240)] });
    const M = view({ width: 390, height: 844, images: [media(390, 240)], h1_rect: R(12, 100, 350, 40), main_rect: R(12, 80, 366, 2400) });
    const c = classifyPageType(D, M);
    expect(c.per_view.D.type).toBe("product");
    expect(c.per_view.M.P).toBeLessThan(4);
    expect(c.page_type).toBe("unknown");
    expect(c.reason).toBe("product_likely");
  });
});

describe("classifyPageType: додаткові правила spec", () => {
  it("сторінка «h1 + ціна» без P1/P3 ніколи не product за жодних балів", () => {
    const c = classifyPageType(view({ prices: [price("9 грн", 9)], images: [media(600, 400)], final_url: "https://shop.test/product/1001" }));
    expect(c.page_type).not.toBe("product");
  });
  it("штраф −3: група карток ≥ 40 % main вище P3 → category, а не product", () => {
    const g = cards(4, { y: 200, h: 480 });
    const c = classifyPageType(view({ card_groups: [g], interactive: [btn("Далі", { rect: R(100, 2400, 180, 44) })], images: [media(390, 240)] }));
    expect(c.page_type).toBe("category");
  });
  it("cart/checkout ніколи не product, навіть за P ≥ 4 і JSON-LD Product", () => {
    const c = classifyPageType(view({ jsonld_top: ["Product"], interactive: [btn("Оформити")], autocomplete_tokens: ["email", "tel"] }));
    expect(c.page_type).toBe("checkout");
  });
  it("незалежність від URL: та сама розмітка в 8 URL-формах дає той самий тип (product)", () => {
    for (const u of ["/product/x", "/p/1001", "/x-1001.html", "/index.php?id=7", "/index.php?route=product/product&product_id=1", "/dim/filtry/x/", "/PRODUCT/X", "/x/7f3a"]) {
      const c = classifyPageType(view({ final_url: `https://shop.test${u}`, interactive: [btn("Далі")], images: [media(390, 240)] }));
      expect(c.page_type, u).toBe("product");
    }
    expect(urlProductHint("https://shop.test/x/7f3a")).toBe(false);
    expect(urlProductHint("https://shop.test/p/1001")).toBe(true);
    expect(urlCartHint("https://shop.test/kosh.html")).toBe(true);
  });
  it("кнопка героя веде туди ж, куди пункт nav (навіть прихований на мобільному) → це навігація, не P3: D і M узгоджені (homepage)", () => {
    const hero = styledLink("Подивитися", { href: "https://shop.test/catalog", rect: R(16, 300, 132, 49), nav_target: false });
    const navLink = { href: "/catalog", abs: "https://shop.test/catalog", text: "Каталог", name: "Каталог", visible: true, rect: R(0, 0, 80, 20), selector: "nav a", landmark: "nav" as const, in_card: false, card_primary: false, has_counter: false };
    const D = view({ final_url: "https://shop.test/", interactive: [hero], links: [navLink], images: [media(1200, 400, 0)] });
    const M = view({ final_url: "https://shop.test/", width: 390, height: 844, interactive: [hero], links: [{ ...navLink, visible: false }], images: [media(358, 239, 0)] });
    const c = classifyPageType(D, M);
    expect(c.per_view.D.type).toBe("homepage");
    expect(c.per_view.M.type).toBe("homepage");
    expect(c.page_type).toBe("homepage");
  });
  it("без жодної структурної ознаки (лише h1) → other, не product", () => {
    expect(classifyPageType(view({})).page_type).toBe("other");
  });
  it("info_shipping за SHIP_RE у h1; about за словником лише як інфо-тип", () => {
    expect(classifyPageType(view({ headings: [{ level: 1, text: "Доставка й оплата" }] })).page_type).toBe("info_shipping");
  });
});

describe("парсер цін (10 форматів + не-ціни)", () => {
  const ok: Array<[string, number, string]> = [
    ["2 499 грн", 2499, "UAH"],
    [`2${NB}499${NB}грн`, 2499, "UAH"],
    ["2 499 грн", 2499, "UAH"],
    ["₴2499", 2499, "UAH"],
    ["2.499,00 €", 2499, "EUR"],
    ["€2,499.00", 2499, "EUR"],
    ["£2,499", 2499, "GBP"],
    ["$24.99", 24.99, "USD"],
    ["2 499,00 zł", 2499, "PLN"],
    ["2 499 UAH", 2499, "UAH"],
  ];
  for (const [s, v, cur] of ok)
    it(`ціна: ${JSON.stringify(s)}`, () => {
      const p = parsePrice(s);
      expect(p?.value).toBe(v);
      expect(p?.currency).toBe(cur);
      expect(p?.prefix_from).toBe(false);
    });
  it("префікс «від» → prefix_from", () => {
    const p = parsePrice("від 1 200 грн");
    expect(p?.value).toBe(1200);
    expect(p?.prefix_from).toBe(true);
    expect(parsePrice("from $9.99")?.prefix_from).toBe(true);
  });
  it("не ціна: рік, телефон, дата, «30 днів», відсоток, рейтинг", () => {
    for (const s of ["2026", "+380 67 123 45 67", "12.10.2026", "30 днів", "-15 %", "4.8 (120 відгуків)"]) expect(parsePrices(s), s).toEqual([]);
  });
});

describe("classifyLink (spec §6): клас із контексту сторінки-джерела", () => {
  it("посилання в групі карток → product 0,95 (навіть без URL-підказки)", () => {
    const c = classifyLink({ url: "https://shop.test/zzz", text: "Чайник", landmark: "main", card_primary: true });
    expect(c.cls).toBe("product");
    expect(c.priority).toBe(0.95);
  });
  it("пункт nav «Товари» без URL-підказки → shop_category 0,90", () => {
    const c = classifyLink({ url: "https://shop.test/x/y", text: "Товари", landmark: "nav" });
    expect(c.cls).toBe("shop_category");
    expect(c.priority).toBe(0.9);
  });
  it("найпомітніше посилання в main головної → shop_category 0,95", () => {
    expect(classifyLink({ url: "https://shop.test/k", text: "Дивитись", landmark: "main", prominent_home: true }).priority).toBe(0.95);
  });
  it("/kosh.html або іконка з лічильником → cart 0,10 (ніколи product, навіть у картці)", () => {
    expect(classifyLink({ url: "https://shop.test/kosh.html", text: "Кошик", landmark: "nav" })).toMatchObject({ cls: "cart", priority: 0.1 });
    expect(classifyLink({ url: "https://shop.test/z", text: "3", landmark: "header", has_counter: true }).cls).toBe("cart");
    expect(classifyLink({ url: "https://shop.test/cart", text: "x", landmark: "main", card_primary: true }).cls).toBe("cart");
  });
  it("/p/1001 поза картками й nav → other 0,30 (+0,05 URL)", () => {
    const c = classifyLink({ url: "https://shop.test/p/1001", text: "Новинка", landmark: "main" });
    expect(c.cls).toBe("other");
    expect(c.priority).toBeCloseTo(0.35, 5);
    expect(classifyLink({ url: "https://shop.test/n", text: "Новинка", landmark: "main" }).priority).toBeCloseTo(0.3, 5);
  });
  it("інфо-словник і пріоритети: корінь 1,0; доставка > faq > about > contact > blog > legal", () => {
    expect(classifyLink({ url: "https://shop.test/", text: "Головна", landmark: "header" }).priority).toBe(1);
    const p = (u: string, t: string) => classifyLink({ url: `https://shop.test${u}`, text: t, landmark: "nav" }).priority;
    expect(p("/help/shipping", "Доставка й оплата")).toBe(PRIORITY.shipping);
    expect(p("/help", "Допомога")).toBe(PRIORITY.faq);
    expect(p("/about", "Про нас")).toBe(PRIORITY.about);
    expect(p("/kontakt", "Kontakt")).toBe(PRIORITY.contact);
    expect(p("/privacy", "Privacy")).toBe(PRIORITY.legal);
    expect(PRIORITY.shipping).toBeGreaterThan(PRIORITY.faq);
  });
});
