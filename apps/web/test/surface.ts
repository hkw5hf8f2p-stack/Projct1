/** Детектори якості поверхні (виконуються в браузері). Кожен — з контролем на позитивному випадку в e2e. */
import type { Page } from "playwright";

/** твердження без мітки класу: `[data-claim]` без `[data-class-badge]` усередині */
export const unlabeledClaims = (page: Page): Promise<number> =>
  page.evaluate(() => [...document.querySelectorAll("[data-claim]")].filter((c) => !c.querySelector("[data-class-badge]")).length);

export const claimCount = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll("[data-claim]").length);

/** «сирий» текст звіту поза [data-claim-text]: скільки разів рядок є в тексті main більше, ніж у мічених твердженнях */
export const orphanTexts = (page: Page, rendered: string[]): Promise<string[]> =>
  page.evaluate((list) => {
    const main = document.querySelector("main");
    if (!main) return list;
    const body = main.textContent ?? "";
    const claims = [...main.querySelectorAll("[data-claim-text]")].map((e) => e.textContent ?? "");
    const count = (h: string, n: string) => (n ? h.split(n).length - 1 : 0);
    const inClaims = claims.join("\u0001");
    return list.filter((s) => count(body, s) > count(inClaims, s));
  }, rendered);

export const overflowX = (page: Page): Promise<number> =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.documentElement.clientWidth));

/** «undefined», «NaN», «[object», сирий JSON, необроблений ключ i18n */
export const badStrings = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const t = document.querySelector("main")?.textContent ?? "";
    const out: string[] = [];
    for (const [name, re] of [["undefined", /\bundefined\b/], ["NaN", /\bNaN\b/], ["object", /\[object /], ["json", /\{"[a-z_]+":/], ["i18n-key", /\b(?:tab|findings|overview|cost|technical|lenses|journey|progress|error|landing|evidence|lightbox|class|conf|priority|disc|banner|stage|cat|common)\.[a-z_]+(?:\.[a-z_]+)*\b/]] as const) if (re.test(t)) out.push(name);
    return out;
  });

/** текст для guard: мічені твердження без цитат сайту (SCORING_SPEC §7.5) */
export const claimTexts = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll("[data-claim]:not([data-quote]) [data-claim-text]")].map((e) => e.textContent ?? ""));

/** увесь текст main без цитат сайту й без фіксованих дисклеймерів-заперечень (їхній текст — каталог контракту, звірений тестом дрейфу; guard призначений для LLM-тексту). Решта — разом із підписами UI, суворіше за перевірку лише тверджень */
export const mainTextNoQuotes = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const m = document.querySelector("main");
    if (!m) return "";
    const c = m.cloneNode(true) as HTMLElement;
    c.querySelectorAll("[data-quote], [data-disclaimer], [data-synthetic-caveat]").forEach((e) => e.remove());
    return c.innerText ?? c.textContent ?? "";
  });

export const disclaimersPresent = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll("[data-disclaimer]")].map((e) => e.getAttribute("data-disclaimer") ?? ""));

export async function expandAll(page: Page): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const b = page.locator('main button[aria-expanded="false"]').first();
    if ((await b.count()) === 0) break;
    await b.click();
  }
}
