/**
 * S1a: захоплення §10, детермінований модуль детекторів, crawl, тайлінг. Кожен детектор показано на позитиві (shop),
 * негативі (shop-clean) і мутанті (один дефект виправлено). Браузер — secureLaunch (egress-проксі + шар 2).
 * Запуск: bash scripts/run-as-sitelens.sh pnpm test
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditFixture, launchForFixtures, runDenyListTest, runNonGetTest, type AuditRunCfg } from "../../../scripts/fixture-harness.js";
import { checkDefects, checkMutant, detectorIdsOf, evidenceKeyWithRegion, loadExpected } from "../src/audit/compare.js";
import { classifyLink, pickDiverseProducts, PRIORITY } from "../src/audit/crawl.js";
import { CTA_RE, PRICE_RE, SHIP_RE } from "../src/audit/patterns.js";
import { planTiles } from "../src/audit/tiles.js";
import type { Mutant } from "../../../fixtures/shop/server.js";
import type { SecureBrowser } from "../src/secure-launch.js";
import type { AuditResult } from "../src/audit/run-site.js";
import type { TilesManifest } from "../src/audit/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PORTS = { shop: 4310, clean: 4311, aux: 4312 };
const expected = loadExpected(path.join(ROOT, "fixtures/shop/EXPECTED.json"));

describe("предикати (юніт, без браузера)", () => {
  it("CTA_RE: ловить кнопки купівлі, не ловить інше; межі слова без \\b", () => {
    for (const ok of ["Додати в кошик", "В кошик", "до кошика", "Купити", "Купити зараз", "Buy now", "Add to cart", "Оформити замовлення"]) expect(CTA_RE.test(ok.trim()), ok).toBe(true);
    for (const no of ["Кошик", "Купитинг", "Каталог", "Надіслати", "Меню", "Додати коментар"]) expect(CTA_RE.test(no), no).toBe(false);
  });
  it("PRICE_RE: гривня з NBSP, $ з комами; не ловить розміри й моделі", () => {
    for (const ok of ["2 499 грн", "2 499 грн", "749 грн", "$1,299.00", "€ 12", "1299₴", "12.50 usd"]) expect(PRICE_RE.test(ok), ok).toBe(true);
    for (const no of ["AquaPro X200", "2400×1600", "12 годин", "потік 2 л/хв", "Тримає 12 год", "1–2 дні"]) expect(PRICE_RE.test(no), no).toBe(false);
  });
  it("SHIP_RE: слово доставки за межами \\p{L}", () => {
    for (const ok of ["Доставка Новою поштою", "Умови доставки", "Free shipping", "Delivery", "Укрпошта"]) expect(SHIP_RE.test(ok), ok).toBe(true);
    for (const no of ["Каталог", "Допомога", "Про нас", "Фільтр для води"]) expect(SHIP_RE.test(no), no).toBe(false);
  });
  it("тайли: висота вікна, перекриття, покриття до низу; коротка сторінка — без тайлів", () => {
    expect(planTiles(900, 1000, 150)).toEqual([]);
    const t = planTiles(2400, 1000, 150);
    expect(t[0]).toEqual({ y: 850, h: 1000 });
    const last = t[t.length - 1]!;
    expect(last.y + last.h).toBe(2400);
    for (let i = 1; i < t.length; i++) expect(t[i - 1]!.y + t[i - 1]!.h - t[i]!.y).toBeGreaterThanOrEqual(150 - 1);
  });
  it("пріоритети §13 і класифікація посилань", () => {
    expect(PRIORITY.homepage).toBe(1);
    expect(classifyLink("http://x/catalog", "Каталог")).toBe("shop_category");
    expect(classifyLink("http://x/product/a", "A")).toBe("product");
    expect(classifyLink("http://x/help/shipping", "Доставка й оплата")).toBe("shipping");
    expect(classifyLink("http://x/about", "Про нас")).toBe("about");
    expect(classifyLink("http://x/privacy", "Privacy")).toBe("legal");
    expect(PRIORITY.shop_category).toBeGreaterThan(PRIORITY.shipping);
    expect(PRIORITY.shipping).toBeGreaterThan(PRIORITY.about);
  });
  it("≤ 3 продукти: вибір різних, а не перших", () => {
    const c = ["AquaPro X200", "AquaPro X220", "AquaPro X240", "Softline S1", "Дерев'яна дошка"].map((n) => ({ url: `http://x/product/${n}`, name: n }));
    const p = pickDiverseProducts(c, 3).map((x) => x.name);
    expect(p).toHaveLength(3);
    expect(p).toContain("Softline S1");
    expect(p).toContain("Дерев'яна дошка");
  });
  it("M2 (немає циркулярності): код детекторів не містить data-fx і назв фікстури", () => {
    for (const f of ["detectors.ts", "patterns.ts", "page-scripts/extract.js", "page-scripts/signature.js"]) {
      const src = readFileSync(path.join(ROOT, "packages/browser/src/audit", f), "utf8");
      expect(src, f).not.toMatch(/data-fx|aquapro|softline|x200|ТехноДім|ЧистийДім|configure/i);
    }
  });
});

describe("аудит фікстур (браузер)", () => {
  let sb: SecureBrowser;
  const tmpDirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "sl-audit-"));
    tmpDirs.push(d);
    return d;
  };
  let baseDir: string;
  let base: AuditResult;
  const run = async (cfg: Partial<AuditRunCfg> & { site: "shop" | "clean" }) => {
    const r = await auditFixture({ sb, port: cfg.site === "shop" ? PORTS.shop : PORTS.clean, runDir: await tmp(), shots: false, ...cfg });
    return r.result;
  };

  beforeAll(async () => {
    sb = await launchForFixtures([PORTS.shop, PORTS.clean, PORTS.aux]);
    baseDir = await tmp();
    base = (await auditFixture({ sb, site: "shop", port: PORTS.shop, runDir: baseDir, shots: true, tiles: true, fxMarkers: true })).result;
  }, 240_000);
  afterAll(async () => {
    await sb?.close();
    await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("ПОЗИТИВ: 7/7 детермінованих дефектів, Evidence з відкритим artifact_reference, region у скриншоті й ∩ data-fx, VERIFIED", () => {
    const res = checkDefects(expected, baseDir, base.evidence, base.findings);
    const det = res.filter((r) => r.status !== "SKIP");
    expect(det).toHaveLength(7);
    for (const r of det) expect(r.failures, `№${r.id}`).toEqual([]);
    expect(res.filter((r) => r.status === "SKIP").map((r) => r.id)).toEqual([1, 3, 4]);
  }, 60_000);

  it("захоплення §10: усі поля, повнота G0-10, банер Reject → Close → Accept у доказах", () => {
    const p = base.captures.find((c) => c.path === "/product/aquapro-x200")!;
    for (const c of [p.D, p.M]) {
      expect(c.title).toContain("AquaPro");
      expect(c.meta_description).toBeTruthy();
      expect(c.headings[0]).toMatchObject({ level: 1 });
      expect(c.links.length).toBeGreaterThan(3);
      expect(c.buttons.length).toBeGreaterThan(0);
      expect(c.form_controls.length + c.forms.length).toBeGreaterThan(0);
      expect(c.images.length).toBeGreaterThan(0);
      expect(c.aria_snapshot).toContain("heading");
      expect(c.redirect_chain.at(-1)?.status).toBe(200);
      expect(c.http_status).toBe(200);
      expect(c.completeness).toMatchObject({ blocked_requests_count: 0, js_error_count: 0, banner_state: "closed", scroll_completed: true, capture_complete: true, incomplete_reasons: [] });
      // банер: першою натиснуто «Лише необхідні» (не Accept), і цього досить — Close/Accept не чіпали
      expect(c.banner.actions.map((a) => a.step)).toEqual(["reject"]);
      expect(c.banner.actions[0]).toMatchObject({ label: "Лише необхідні", clicked: true, hidden_after: true });
      for (const f of [c.screenshots.viewport.file, c.screenshots.fullpage.file, c.files.capture, c.files.network, c.files.axe]) expect(existsSync(path.join(baseDir, f)), f).toBe(true);
    }
    expect(p.D.screenshots.viewport.width_px).toBe(1440);
    expect(p.M.screenshots.viewport.width_px).toBe(780); // 390 × dpr 2
    const ev = base.evidence.find((e) => e.detector_id === "cta_below_fold")!;
    expect(ev.capture_context.banner_actions[0]?.step).toBe("reject");
  });

  it("тайлінг D4: перше вікно + тайли висотою вікна з перекриттям, файли й manifest існують", () => {
    const p = base.captures.find((c) => c.path === "/product/aquapro-x200")!;
    const m = JSON.parse(readFileSync(path.join(baseDir, p.M.files.dir, "tiles/manifest.json"), "utf8")) as TilesManifest;
    expect(m.tile_height_css).toBe(844);
    expect(m.overlap_css).toBeGreaterThan(0);
    expect(m.tiles.length).toBeGreaterThanOrEqual(2);
    for (const t of m.tiles) {
      expect(existsSync(path.join(baseDir, t.file))).toBe(true);
      expect(t.height_css).toBeLessThanOrEqual(844);
    }
    expect(existsSync(path.join(baseDir, m.first_viewport))).toBe(true);
    const last = m.tiles.at(-1)!;
    expect(last.y_css + last.height_css).toBe(m.full_height_css);
  });

  it("crawl: ≤ 12 сторінок, глибина ≤ 3, ≤ 3 продукти; deny-list URL не відкрито (пропуск залоговано)", () => {
    const c = base.crawl;
    expect(c.pages.length).toBeLessThanOrEqual(12);
    expect(Math.max(...c.log.map((l) => l.depth))).toBeLessThanOrEqual(3);
    expect(c.log.filter((l) => l.class === "product").length).toBeLessThanOrEqual(3);
    expect(c.log[0]).toMatchObject({ class: "homepage", depth: 0 });
    expect(c.skipped.filter((s) => s.reason === "deny_list").length).toBeGreaterThanOrEqual(5);
    expect(c.pages.map((p) => p.path)).toContain("/help/shipping");
    // послідовність пріоритетів: каталог раніше за «про нас»
    const order = c.pages.map((p) => p.path);
    expect(order.indexOf("/catalog")).toBeLessThan(order.indexOf("/about"));
  });

  it("depth_clicks №2 = 2 (/help → /help/shipping), price_depth_clicks — інформативні, не в предикаті", () => {
    const e = base.evidence.find((x) => x.detector_id === "shipping_depth")!;
    expect(e.measurement["depth_clicks"]).toBe(2);
    expect(String(e.measurement["shipping_found_via"])).toContain("/help → /help/shipping");
    const pe = base.evidence.find((x) => x.detector_id === "price_first_viewport" && x.page_path === "/product/aquapro-x200")!;
    expect(pe.measurement["price_depth_clicks"]).toBe(1);
  });

  it("НЕГАТИВ: shop-clean (≥ 3 чисті сторінки §57 + доставка + про нас) → 0 доказів і 0 знахідок на D і M", async () => {
    const r = await run({ site: "clean" });
    const paths = r.captures.map((c) => c.path);
    for (const p of ["/", "/catalog", "/shipping", "/about"]) expect(paths).toContain(p);
    expect(paths.filter((p) => p.startsWith("/product/")).length).toBeGreaterThanOrEqual(2);
    expect(r.captures.find((c) => c.path === "/catalog")!.page_type).toBe("category");
    expect(r.captures.filter((c) => c.page_type === "product").length).toBeGreaterThanOrEqual(2);
    expect(r.evidence).toEqual([]);
    expect(r.findings).toEqual([]);
    for (const c of r.captures) for (const v of [c.D, c.M]) expect(v.completeness.capture_complete, `${c.path} ${v.vp}`).toBe(true);
  }, 240_000);

  for (const d of expected.defects.filter((x) => x.mutant)) {
    it(`МУТАНТ ${d.mutant!.toUpperCase()} (№${d.id}): детектор ${detectorIdsOf(d).join("|")} мовчить, решта детекторів — той самий набір`, async () => {
      const r = await run({ site: "shop", mutant: d.mutant as Mutant });
      const res = checkMutant(d, base.evidence, r.evidence);
      expect(res.fixed_detector_evidence).toBe(0);
      expect(res.diff_added).toEqual([]);
      expect(res.diff_removed).toEqual([]);
      expect(res.status).toBe("PASS");
    }, 240_000);
  }

  it("СТАБІЛЬНІСТЬ: 3 прогони поспіль → ідентичний набір (id/селектор/регіон) і побайтово однакові evidence/findings", async () => {
    const a = await run({ site: "shop" });
    const b = await run({ site: "shop" });
    const sig = (r: AuditResult) => JSON.stringify(r.evidence.map(evidenceKeyWithRegion));
    expect(sig(a)).toBe(sig(base));
    expect(sig(b)).toBe(sig(base));
    expect(JSON.stringify(a.evidence)).toBe(JSON.stringify(base.evidence));
    expect(JSON.stringify(b.findings)).toBe(JSON.stringify(base.findings));
  }, 240_000);

  it("КОНТРОЛЬ DEV-17/19: один заблокований POST на завантаженні → відсутність ціни/доставки = HYPOTHESIS (ET-INC), не VERIFIED", async () => {
    const r = await run({ site: "shop", control: "post_on_load" });
    const abs = r.evidence.filter((e) => e.assertion === "absence");
    expect(abs.length).toBeGreaterThan(0);
    for (const e of abs) {
      expect(e.self_confirming).toBe(false);
      expect(e.capture_complete).toBe(false);
      expect(e.incomplete_reasons?.[0]).toMatch(/^blocked_requests:1$/);
    }
    for (const f of r.findings.filter((x) => /^(shipping|pricing)\|/.test(x.finding_key))) {
      expect(f.confidence).toBe("HYPOTHESIS");
      expect(f.evidence_strength).toBe(0.3);
    }
    // контраст: на базовій фікстурі ті самі знахідки VERIFIED
    expect(base.findings.filter((x) => /^(shipping|pricing)\|/.test(x.finding_key)).every((f) => f.confidence === "VERIFIED")).toBe(true);
  }, 240_000);

  it("КОНТРОЛЬ DEV-19: банер не закривається → cta_below_fold = ET-INC (HYPOTHESIS), incomplete_reasons=banner_open", async () => {
    const r = await run({ site: "shop", control: "banner_stuck" });
    const cta = r.evidence.filter((e) => e.detector_id === "cta_below_fold");
    expect(cta.length).toBeGreaterThan(0);
    for (const e of cta) {
      expect(e.self_confirming).toBe(false);
      expect(e.incomplete_reasons).toContain("banner_open");
    }
    expect(r.findings.filter((f) => f.finding_key.startsWith("cta|")).every((f) => f.confidence === "HYPOTHESIS")).toBe(true);
    const c = r.captures[0]!;
    expect(c.D.banner.actions.map((a) => a.step)).toEqual(["reject", "close", "accept"]); // всі три кроки спробувано
  }, 240_000);

  it("НЕ-GET: клік «в кошик» і «надіслати» → фікстура 0 не-GET, блоки залоговано; контроль без шару блоку дає не-GET", async () => {
    const rep = await runNonGetTest(sb, PORTS.aux);
    expect(rep.guarded.fixture_non_get).toBe(0);
    expect(rep.guarded.blocked_logged).toBeGreaterThanOrEqual(2);
    expect(rep.control_unguarded.fixture_non_get).toBeGreaterThanOrEqual(2);
    expect(rep.pass).toBe(true);
  }, 120_000);

  it("DENY-LIST: GET add-to-cart/logout/delete через crawl → 0 звернень; контроль (прямий GET) → 1 кожен", async () => {
    const rep = await runDenyListTest(sb, PORTS.aux, await tmp());
    expect(rep.crawl_hits).toEqual({ add_to_cart_get: 0, logout: 0, delete_action: 0 });
    expect(rep.control_direct_get).toEqual({ add_to_cart_get: 1, logout: 1, delete_action: 1 });
    expect(rep.skipped_by_crawl).toBeGreaterThan(0);
  }, 240_000);

  it("артефакти компактні: PNG ≤ 300 КБ, сумарно базового прогону ≤ 15 МБ", () => {
    let total = 0;
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = path.join(d, n);
        const s = statSync(f);
        if (s.isDirectory()) walk(f);
        else {
          total += s.size;
          if (n.endsWith(".png")) expect(s.size, f).toBeLessThanOrEqual(300 * 1024);
        }
      }
    };
    walk(baseDir);
    expect(total).toBeLessThanOrEqual(15 * 1024 * 1024);
  });
});
