/**
 * S5 e2e (§54: submit → progress → report → finding → evidence) + власні детектори на відрендереному UI.
 * Працює на записаних фікстурних звітах (SITELENS_SOURCE=fixture). Артефакти — лише з SL_WRITE_ARTIFACTS=1.
 * Жодна з перевірок не доводить якість звіту на живому сайті або LLM-вкладок: ⏭️ live pass / OQ-1.
 */
import fs from "node:fs";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTextField } from "../../../packages/llm/src/guards/text.ts";
import { collectTexts, renderText } from "../../../packages/schemas/src/report-text.ts";
import { artifactDir, writeArtifacts } from "../../../scripts/artifact-dir.ts";
import { ERROR_CLASSES, REPORT_VARIANTS, reportVariant } from "../src/dev/fixtures";
import { PORT, TABS, closeBrowser, listenAddress, newCtx, open, pageErrors, startWeb, stopWeb, type Env } from "./harness";
import { badStrings, claimCount, claimTexts, disclaimersPresent, expandAll, mainTextNoQuotes, orphanTexts, overflowX, unlabeledClaims } from "./surface";

/* eslint-disable @typescript-eslint/no-explicit-any */
const OUT = artifactDir("sprint-5");
const summary: Record<string, unknown> = {};
const save = (name: string, data: unknown) => {
  if (!writeArtifacts()) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
};
const shotPath = (name: string) => {
  fs.mkdirSync(path.join(OUT, "screens"), { recursive: true });
  return path.join(OUT, "screens", name);
};

const T = 20 * 60_000;
const VARIANT_ID: Record<string, string> = { completed: "fx_completed", nollm: "fx_nollm", clean: "fx_clean", partial: "fx_partial", budget: "fx_budget", early: "fx_early" };
const ENVS: Env[] = [
  { width: 1440, theme: "light", lang: "uk" }, { width: 1440, theme: "dark", lang: "uk" },
  { width: 390, theme: "light", lang: "uk" }, { width: 390, theme: "dark", lang: "uk" },
];
const envName = (e: Env) => `${e.width}-${e.theme}-${e.lang}`;

/** обов'язкові дисклеймери на вкладці (критерій 4) */
const REQUIRED: Record<string, string[]> = {
  lenses: ["lenses_not_population_shares"],
  technical: ["automated_a11y_not_wcag_audit"],
  experiments: ["synthetic_preference_not_uplift"],
  findings: ["priority_is_ranking_index", "no_conversion_prediction"],
  overview: ["no_conversion_prediction"],
};

async function gotoTab(page: any, tab: string) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.getByTestId(`panel-${tab}`).waitFor();
}
async function waitReport(page: any) {
  await page.getByTestId("report").waitFor({ timeout: 30_000 });
}

beforeAll(async () => {
  await startWeb();
}, 120_000);
afterAll(async () => {
  await closeBrowser();
  stopWeb();
  save("e2e-summary.json", summary);
});

describe("процес і мережа", () => {
  it("критерій 9: next dev слухає лише 127.0.0.1 (lsof)", () => {
    const out = listenAddress();
    expect(out).toContain(`127.0.0.1:${PORT}`);
    expect(out).not.toMatch(/\*:\d+|0\.0\.0\.0:\d+/);
    summary["lsof"] = out.split("\n").slice(0, 3);
  });
});

