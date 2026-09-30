/**
 * Виконавець журналів §19B/§20 на fixtures/shop (S4). Агент — scripted (доводить плумбінг, фільтр і облік, НЕ якість моделі: ⏭️ live pass).
 * 12 журналів (8–16): лог фікстури 0 не-GET, 0 GET add-to-cart/logout/delete від агента. Контроль без фільтра: ті самі кроки → GET доходять.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Evidence, SyntheticSession } from "../../schemas/src/index.js";
import { startShop } from "../../../fixtures/shop/server.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/_shared/server.js";
import { createShopCleanHandler } from "../../../fixtures/shop-clean/server.js";
import { artifactDir } from "../../../scripts/artifact-dir.js";
import { secureLaunch, type SecureBrowser } from "../src/secure-launch.js";
import { cartVerdict, runJourney, runJourneys, verifyFrictionEvidence, type AgentDecision, type AgentDriver, type JourneyResult, type JourneyTask } from "../src/agent/journey.js";

const ART = artifactDir("sprint-4/journeys");
let shop: FixtureServer;
let clean: FixtureServer;
let sb: SecureBrowser;

beforeAll(async () => {
  shop = await startShop({ port: 0 });
  clean = await startFixtureServer({ handler: createShopCleanHandler({ transforms: null }), port: 0 });
  sb = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [shop.origin, clean.origin] });
});
afterAll(async () => { await sb?.close(); await shop?.close(); await clean?.close(); });

const go = (action: string, target = ""): AgentDecision => ({ step: { action, target, reason_summary: "scripted", task_progress: "scripted", friction_detected: [], confidence: 0.5 }, result: null });
const stop = (success: "true" | "false" | "partial", frictions: NonNullable<AgentDecision["result"]>["frictions"] = [], action = "stop_success"): AgentDecision => ({
  step: { action, target: "", reason_summary: "done", task_progress: "done", friction_detected: [], confidence: 0.5 },
  result: { success, frictions, positive_signals: [], uncertainties: [], final_summary: "scripted summary" },
});
/** scripted-агент: n-й крок → n-те рішення; після кінця скрипта — stop_failure */
const scripted = (steps: AgentDecision[]): AgentDriver => async (obs) => steps[obs.step] ?? stop("false", [], "stop_failure");
const task = (id: string, task_type: string, max_actions?: number): JourneyTask => ({ id, name: id, goal: id, task_type, max_actions });
const L = (s: string) => `link:"${s}"`;

const CART_FULL = [go("click", L("Допомога")), go("click", L("Доставка й оплата")), go("click", L("Каталог")), go("click", L("AquaPro X200 (система HFX)")), go("click", L("Налаштувати комплектацію")), go("click", L("Назад до моделі")), go("click", 'button:"Додати в кошик"'), stop("true")];
const CART_QUICK = [go("click", L("Каталог")), go("click", L("AquaPro X200 (система HFX)")), go("click", 'button:"Додати в кошик"'), stop("true")];
const HOSTILE = [go("click", L("Вийти")), go("click", L("Каталог")), go("click", L("В кошик")), go("click", L("Очистити порівняння")), go("click", L("AquaPro X200 (система HFX)")), go("click", L("Прибрати з порівняння")), go("click", 'button:"Додати в кошик"'), stop("false", [], "stop_failure")];
const CONTROL = [go("click", L("Вийти")), go("back"), go("click", L("Каталог")), go("click", L("В кошик")), go("click", L("Очистити порівняння")), go("click", L("AquaPro X200 (система HFX)")), go("click", 'button:"Додати в кошик"'), stop("false", [], "stop_failure")];

const runDir = () => path.join(ART, "shop");
const opts = (over: Partial<Parameters<typeof runJourney>[0]> & Pick<Parameters<typeof runJourney>[0], "lens_id" | "task" | "driver">) => ({ secure: sb, startUrl: shop.origin + "/", runDir: runDir(), audit_run_id: "aud_s4", writeShots: false, ...over });

