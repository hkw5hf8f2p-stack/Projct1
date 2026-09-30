/** SCORING_SPEC §14.1 (DEV-91): перевірка доказу friction міряє правдивість (текст є на сторінці), а не форму лапок. Кожне правило — з контролем. */
import { describe, expect, it } from "vitest";
import { QUOTE_MIN, extractQuoteSpans, normQuote, quoteLongEnough, verifyFrictionEvidence } from "../src/index.js";

// видимий текст сторінки (фрагменти fixture-shop); NBSP і перенос рядка — навмисно
const PAGE = [
  "ТехноДім Каталог Про нас Вийти",
  "Ідеї, що змінюють будні",
  "Ми підбираємо речі, які роблять день простішим. Заходьте й дивіться самі.",
  "AquaPro X200 (система HFX) Фільтр для води з проточною\nкухонною установкою. В кошик",
  "Пом’якшувач води для побутових потреб. Доставка — від 70 грн",
].join("\n");

const V = (evidence: string) => verifyFrictionEvidence(evidence, PAGE);

describe("verifyFrictionEvidence: прийняття дослівної цитати незалежно від лапок", () => {
  it.each([
    ["дослівна БЕЗ лапок (випадок DEV-88)", "Ми підбираємо речі, які роблять день простішим. Заходьте й дивіться самі."],
    ["подвійні лапки", '"Ми підбираємо речі, які роблять день простішим."'],
    ["«ялинки»", "«Ідеї, що змінюють будні»"],
    ["“англійські”", "“Фільтр для води з проточною кухонною установкою.”"],
    ["„німецькі“", "„AquaPro X200 (система HFX)“"],
    ["‘одинарні’", "‘AquaPro X200 (система HFX)’"],
    ["ASCII одинарні як обгортка", "'Ідеї, що змінюють будні'"],
    ["непарні різні лапки", "«Ідеї, що змінюють будні\""],
    ["інші пробіли / перенос рядка / регістр", "  фільтр ДЛЯ  води з проточною кухонною\tустановкою  "],
    ["NBSP у сторінці, пробіл у цитаті; тире", "Доставка - від 70 грн"],
    ["інший апостроф (’ на сторінці, ' у цитаті)", "Пом'якшувач води для побутових потреб"],
    ["три крапки в кінці (обрізана цитата)", "«Ми підбираємо речі, які роблять…»"],
    ["цитата в лапках + коментар моделі", "«Ідеї, що змінюють будні» — не зрозуміло, що продають"],
  ])("%s → прийнято", (_n, ev) => {
    const v = V(ev);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.kind).toBe("quote");
  });

  it("excerpt — текст моделі без обгорток (нормалізація лише для порівняння)", () => {
    expect(V("«Ідеї, що змінюють будні»")).toEqual({ ok: true, kind: "quote", excerpt: "Ідеї, що змінюють будні" });
    expect(V("Ідеї, що змінюють будні")).toEqual({ ok: true, kind: "quote", excerpt: "Ідеї, що змінюють будні" });
  });
});

describe("verifyFrictionEvidence: контролі — вигадане/перефразоване/коротке відхиляється", () => {
  it.each([
    ["перефраз без лапок", "Заголовок не пояснює, що продає магазин", "no_verifiable_evidence"],
    ["вигадана цитата в лапках", "«Безкоштовна доставка по всій Україні»", "quote_not_on_page"],
    ["вигадана цитата без лапок", "Безкоштовна доставка по всій Україні", "no_verifiable_evidence"],
    ["перефраз у лапках (слова змінено)", "«Ми обираємо речі, що роблять день легшим»", "quote_not_on_page"],
    ["одна з двох цитат вигадана", "«Ідеї, що змінюють будні» і «Найкращі ціни в місті»", "quote_not_on_page"],
    ["надто коротка в лапках: «В кошик»", "«В кошик»", "quote_too_short"],
    ["надто коротка без лапок: HFX", "HFX", "quote_too_short"],
    ["надто коротка з коментарем", "Кнопка \"В кошик\" без ціни поруч", "quote_too_short"],
    ["порожні лапки", "«»", "no_verifiable_evidence"],
  ])("%s → відхилено (%s)", (_n, ev, reason) => {
    expect(V(ev)).toEqual({ ok: false, reason });
  });

  it("та сама цитата приймається лише на своїй сторінці (корпус іншої сторінки → відхилено)", () => {
    expect(verifyFrictionEvidence("Ідеї, що змінюють будні", "Каталог AquaPro X200").ok).toBe(false);
    expect(verifyFrictionEvidence("«Ідеї, що змінюють будні»", "Каталог AquaPro X200")).toEqual({ ok: false, reason: "quote_not_on_page" });
  });
});

describe("NOT_FOUND — твердження відсутності (DEV-63), першим", () => {
  it("NOT_FOUND приймається як absence, навіть із короткою або відсутньою на сторінці цитатою всередині", () => {
    expect(V("NOT_FOUND: ціна товару")).toEqual({ ok: true, kind: "absence" });
    expect(V("not_found: вартість доставки")).toEqual({ ok: true, kind: "absence" });
    expect(V("NOT_FOUND: пояснення, що таке «HFX»")).toEqual({ ok: true, kind: "absence" });
  });
  it("контроль: порожній NOT_FOUND і NOT_FOUND не на початку — не absence", () => {
    expect(V("NOT_FOUND:   ").ok).toBe(false);
    expect(V("Ціни немає — NOT_FOUND: ціна").ok).toBe(false);
  });
});

describe("мінімальна довжина й нормалізація", () => {
  it("поріг: ≥ 12 символів або ≥ 3 слова", () => {
    expect(QUOTE_MIN).toEqual({ chars: 12, words: 3 });
    expect(quoteLongEnough(normQuote("купити"))).toBe(false);
    expect(quoteLongEnough(normQuote("в кошик"))).toBe(false);
    expect(quoteLongEnough(normQuote("від 70 грн"))).toBe(true); // 3 слова, 10 символів
    expect(quoteLongEnough(normQuote("Додати в кошик"))).toBe(true); // 14 символів
    expect(quoteLongEnough(normQuote("система HFX"))).toBe(false); // 11 символів, 2 слова
  });
  it("normQuote: NFKC, zero-width, апострофи, тире, пробіли", () => {
    expect(normQuote("Пом’якшувач води​ — ОК\n")).toBe("пом'якшувач води - ок");
  });
  it("апостроф ASCII усередині слова не рахується як лапки (спанів немає)", () => {
    expect(extractQuoteSpans("Пом'якшувач води для побутових потреб")).toEqual([]);
  });
});