describe("e2e §54: лендінг → прогрес → звіт → знахідка → доказ із регіоном", () => {
  for (const run of [1, 2, 3]) {
    it(`прогін ${run}/3`, async () => {
      const ctx = await newCtx({ width: 1440, theme: "light", lang: "en" });
      const page = await open(ctx, "/");
      await page.getByTestId("url-input").fill("https://shop.example/");
      await page.getByRole("button", { name: "Analyze website" }).click();
      // прогрес: 8 кроків §43, хоча б один крок видно у стані running/done, потім перехід у звіт
      await page.getByTestId("progress").waitFor({ timeout: 20_000 });
      expect(await page.locator("[data-step]").count()).toBe(8);
      if (run === 1 && writeArtifacts()) await page.screenshot({ path: shotPath("e2e-progress-1440-light-en.png") });
      await waitReport(page);
      await gotoTab(page, "findings");
      const first = page.getByTestId("finding").first();
      await first.locator("[data-confidence]").first().waitFor({ state: "visible" });
      expect(await first.getAttribute("data-priority")).toMatch(/^\d+$/);
      await first.getByTestId("toggle-details").click();
      await first.getByTestId("open-evidence").first().click();
      const lb = page.getByTestId("lightbox");
      await lb.waitFor();
      await page.locator('[data-testid="lightbox"][data-state="loaded"]').waitFor({ timeout: 15_000 });
      await page.getByTestId("region").waitFor({ state: "visible" });
      const nat = await page.locator(".shot img").evaluate((i: HTMLImageElement) => i.naturalWidth);
      expect(nat).toBeGreaterThan(300);
      if (run === 1 && writeArtifacts()) await page.screenshot({ path: shotPath("e2e-lightbox-region-1440-light-en.png") });
      await page.keyboard.press("Escape");
      await lb.waitFor({ state: "detached" });
      expect(pageErrors(page)).toEqual([]);
      await ctx.close();
    }, 120_000);
  }
});