describe("пакет із 12 журналів на fixtures/shop", () => {
  let results: Array<JourneyResult | { session_id: string; error: string }> = [];
  const byId = (id: string) => results.find((r) => ("session" in r ? r.session.session_id : r.session_id) === id) as JourneyResult;
  beforeAll(async () => {
    const throwing: AgentDriver = async () => { throw new Error("LLM upstream 529"); };
    results = await runJourneys({
      secure: sb, startUrl: shop.origin + "/", runDir: runDir(), audit_run_id: "aud_s4", writeShots: true,
      plan: [
        { lens_id: "l1", task: task("t6", "add_to_cart"), driver: scripted(CART_FULL), startUrl: shop.origin + "/" },
        { lens_id: "l2", task: task("t6", "add_to_cart"), driver: scripted(CART_QUICK) },
        { lens_id: "l3", task: task("t6", "add_to_cart"), driver: scripted(HOSTILE) },
        { lens_id: "l4", task: task("t4", "delivery"), driver: scripted([go("click", L("Допомога")), go("click", L("Доставка й оплата")), stop("true", [
          { category: "shipping", severity: "low", evidence: '"Доставка Новою поштою: 1–2 дні, від 70 грн."', page_url: shop.origin + "/help/shipping" },
          { category: "trust", severity: "high", evidence: '"Безкоштовна доставка по всьому світу за 1 годину"', page_url: shop.origin + "/help/shipping" },
          { category: "pricing", severity: "medium", evidence: "просто погано", page_url: shop.origin + "/" },
          { category: "pricing", severity: "medium", evidence: "NOT_FOUND: total price with options", page_url: "http://nowhere.example/x" },
        ])]) },
        { lens_id: "l1", task: task("t2", "choose_between"), driver: scripted([go("click", L("Каталог")), go("click", L("AquaPro X200 (система HFX)")), go("back"), go("click", L("AquaPro X220 (система HFX)")), stop("partial")]) },
        { lens_id: "l2", task: task("t3", "total_price"), driver: scripted([go("click", L("Каталог")), go("click", L("AquaPro X200 (система HFX)")), go("click", L("Налаштувати комплектацію")), stop("true")]) },
        { lens_id: "l3", task: task("t5", "credibility"), driver: scripted([go("click", L("Про нас")), go("scroll", "down"), go("click", 'button:"Надіслати"'), go("click", 'textbox:"Ваше повідомлення"'), stop("partial")]) },
        { lens_id: "l4", task: task("t1", "understand_offering"), driver: scripted([stop("true")]) },
        { lens_id: "l1", task: task("t7", "other"), driver: scripted([go("submit_payment"), go("click", "x=120,y=340"), go("click", "//a[@href='/logout']"), go("scroll", "down")]) },
        { lens_id: "l2", task: task("t8", "other", 3), driver: scripted([go("scroll", "down"), go("scroll", "down"), go("scroll", "top"), go("scroll", "down"), go("scroll", "down")]) },
        { lens_id: "l3", task: task("t9", "other"), driver: throwing },
        { lens_id: "l4", task: task("t10", "other"), driver: scripted([go("click", L("Немає такого посилання")), go("click", L("Про нас")), go("back"), go("back"), go("back"), stop("partial")]) },
      ],
    });
  });

  it("12 журналів; жоден виняток не валить пакет; артефакти записані", () => {
    expect(results).toHaveLength(12);
    expect(results.filter((r) => "error" in r)).toEqual([]);
    for (const r of results as JourneyResult[]) for (const f of Object.values(r.files)) expect(existsSync(path.join(runDir(), f)), f).toBe(true);
  });

  it("ГОЛОВНЕ: лог фікстури — 0 не-GET, 0 GET add-to-cart/logout/delete, жодного рядка з audit_hint", () => {
    expect(shop.state).toEqual({ add_to_cart_get: 0, logout: 0, delete_action: 0, non_get: 0 });
    expect(shop.log.filter((r) => r.audit_hint !== null)).toEqual([]);
    expect(shop.log.every((r) => r.method === "GET")).toBe(true);
    expect(shop.log.length).toBeGreaterThan(20); // фікстура справді відвідувалась
  });

  it("hostile: усі шість пасток заблоковано з правилом, «В кошик» на сторінці товару — знайдено, не натиснуто", () => {
    const h = byId("l3__t6");
    const v = h.steps.map((s) => `${s.verdict}:${s.rule ?? ""}`);
    expect(v.slice(0, 7)).toEqual(["blocked:logout", "executed:", "blocked:add_to_cart", "blocked:delete", "executed:", "blocked:delete", "found_not_clicked:commercial_cta"]);
    expect(h.end_reason).toBe("stop_failure");
    expect(shop.log.some((r) => r.method === "POST")).toBe(false);
  });

  it("«кошик»: повний шлях (ціна + доставка відомі до кнопки) → true; швидкий (ні ціни, ні доставки) → partial; hostile-агент теж не бачить ціни/доставки → partial", () => {
    const full = byId("l1__t6"), quick = byId("l2__t6");
    expect(full.cart).toMatchObject({ button_found: true, reachable: true, price_known_before: true, shipping_known_before: true, success: "true", button_text: "Додати в кошик" });
    expect(full.session.success).toBe("true");
    expect(quick.cart).toMatchObject({ button_found: true, reachable: true, price_known_before: false, shipping_known_before: false, success: "partial" });
    // код переважає над самооцінкою агента: quick сказав stop_success/true, код каже partial
    expect(quick.session.success).toBe("partial");
    expect(quick.steps.at(-1)!.decision.action).toBe("stop_success");
    expect(byId("l3__t6").cart.success).toBe("partial");
  });

  it("friction: цитата, якої немає на побачених сторінках, і «просто погано» відкинуті кодом; NOT_FOUND і справжня цитата — прийняті", () => {
    const d = byId("l4__t4");
    expect(d.session.frictions.map((f) => f.category)).toEqual(["shipping", "pricing"]);
    expect(d.rejected_frictions.map((r) => r.reason)).toEqual(["quote_not_on_pages", "no_verifiable_evidence"]);
    // page_url поза побаченими → остання відвідана сторінка
    expect(d.session.frictions[1]!.page_url).toBe(shop.origin + "/help/shipping");
    expect(d.evidence.filter((e) => e.source_class === "SYNTHETIC")).toHaveLength(2);
  });

  it("невалідні рішення (submit_payment, координати, XPath) → invalid, 0 дій виконано, після 3 підряд журнал завершується", () => {
    const r = byId("l1__t7");
    expect(r.steps.map((s) => s.rule)).toEqual(["forbidden_action", "bad_target", "bad_target"]);
    expect(r.steps.every((s) => s.verdict === "invalid")).toBe(true);
    expect(r.end_reason).toBe("invalid_decisions");
    expect(r.session.actions_used).toBe(3);
  });

  it("ліміт кроків: maxSteps=3 → рівно 3 виконані дії, четверте рішення відхилено (step_limit)", () => {
    const r = byId("l2__t8");
    expect(r.end_reason).toBe("step_limit");
    expect(r.session.actions_used).toBe(3);
    expect(r.steps.at(-1)).toMatchObject({ verdict: "invalid", rule: "no_actions_left" });
    expect(r.session.success).toBe("false");
  });

  it("збій агента → сесія failed, success=false, решта журналів не постраждали (§48)", () => {
    const r = byId("l3__t9");
    expect(r.session.status).toBe("failed");
    expect(r.end_reason).toBe("driver_error");
    expect(r.session.success).toBe("false");
  });

  it("форма /about: кнопка «Надіслати» заблокована кодом (state_text), POST не відправлено; back на порожній історії = noop; not_found логується", () => {
    const r = byId("l3__t5");
    expect(r.steps[2]).toMatchObject({ verdict: "blocked", rule: "state_text" });
    expect(r.method_blocks).toBe(0); // до мережі POST навіть не дійшов
    const nf = byId("l4__t10");
    expect(nf.steps[0]).toMatchObject({ verdict: "not_found" });
  });

  it("0 дій для stop одразу: actions_used 0, кошик false", () => {
    const r = byId("l4__t1");
    expect(r.session.actions_used).toBe(0);
    expect(r.cart.success).toBe("false");
  });

  it("сесії й докази валідні за схемами @sitelens/schemas (SyntheticSession, Evidence); SYNTHETIC ніколи self_confirming", () => {
    for (const r of results as JourneyResult[]) {
      expect(SyntheticSession.safeParse(r.session).success, r.session.session_id + " " + JSON.stringify(SyntheticSession.safeParse(r.session).error?.issues)).toBe(true);
      for (const e of r.evidence) {
        const p = Evidence.safeParse(e);
        expect(p.success, e.id + " " + JSON.stringify(p.success ? "" : p.error.issues)).toBe(true);
        expect(e.self_confirming).toBe(false);
      }
    }
    const cartEv = byId("l1__t6").evidence.filter((e) => e.detector_id === "journey_cart_reachable");
    expect(cartEv).toHaveLength(1);
    expect(cartEv[0]).toMatchObject({ source_class: "OBSERVED", assertion: "presence", category: "cta" });
    // артефакт існує й читається
    const j = JSON.parse(readFileSync(path.join(runDir(), byId("l1__t6").files.journey), "utf8"));
    expect(j.steps).toHaveLength(byId("l1__t6").steps.length);
    expect(existsSync(path.join(runDir(), byId("l1__t6").steps[0]!.screenshot!))).toBe(true);
  });
});