describe("лендінг: помилки (§48) і стани", () => {
  it("порожній ввід, javascript:, SSRF-адреса (відповідь API), rate limit; кнопка повертається", async () => {
    const ctx = await newCtx({ width: 390, theme: "light", lang: "uk" });
    const page = await open(ctx, "/");
    const err = page.getByTestId("url-error");
    const cases: Array<[string, RegExp]> = [
      ["", /Введіть адресу/], ["javascript:alert(1)", /http:\/\/ і https:\/\//], ["http://127.0.0.2/", /не дозволена|недійсна/],
      ["http://169.254.169.254/latest", /не дозволена|недійсна/], ["https://ratelimit.example", /забагато аудитів/],
    ];
    for (const [v, re] of cases) {
      await page.getByTestId("url-input").fill(v);
      await page.getByTestId("analyze").click();
      await err.waitFor({ state: "visible" });
      expect(await err.textContent()).toMatch(re);
      expect(await page.getByTestId("url-input").getAttribute("aria-invalid")).toBe("true");
      await page.getByTestId("analyze").waitFor({ state: "visible" });
    }
    expect(await overflowX(page)).toBe(0);
    if (writeArtifacts()) await page.screenshot({ path: shotPath("landing-error-390-light-uk.png") });
    await ctx.close();
  });
  it("DEV-93: перемикач режиму з поясненням; типово повний (mode не надсилається), «швидкий» → mode: quick у POST", async () => {
    const ctx = await newCtx({ width: 390, theme: "light", lang: "uk" });
    const page = await open(ctx, "/");
    expect(await page.getByTestId("mode-full").locator("input").isChecked()).toBe(true);
    expect(await page.getByTestId("mode-quick").textContent()).toMatch(/до 6 сторінок.*до 2 подорожей/i);
    expect(await overflowX(page)).toBe(0);
    const bodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/dev/audits", async (r) => { if (r.request().method() === "POST") bodies.push(r.request().postDataJSON()); await r.continue(); });
    await page.getByTestId("url-input").fill("https://mode-default.example");
    await page.getByTestId("analyze").click();
    await page.getByTestId("progress").waitFor({ timeout: 20_000 });
    await page.goBack();
    await page.getByTestId("mode-quick").click();
    await page.getByTestId("url-input").fill("https://mode-quick.example");
    await page.getByTestId("analyze").click();
    await page.getByTestId("progress").waitFor({ timeout: 20_000 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("mode");
    expect(bodies[1]).toMatchObject({ mode: "quick" });
    await ctx.close();
  });
  it("завантаження: кнопка disabled з «Запускаємо…» під час сабміту", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/");
    await page.route("**/api/dev/audits", async (r) => {
      await new Promise((x) => setTimeout(x, 800));
      await r.continue();
    });
    await page.getByTestId("url-input").fill("https://queued.example");
    await page.getByTestId("analyze").click();
    expect(await page.getByTestId("analyze").isDisabled()).toBe(true);
    expect(await page.getByTestId("analyze").textContent()).toMatch(/Запускаємо/);
    await ctx.close();
  });
});

describe("прогрес і помилки аудиту", () => {
  it("queued / running / running_partial", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    let p = await open(ctx, "/audit/fx_queued");
    await p.getByTestId("progress").waitFor();
    expect(await p.locator('[data-state="running"]').count()).toBe(0);
    expect(await p.getByTestId("progress-summary").textContent()).toMatch(/черзі/);
    p = await open(ctx, "/audit/fx_running");
    await p.getByTestId("progress").waitFor();
    expect(await p.locator('[data-state="done"]').count()).toBeGreaterThan(3);
    expect(await p.locator('[data-state="running"]').count()).toBe(1);
    p = await open(ctx, "/audit/fx_running_partial");
    await p.getByTestId("progress-partial").waitFor();
    expect(await p.locator('[data-step="technical"]').getAttribute("data-state")).toBe("failed");
    await ctx.close();
  });
  it("DEV-92: лічильник і прогрес-бар під активним етапом; «≈ N хв лишилось» лише коли є дані; «працює N хв» інакше; uk/en", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    let p = await open(ctx, "/audit/fx_running");
    await p.getByTestId("progress").waitFor();
    const lenses = p.locator('[data-step="lenses"]');
    expect(await lenses.getAttribute("data-state")).toBe("running");
    expect(await lenses.locator('[data-counter="lenses"]').textContent()).toMatch(/8 \/ ≤12 лінз/);
    expect(await lenses.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("67");
    expect(await lenses.getByTestId("step-elapsed").textContent()).toMatch(/працює 3 хв/);
    expect(await lenses.getByTestId("step-eta").count()).toBe(0); // ETA невідомий → не вигадується
    expect(await p.locator('[data-step="crawl"] [data-testid="step-progress"]').count()).toBe(0); // завершені кроки без лічильників
    p = await open(ctx, "/audit/fx_running_journeys");
    await p.getByTestId("progress-quick").waitFor();
    const j = p.locator('[data-step="journeys"]');
    expect(await j.locator('[data-counter="snapshot_sessions"]').textContent()).toMatch(/5 \/ 12 синтетичних сесій \(≈ 7 хв лишилось\)/);
    expect(await j.locator('[data-counter="journals"]').textContent()).toMatch(/0 \/ 2 подорожей/);
    expect(await j.locator('[data-counter="journals"]').textContent()).not.toMatch(/лишилось/); // у журналів даних для ETA ще нема
    expect(await j.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(await overflowX(p)).toBe(0);
    await ctx.close();
    const en = await newCtx({ width: 390, theme: "dark", lang: "en" });
    p = await open(en, "/audit/fx_running_journeys");
    await p.getByTestId("progress-quick").waitFor();
    expect(await p.locator('[data-step="journeys"] [data-counter="snapshot_sessions"]').textContent()).toMatch(/5 \/ 12 synthetic sessions \(≈ 7 min left\)/);
    expect(await overflowX(p)).toBe(0);
    await en.close();
  });
  it("12 класів §48: кожен показує клас, переклад і НЕ показує звіт/фабрикацію", async () => {
    const ctx = await newCtx({ width: 390, theme: "light", lang: "en" });
    for (const c of ERROR_CLASSES) {
      const p = await open(ctx, `/audit/fx_failed_${c}`);
      const e = p.getByTestId("audit-error");
      await e.waitFor();
      expect(await e.getAttribute("data-error-class")).toBe(c);
      expect(await p.getByTestId("report").count()).toBe(0);
      const txt = (await e.textContent()) ?? "";
      expect(txt).toContain("No analysis is shown");
      expect(txt).not.toMatch(/error\.[a-z_]+/);
      expect(await overflowX(p)).toBe(0);
      await p.close();
    }
    await ctx.close();
  });
  it("звіт недоступний (500), звіту немає (404), невідомий аудит, невалідна схема, loading-скелет", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    let p = await open(ctx, "/audit/fx_report_500");
    await p.getByTestId("report-unavailable").waitFor();
    p = await open(ctx, "/audit/fx_report_404");
    await p.getByTestId("report-unavailable").waitFor();
    p = await open(ctx, "/audit/fx_unknown_id");
    await p.getByTestId("audit-error").waitFor();
    expect(await p.getByTestId("audit-error").getAttribute("data-error-class")).toBe("not_found");
    p = await open(ctx, "/audit/fx_bad_schema");
    await p.getByTestId("report-bad-schema").waitFor();
    p = await open(ctx, "/audit/fx_slow");
    await p.getByTestId("report-loading").waitFor();
    await waitReport(p);
    await ctx.close();
  });
  it("ACCESS_TOKEN: 401 → форма токена → неправильний токен відхилено → правильний відкриває звіт", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const p = await open(ctx, "/audit/fx_locked");
    await p.getByTestId("token-prompt").waitFor();
    await p.getByLabel("ACCESS_TOKEN").fill("wrong");
    await p.getByRole("button", { name: /Зберегти токен/ }).click();
    await p.getByText("Токен не прийнято.").waitFor();
    await p.getByLabel("ACCESS_TOKEN").fill("fixture-token");
    await p.getByRole("button", { name: /Зберегти токен/ }).click();
    await waitReport(p);
    expect(await p.evaluate(() => JSON.stringify(localStorage) + document.cookie)).not.toContain("fixture-token");
    await ctx.close();
  });
});

describe("критерії 2–4 на всіх заповнених станах: мітки, overflow, guard, дисклеймери", () => {
  const rowsAll: any[] = [];
  for (const v of REPORT_VARIANTS) {
    for (const env of ENVS) {
      it(`${v} × ${envName(env)}: 7 вкладок`, async () => {
        const report = reportVariant(v)!;
        const rendered = collectTexts(report).map((t) => renderText(t.text as any, report, (t.text as unknown as { lang: string }).lang as any)).filter((s) => s.length >= 14);
        const ctx = await newCtx(env);
        const page = await open(ctx, `/audit/${VARIANT_ID[v]}`);
        await waitReport(page);
        for (const tab of TABS) {
          await gotoTab(page, tab);
          if (tab === "findings" || tab === "journey" || tab === "evidence") await expandAll(page);
          const row: any = { variant: v, env: envName(env), tab };
          row.claims = await claimCount(page);
          row.unlabeled = await unlabeledClaims(page);
          row.orphans = await orphanTexts(page, rendered);
          row.overflow = await overflowX(page);
          row.bad = await badStrings(page);
          const texts = await claimTexts(page);
          row.guardIssues = texts.flatMap((t) => checkTextField("finding_text", t, "")).concat(checkTextField("finding_text", await mainTextNoQuotes(page), ""));
          row.disclaimers = await disclaimersPresent(page);
          row.missingDisclaimers = (REQUIRED[tab] ?? []).filter((d) => !row.disclaimers.includes(d));
          if (report.audit.llm_mode === "none" && ["overview", "lenses", "journey", "findings"].includes(tab)) if (!row.disclaimers.includes("no_llm_mode")) row.missingDisclaimers.push("no_llm_mode");
          if (tab === "findings" && report.findings.length > 0 && env.width === 1440) row.hasSyntheticCaveats = await page.locator("[data-synthetic-count]").evaluateAll((els) => els.every((e) => !!e.querySelector("[data-synthetic-caveat]")));
          rowsAll.push(row);
          if (writeArtifacts() && (v === "completed" || tab === "overview")) await page.screenshot({ path: shotPath(`${v}-${tab}-${envName(env)}.png`) });
        }
        expect(pageErrors(page)).toEqual([]);
        await ctx.close();
      }, T);
    }
  }
  it("свод: 0 без мітки, 0 сирих текстів, 0 overflow, 0 guard, 0 бракуючих дисклеймерів, 0 undefined/NaN", () => {
    const sum = (f: (r: any) => number) => rowsAll.reduce((a, r) => a + f(r), 0);
    const agg = {
      surfaces: rowsAll.length, claims: sum((r) => r.claims), unlabeled: sum((r) => r.unlabeled), orphans: sum((r) => r.orphans.length),
      overflow390: rowsAll.filter((r) => r.env.startsWith("390")).reduce((a, r) => a + (r.overflow > 0 ? 1 : 0), 0), overflowAny: sum((r) => (r.overflow > 0 ? 1 : 0)),
      guardIssues: sum((r) => r.guardIssues.length), missingDisclaimers: sum((r) => r.missingDisclaimers.length), bad: sum((r) => r.bad.length),
      syntheticCountsWithoutCaveat: rowsAll.filter((r) => r.hasSyntheticCaveats === false).length,
    };
    summary["quality"] = agg;
    save("quality-rows.json", rowsAll);
    const bad = rowsAll.filter((r) => r.unlabeled || r.orphans.length || r.overflow || r.guardIssues.length || r.missingDisclaimers.length || r.bad.length || r.hasSyntheticCaveats === false);
    expect(bad.map((r) => ({ v: r.variant, e: r.env, t: r.tab, u: r.unlabeled, o: r.orphans.slice(0, 2), ov: r.overflow, g: r.guardIssues.slice(0, 2), md: r.missingDisclaimers, b: r.bad }))).toEqual([]);
    expect(agg.surfaces).toBe(REPORT_VARIANTS.length * ENVS.length * 7);
    expect(agg.claims).toBeGreaterThan(1000);
  });
});