describe("КОНТРОЛЬ без фільтра: ті самі дії доходять до фікстури (перевірка вміє впасти)", () => {
  it("__controlNoFilter → GET /logout, add-to-cart, action=delete у лозі; POST (кнопка «Додати в кошик») блокує лише шар 2 secureLaunch", async () => {
    const s2 = await startShop({ port: 0 });
    const sb2 = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [s2.origin] });
    try {
      const r = await runJourney({ secure: sb2, startUrl: s2.origin + "/", runDir: path.join(ART, "control"), audit_run_id: "aud_ctl", lens_id: "ctl", task: task("t6", "add_to_cart"), driver: scripted(CONTROL), writeShots: false, __controlNoFilter: true });
      expect(s2.state.logout).toBeGreaterThanOrEqual(1);
      expect(s2.state.add_to_cart_get).toBeGreaterThanOrEqual(1);
      expect(s2.state.delete_action).toBeGreaterThanOrEqual(1);
      expect(s2.state.non_get).toBe(0); // шар 2 (secureLaunch) — навіть без фільтра
      expect(r.method_blocks).toBeGreaterThanOrEqual(1);
      expect(sb2.blocked.some((b) => b.method === "POST" && /\/cart$/.test(b.url))).toBe(true);
      // ті самі кроки З фільтром на іншій фікстурі: жодного
      const s3 = await startShop({ port: 0 });
      const sb3 = await secureLaunch({ mode: "fixture", allowFixtureLoopback: true, fixtureOrigins: [s3.origin] });
      try {
        await runJourney({ secure: sb3, startUrl: s3.origin + "/", runDir: path.join(ART, "control-filtered"), audit_run_id: "aud_ctl", lens_id: "ctl", task: task("t6", "add_to_cart"), driver: scripted(CONTROL), writeShots: false });
        expect(s3.state).toEqual({ add_to_cart_get: 0, logout: 0, delete_action: 0, non_get: 0 });
        expect(sb3.blocked.filter((b) => b.kind === "method")).toEqual([]);
      } finally { await sb3.close(); await s3.close(); }
    } finally { await sb2.close(); await s2.close(); }
  });
});