describe("контролі: детектори вміють падати (позитивний випадок)", () => {
  it("мітка, сирий текст, overflow, guard «+12 % conversion», axe", async () => {
    const report = reportVariant("completed")!;
    const rendered = collectTexts(report).map((t) => renderText(t.text as any, report, (t.text as unknown as { lang: string }).lang as any)).filter((s) => s.length >= 14);
    const ctx = await newCtx({ width: 390, theme: "light", lang: "uk" });
    const page = await open(ctx, "/audit/fx_completed");
    await waitReport(page);
    expect(await unlabeledClaims(page)).toBe(0);
    expect(await overflowX(page)).toBe(0);
    expect(await orphanTexts(page, rendered)).toEqual([]);
    await page.evaluate((raw) => {
      const main = document.querySelector("main")!;
      const a = document.createElement("p");
      a.setAttribute("data-claim", "");
      a.innerHTML = '<span data-claim-text="">+12 % conversion after the change</span>';
      const b = document.createElement("p");
      b.textContent = raw;
      const c = document.createElement("div");
      c.style.width = "1200px";
      c.textContent = "wide";
      const d = document.createElement("div");
      d.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button></button>';
      main.append(a, b, c, d);
    }, "Перший екран не показує ціни. Сторінок із проблемою: 1.");
    expect(await unlabeledClaims(page)).toBe(1);
    expect(await overflowX(page)).toBeGreaterThan(0);
    expect((await orphanTexts(page, rendered)).length).toBeGreaterThan(0);
    const texts = await claimTexts(page);
    expect(texts.flatMap((t) => checkTextField("finding_text", t, "")).length).toBeGreaterThan(0);
    const ax = await new AxeBuilder({ page }).analyze();
    const hard = ax.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id);
    expect(hard).toEqual(expect.arrayContaining(["image-alt", "button-name"]));
    summary["controls"] = { unlabeled: 1, guardIssuesOnInjected: texts.flatMap((t) => checkTextField("finding_text", t, "")), axeOnInjected: hard };
    await ctx.close();
  });
});

describe("критерій 3: axe власного UI (10 поверхонь × light/dark)", () => {
  it("0 critical/serious", async () => {
    const rows: any[] = [];
    for (const theme of ["light", "dark"] as const) {
      const ctx = await newCtx({ width: 1440, theme, lang: "uk" });
      const surfaces: Array<[string, (p: any) => Promise<void>]> = [
        ["landing", async () => undefined],
      ];
      const runAxe = async (page: any, name: string) => {
        const r = await new AxeBuilder({ page }).analyze();
        rows.push({ theme, surface: name, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target })), passes: r.passes.length });
      };
      let page = await open(ctx, "/");
      await page.getByTestId("url-input").waitFor();
      await runAxe(page, "landing");
      await page.getByTestId("url-input").fill("x");
      await page.getByTestId("analyze").click();
      await page.getByTestId("url-error").waitFor();
      await runAxe(page, "landing-error");
      page = await open(ctx, "/audit/fx_running_partial");
      await page.getByTestId("progress").waitFor();
      await runAxe(page, "progress");
      page = await open(ctx, "/audit/fx_failed_timeout");
      await page.getByTestId("audit-error").waitFor();
      await runAxe(page, "error");
      page = await open(ctx, "/audit/fx_completed");
      await waitReport(page);
      for (const tab of TABS) {
        await gotoTab(page, tab);
        if (tab === "findings") await expandAll(page);
        await runAxe(page, `tab-${tab}`);
      }
      await gotoTab(page, "evidence");
      await page.getByTestId("open-evidence").first().click();
      await page.locator('[data-testid="lightbox"][data-state="loaded"]').waitFor();
      await runAxe(page, "lightbox");
      void surfaces;
      await ctx.close();
    }
    save("axe-own-ui.json", rows);
    const hard = rows.flatMap((r) => r.violations.filter((v: any) => v.impact === "critical" || v.impact === "serious").map((v: any) => ({ theme: r.theme, surface: r.surface, ...v })));
    summary["axe"] = { surfaces: rows.length, critical_serious: hard.length, all: rows.reduce((a, r) => a + r.violations.length, 0) };
    expect(hard).toEqual([]);
  }, T);
});

describe("критерій 7: доказ по кліку відкриває правильний скриншот із регіоном (усі знахідки фікстури)", () => {
  it("кожна знахідка completed + nollm", async () => {
    const res: any[] = [];
    for (const [v, id] of [["completed", "fx_completed"], ["nollm", "fx_nollm"]] as const) {
      const report = reportVariant(v)!;
      const evById = new Map<string, any>(report.evidence.map((e: any) => [e.id, e]));
      const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
      const page = await open(ctx, `/audit/${id}?tab=findings`);
      await waitReport(page);
      for (const f of report.findings) {
        const target = f.evidence_ids.map((i: string) => evById.get(i)).find((e: any) => e.screenshot_reference);
        const card = page.locator(`[data-finding-id="${f.id}"]`);
        if (!target) {
          res.push({ v, finding: f.id, ok: null, note: "немає скриншота серед доказів (N/A)" });
          continue;
        }
        if ((await card.getByTestId("finding-details").count()) === 0) await card.getByTestId("toggle-details").click();
        await card.locator(`[data-evidence-id="${target.id}"] [data-testid="open-evidence"]`).click();
        await page.locator('[data-testid="lightbox"][data-state="loaded"]').waitFor({ timeout: 15_000 });
        const src = await page.locator(".shot img").getAttribute("src");
        const okSrc = decodeURIComponent(src ?? "").endsWith(target.screenshot_reference);
        const region = await page.getByTestId("region").getAttribute("data-region");
        const okRegion = target.region ? region === `${target.region.x},${target.region.y},${target.region.w},${target.region.h}` : region === null;
        const box = await page.getByTestId("region").boundingBox();
        const shot = await page.getByTestId("shot").boundingBox();
        const cssW = Number(/(\d{3,5})x\d{3,5}/.exec(target.screenshot_reference)![1]);
        const inside = !target.region || (!!box && !!shot && box.x >= shot.x - 1 && box.y >= shot.y - 1 && box.x <= shot.x + shot.width && box.y <= shot.y + shot.height && Math.abs(box.width / shot.width - target.region.w / cssW) < 0.02 && Math.abs(box.x - shot.x - (target.region.x / cssW) * shot.width) < 2);
        res.push({ v, finding: f.id, evidence: target.id, ok: okSrc && okRegion && inside, okSrc, okRegion, inside });
        if (writeArtifacts() && v === "completed" && res.length <= 3) await page.screenshot({ path: shotPath(`lightbox-${f.id}-1440-light-uk.png`) });
        await page.keyboard.press("Escape");
        await page.getByTestId("lightbox").waitFor({ state: "detached" });
      }
      await ctx.close();
    }
    const checked = res.filter((r) => r.ok !== null);
    summary["evidence_click"] = { findings: res.length, checked: checked.length, ok: checked.filter((r) => r.ok).length };
    save("evidence-click.json", res);
    expect(checked.length).toBeGreaterThanOrEqual(10);
    expect(checked.filter((r) => !r.ok)).toEqual([]);
  }, T);

  it("артефакт видалено → lightbox показує стан помилки, не порожню картинку", async () => {
    const ctx = await newCtx({ width: 390, theme: "dark", lang: "uk" });
    const page = await open(ctx, "/audit/fx_deleted?tab=evidence");
    await waitReport(page);
    expect(await page.getByTestId("thumb").count()).toBe(0);
    const open1 = page.getByTestId("open-evidence").first();
    await open1.click();
    await page.getByTestId("lightbox-error").waitFor();
    expect(await overflowX(page)).toBe(0);
    if (writeArtifacts()) await page.screenshot({ path: shotPath("lightbox-deleted-390-dark-uk.png") });
    await ctx.close();
  });
  it("евіденс без скриншота (сесія) — lightbox/рядок пояснює, а не ламається", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/audit/fx_completed?tab=evidence");
    await waitReport(page);
    const row = page.locator('[data-testid="evidence-row"][data-class="SYNTHETIC"]').first();
    expect(await row.getByTestId("open-evidence").count()).toBe(0);
    expect(await row.textContent()).toMatch(/немає знімка/);
    await ctx.close();
  });
});