describe("cartVerdict / verifyFrictionEvidence: чиста логіка (позитив і негатив)", () => {
  const c = (o = {}) => ({ text: "Add to cart", tag: "button", visible: true, disabled: false, hit: true, ...o });
  it("успіх лише коли кнопка доступна І ціна/доставка відомі до неї (або на тому ж кроці)", () => {
    expect(cartVerdict([{ url: "u", cart: [c()], price: true, ship: true }]).success).toBe("true");
    expect(cartVerdict([{ url: "u", cart: [c()], price: true, ship: false }]).success).toBe("partial");
    expect(cartVerdict([{ url: "u", cart: [c({ disabled: true })], price: true, ship: true }])).toMatchObject({ success: "partial", reachable: false });
    expect(cartVerdict([{ url: "u", cart: [c({ hit: false })], price: true, ship: true }]).reachable).toBe(false);
    expect(cartVerdict([{ url: "u", cart: [], price: true, ship: true }])).toMatchObject({ success: "false", button_found: false });
  });
  it("«до неї»: доставка знайдена ПІСЛЯ єдиної появи кнопки — не true; повернення до кнопки після доставки — true", () => {
    expect(cartVerdict([{ url: "a", cart: [c()], price: true, ship: false }, { url: "b", cart: [], price: false, ship: true }]).success).toBe("partial");
    expect(cartVerdict([{ url: "a", cart: [c()], price: true, ship: false }, { url: "b", cart: [], price: false, ship: true }, { url: "a", cart: [c()], price: true, ship: false }]).success).toBe("true");
  });
  it("цитата: точна — ок; змінена — відкинута; NOT_FOUND — ок; без лапок — відкинута", () => {
    const corpus = "Доставка Новою поштою:  1–2 дні,\nвід 70 грн.";
    expect(verifyFrictionEvidence({ category: "shipping", severity: "low", evidence: '"Доставка Новою поштою: 1–2 дні, від 70 грн."', page_url: "u" }, corpus).ok).toBe(true);
    expect(verifyFrictionEvidence({ category: "shipping", severity: "low", evidence: '"Доставка за 5 хвилин"', page_url: "u" }, corpus)).toEqual({ ok: false, reason: "quote_not_on_pages" });
    expect(verifyFrictionEvidence({ category: "shipping", severity: "low", evidence: "NOT_FOUND: cost", page_url: "u" }, corpus).ok).toBe(true);
    expect(verifyFrictionEvidence({ category: "shipping", severity: "low", evidence: "Доставка Новою поштою", page_url: "u" }, corpus)).toEqual({ ok: false, reason: "no_verifiable_evidence" });
  });
});

describe("shop-clean: той самий швидкий шлях", () => {
  it("журнал завершується без винятків; успіх «кошик» — за фактами сторінок (виміряно, не вгадано)", async () => {
    const r = await runJourney({ secure: sb, startUrl: clean.origin + "/", runDir: path.join(ART, "clean"), audit_run_id: "aud_s4", lens_id: "l1", task: task("t6", "add_to_cart"), driver: scripted(CART_QUICK), writeShots: false });
    expect(r.session.status).toBe("done");
    expect(clean.state).toEqual({ add_to_cart_get: 0, logout: 0, delete_action: 0, non_get: 0 });
    console.log("clean cart:", JSON.stringify(r.cart), r.steps.map((s) => s.verdict + ":" + (s.located?.name ?? "")).join(" | "));
  });
});