describe("контроли: фільтри, сортування, клавіатура, мова, тема", () => {
  it("кожен фільтр окремо == незалежний розрахунок; комбінація з 0 результатів; скидання; сортування", async () => {
    const report = reportVariant("completed")!;
    const evById = new Map<string, any>(report.evidence.map((e: any) => [e.id, e]));
    const F: any[] = report.findings;
    const pred: Record<string, (f: any, v: string) => boolean> = {
      device: (f, v) => f.evidence_ids.some((i: string) => evById.get(i).viewport === v),
      page: (f, v) => f.pages.some((p: any) => p.path === v),
      confidence: (f, v) => f.confidence.level === v,
      category: (f, v) => f.category === v,
      lens: (f, v) => f.affected_lens_ids.includes(v),
      task: (f, v) => f.affected_task_ids.includes(v),
    };
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/audit/fx_completed?tab=findings");
    await waitReport(page);
    const results: any = {};
    for (const k of Object.keys(pred)) {
      const sel = page.getByTestId(`filter-${k}`);
      const values: string[] = await sel.locator("option").evaluateAll((o: HTMLOptionElement[]) => o.map((x) => x.value).filter(Boolean));
      expect(values.length, k).toBeGreaterThan(0);
      for (const v of values) {
        await sel.selectOption(v);
        const shown = await page.getByTestId("finding").count();
        const want = F.filter((f) => pred[k]!(f, v)).length;
        expect(shown, `${k}=${v}`).toBe(want);
      }
      results[k] = values.length;
      await sel.selectOption("");
      expect(await page.getByTestId("finding").count()).toBe(F.length);
    }
    summary["filters"] = results;
    await page.getByTestId("filter-category").selectOption("performance");
    await page.getByTestId("filter-confidence").selectOption("HYPOTHESIS");
    await page.getByTestId("findings-none").waitFor();
    expect(await page.getByTestId("finding").count()).toBe(0);
    if (writeArtifacts()) await page.screenshot({ path: shotPath("findings-zero-results-1440-light-uk.png") });
    await page.getByTestId("filters-reset").click();
    expect(await page.getByTestId("finding").count()).toBe(F.length);
    // Порядок — rank контракту (смуги впевненості DEV-76), не сире priority.value.
    const ranks = async () => (await page.getByTestId("finding").evaluateAll((e) => e.map((x) => Number(x.getAttribute("data-rank")))));
    const d = await ranks();
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    await page.getByTestId("sort").selectOption("priority_asc");
    const a = await ranks();
    expect([...a].sort((x, y) => y - x)).toEqual(a);
    await ctx.close();
  });
  it("клавіатура: стрілки між вкладками, Tab у lightbox залишається всередині, Esc повертає фокус", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/audit/fx_completed?tab=evidence");
    await waitReport(page);
    await page.getByTestId("tab-evidence").focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.getByTestId("tab-overview").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("End");
    expect(await page.getByTestId("tab-evidence").getAttribute("aria-selected")).toBe("true");
    const btn = page.getByTestId("open-evidence").first();
    await btn.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("lightbox").waitFor();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.getByTestId("lightbox").waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("open-evidence");
    await ctx.close();
  });
  it("мова: перемикач uk→en міняє підписи на всіх вкладках без сирих ключів; тема перемикається", async () => {
    const ctx = await newCtx({ width: 1440, theme: "light", lang: "uk" });
    const page = await open(ctx, "/audit/fx_nollm");
    await waitReport(page);
    await page.getByTestId("lang-en").click();
    expect(await page.getByTestId("tab-findings").textContent()).toBe("Findings");
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    const rows: any[] = [];
    for (const tab of TABS) {
      await gotoTab(page, tab);
      rows.push({ tab, bad: await badStrings(page), disclaimers: await disclaimersPresent(page) });
      if (tab === "lenses") expect(await page.getByTestId("panel-lenses").textContent()).toContain("These lenses are synthetic testing perspectives, not measured population shares.");
      if (tab === "technical") expect(await page.getByTestId("panel-technical").textContent()).toContain("Automated accessibility testing is not a complete WCAG compliance audit.");
      if (tab === "experiments") expect(await page.getByTestId("panel-experiments").textContent()).toContain("Synthetic preference result. This is not a measured conversion uplift.");
      if (writeArtifacts()) await page.screenshot({ path: shotPath(`nollm-${tab}-1440-light-en.png`) });
    }
    save("i18n-en-check.json", rows);
    expect(rows.filter((r) => r.bad.length)).toEqual([]);
    const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByTestId("theme-toggle").click();
    expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bg1);
    await ctx.close();
  });
  it("текст у dark видимий: контраст тексту/фону основних елементів ≥ 4.5 у обох темах (за обчисленими стилями)", async () => {
    const out: any[] = [];
    for (const theme of ["light", "dark"] as const) {
      const ctx = await newCtx({ width: 1440, theme, lang: "uk" });
      const page = await open(ctx, "/audit/fx_completed?tab=findings");
      await waitReport(page);
      const worst = await page.evaluate(() => {
        const lum = (c: string) => {
          const m = c.match(/[\d.]+/g)!.map(Number);
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(m[0]!) + 0.7152 * f(m[1]!) + 0.0722 * f(m[2]!);
        };
        const bgOf = (el: Element | null): string => {
          while (el) {
            const b = getComputedStyle(el).backgroundColor;
            if (b && !/rgba\(.*, 0\)|transparent/.test(b)) return b;
            el = el.parentElement;
          }
          return "rgb(255,255,255)";
        };
        let worst = 99;
        for (const el of document.querySelectorAll("main p, main h2, main h3, main span, main button, main a, main label")) {
          if (!(el.textContent ?? "").trim() || el.children.length > 0) continue;
          const fg = getComputedStyle(el).color, bg = bgOf(el);
          const [a, b] = [lum(fg), lum(bg)];
          worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
        }
        return worst;
      });
      out.push({ theme, worst });
      expect(worst, theme).toBeGreaterThanOrEqual(4.5);
      await ctx.close();
    }
    summary["contrast"] = out;
  });
});
