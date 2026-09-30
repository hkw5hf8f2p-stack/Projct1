/**
 * S8 (G0-19): повна QA-матриця UI — 54 клітинки станів × (390, 1440) × (light, dark) = 216 (uk) + en-рядок (10 поверхонь у completed).
 * Кожна клітинка = PNG + автоперевірка: немає горизонтального скролу на 390, видимий текст (контраст ≥ 4.5 за обчисленими стилями), немає
 * undefined/NaN/[object/сирого JSON/сирого ключа i18n, нема pageerror, очікуваний маркер стану присутній на сторінці.
 * Стани відтворюються фікстурними відповідями API (SITELENS_SOURCE=fixture на :3100) і мутацією відповіді через page.route, а не «якось вийшло».
 * Використання (від sitelens): tsx scripts/s8-matrix.ts <outDir> [--only <підрядок id>] [--real-en-only] [--en-base http://127.0.0.1:3000 --en-audit aud_…]
 * Вихід: <outDir>/matrix.json (+ screens/*.png). Контролі детекторів (позитив) — у matrix.json → controls.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { BASE, TABS, closeBrowser, newCtx, startWeb, stopWeb, type Env } from "../apps/web/test/harness.js";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const OUT = path.resolve(args[0] ?? "planning/qa/artifacts/sprint-8/matrix");
const ONLY = flag("--only");
const EN_BASE = flag("--en-base");
const EN_AUDIT = flag("--en-audit");
/** окремий прогін лише реальних en-клітинок проти web :3000 (api-режим) — без fixture-web (два `next dev` в одному каталозі не сумісні); результат дописується в matrix.json */
const REAL_EN_ONLY = args.includes("--real-en-only");
fs.mkdirSync(path.join(OUT, "screens"), { recursive: true });

type Tab = (typeof TABS)[number];
interface Cell {
  surface: string;
  state: string;
  /** null → N/A з причиною */
  na?: string;
  /** маркер: селектор, який має бути видимий у цьому стані */
  marker?: string;
  /** підготовка + навігація; повертає сторінку в потрібному стані */
  run?: (ctx: BrowserContext, env: Env) => Promise<Page>;
  /** N/A-суфікс: пояснення того, як стан відтворено (для матриці) */
  how: string;
  nollm?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errsOf = new WeakMap<Page, string[]>();
async function fresh(ctx: BrowserContext, pre?: (p: Page) => Promise<void>): Promise<Page> {
  const p = await ctx.newPage();
  const errs: string[] = [];
  errsOf.set(p, errs);
  p.on("pageerror", (e) => errs.push(e.message));
  await p.addInitScript("window.__name = window.__name || ((f) => f);"); // tsx/esbuild keepNames підставляє __name у функції для page.evaluate
  if (pre) await pre(p);
  return p;
}
async function go(ctx: BrowserContext, url: string, pre?: (p: Page) => Promise<void>): Promise<Page> {
  const p = await fresh(ctx, pre);
  await p.goto(url);
  return p;
}
const audit = (id: string, tab?: Tab) => `${BASE}/audit/${id}${tab ? `?tab=${tab}` : ""}`;
async function mutateReport(p: Page, id: string, fn: (r: any) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await p.route(`**/api/dev/audits/${id}/report`, async (route) => {
    const resp = await route.fetch();
    const j = await resp.json();
    fn(j);
    await route.fulfill({ response: resp, json: j });
  });
}
const panel = (t: Tab) => `[data-testid="panel-${t}"]`;

// ---------------------------------------------------------------- визначення клітинок
const cells: Cell[] = [];
const add = (c: Cell) => cells.push(c);

// Landing (4)
add({ surface: "landing", state: "empty", marker: '[data-testid="url-input"]', how: "`/` — початковий екран", run: (c) => go(c, `${BASE}/`) });
add({
  surface: "landing", state: "loading", marker: '[data-testid="analyze"][disabled]', how: "сабміт із затримкою відповіді POST 1500 мс — кнопка disabled «Запускаємо…»",
  run: async (c) => {
    const p = await fresh(c, (pg) => pg.route("**/api/dev/audits", async (r) => { await sleep(1500); await r.continue(); }));
    await p.goto(`${BASE}/`);
    await p.getByTestId("url-input").fill("https://queued.example");
    await p.getByTestId("analyze").click();
    await p.locator('[data-testid="analyze"][disabled]').waitFor();
    return p;
  },
});
add({
  surface: "landing", state: "error", marker: '[data-testid="url-error"]', how: "SSRF-адреса `http://127.0.0.2/` → відповідь API 400 → повідомлення §48",
  run: async (c) => {
    const p = await go(c, `${BASE}/`);
    await p.getByTestId("url-input").fill("http://127.0.0.2/");
    await p.getByTestId("analyze").click();
    await p.getByTestId("url-error").waitFor();
    return p;
  },
});
add({
  surface: "landing", state: "completed", marker: '[data-testid="progress"]', how: "валідний URL → редирект на сторінку Progress",
  run: async (c) => {
    const p = await go(c, `${BASE}/`);
    await p.getByTestId("url-input").fill("https://shop.example/");
    await p.getByTestId("analyze").click();
    await p.getByTestId("progress").waitFor({ timeout: 20_000 });
    return p;
  },
});
// Progress (5)
add({ surface: "progress", state: "loading", marker: '[data-testid="progress"] [data-state="running"]', how: "fx_running: 7 кроків done, 1 running", run: (c) => go(c, audit("fx_running")) });
add({ surface: "progress", state: "empty", marker: '[data-testid="progress-summary"]', how: "fx_queued: `queued`, жоден крок не йде", run: (c) => go(c, audit("fx_queued")) });
add({ surface: "progress", state: "partial", marker: '[data-testid="progress-partial"]', how: "fx_running_partial: Lighthouse впав, аудит іде", run: (c) => go(c, audit("fx_running_partial")) });
add({ surface: "progress", state: "error", marker: '[data-testid="audit-error"]', how: "fx_failed_timeout: `failed` із §48-текстом", run: (c) => go(c, audit("fx_failed_timeout")) });
add({ surface: "progress", state: "completed", marker: '[data-testid="report-loading"]', how: "fx_slow: audit=completed, звіт ще вантажиться (момент переходу у звіт)", run: (c) => go(c, audit("fx_slow")) });

const tabDefs: Array<{ tab: Tab; empty: [string, string, string]; partial: [string, string, string?]; }> = [
  { tab: "overview", empty: ["fx_clean", '[data-testid="no-major-problem"]', "fx_clean: «No major problem detected»"], partial: ["fx_partial", '[data-testid="partial-note"]', "fx_partial: маркер partial + банери етапів"] },
  { tab: "lenses", empty: ["fx_early", '[data-testid="lenses-empty"]', "fx_early: етап лінз не дійшов (lenses=null)"], partial: ["fx_partial", '[data-testid="lenses-partial"]', "fx_partial: лінз 2 з 12"] },
  { tab: "journey", empty: ["fx_early", '[data-testid="no-sessions"]', "fx_early: 0 журналів"], partial: ["fx_completed", '[data-testid="journey-partial"]', "fx_completed з мутацією відповіді: stage browser_sessions=failed"] },
  { tab: "findings", empty: ["fx_clean", '[data-testid="findings-empty"]', "fx_clean: 0 знахідок (легітимно)"], partial: ["fx_partial", '[data-testid="findings-list"]', "fx_partial: список знахідок із маркером partial (§5.1: «✓»)"] },
  { tab: "technical", empty: ["fx_clean", '[data-testid="technical"]', "fx_clean: технічна вкладка чистого сайту (§5.1: «✓»)"], partial: ["fx_partial", '[data-testid="technical-partial"]', "fx_partial: Lighthouse упав, axe є"] },
  { tab: "evidence", empty: ["fx_completed", '[data-testid="evidence-empty"]', "fx_completed з мутацією відповіді: evidence=[] та findings=[]"], partial: ["fx_partial", '[data-testid="evidence"]', "fx_partial: список доказів при partial (§5.1: «✓»)"] },
];
for (const d of tabDefs) {
  const sel = `[data-testid="tab-${d.tab}"][aria-selected="true"]`;
  add({ surface: d.tab, state: "loading", marker: '[data-testid="report-loading"]', how: `fx_slow?tab=${d.tab}: скелет завантаження звіту (спільний для всіх вкладок, вкладка ще не змонтована)`, run: (c) => go(c, audit("fx_slow", d.tab)) });
  add({
    surface: d.tab, state: "empty", marker: d.empty[1], how: d.empty[2],
    run: async (c) => {
      const mut = d.tab === "evidence" ? (p: Page) => mutateReport(p, "fx_completed", (r) => { r.evidence = []; r.findings = []; r.positive_findings = []; }) : undefined;
      const p = await go(c, audit(d.empty[0], d.tab), mut);
      await p.locator(sel).waitFor({ timeout: 30_000 });
      return p;
    },
  });
  add({
    surface: d.tab, state: "partial", marker: d.partial[1], how: d.partial[2] ?? "",
    run: async (c) => {
      const mut = d.tab === "journey" ? (p: Page) => mutateReport(p, "fx_completed", (r) => { r.audit.stage_status["browser_sessions"] = { status: "failed", reason: "2 of 5 journals failed" }; }) : undefined;
      const p = await go(c, audit(d.partial[0], d.tab), mut);
      await p.locator(sel).waitFor({ timeout: 30_000 });
      return p;
    },
  });
  add({ surface: d.tab, state: "error", marker: '[data-testid="report-unavailable"]', how: `fx_report_500?tab=${d.tab}: звіт недоступний (спільний екран помилки; вкладка не монтується)`, run: (c) => go(c, audit("fx_report_500", d.tab)) });
  add({
    surface: d.tab, state: "completed", marker: panel(d.tab), how: `fx_completed?tab=${d.tab}`,
    run: async (c) => {
      const p = await go(c, audit("fx_completed", d.tab));
      await p.locator(`[data-testid="tab-${d.tab}"][aria-selected="true"]`).waitFor({ timeout: 30_000 });
      await p.locator(panel(d.tab)).waitFor();
      return p;
    },
  });
}
// Experiments: 5 станів — N/A (S6)
for (const s of ["loading", "empty", "partial", "error", "completed"]) {
  add({ surface: "experiments", state: s, how: "", na: "Варіанти й сліпе порівняння — S6 (виконується після S8, DEV-14); у UI лише заглушка `experiments-stub`, стани loading/empty/partial/error/completed не існують" });
}
// Lightbox (3)
const openFirstEvidence = async (p: Page) => {
  await p.locator('[data-testid="tab-evidence"][aria-selected="true"]').waitFor({ timeout: 30_000 });
  await p.getByTestId("open-evidence").first().click();
};
add({
  surface: "lightbox", state: "loading", marker: '[data-testid="lightbox-loading"]', how: "відповідь артефакту затримана 6 с → стан завантаження",
  run: async (c) => {
    const p = await go(c, audit("fx_completed", "evidence"), (pg) => pg.route("**/artifacts/**", async (r) => { await sleep(6000); await r.continue().catch(() => null); }));
    await openFirstEvidence(p);
    await p.getByTestId("lightbox-loading").waitFor();
    return p;
  },
});
add({
  surface: "lightbox", state: "error", marker: '[data-testid="lightbox-error"]', how: "fx_deleted: артефакт видалено (TTL) → стан помилки",
  run: async (c) => {
    const p = await go(c, audit("fx_deleted", "evidence"));
    await openFirstEvidence(p);
    await p.getByTestId("lightbox-error").waitFor();
    return p;
  },
});
add({
  surface: "lightbox", state: "completed", marker: '[data-testid="region"]', how: "fx_completed: скриншот завантажено, підсвічена область",
  run: async (c) => {
    const p = await go(c, audit("fx_completed", "evidence"));
    await openFirstEvidence(p);
    await p.locator('[data-testid="lightbox"][data-state="loaded"]').waitFor({ timeout: 20_000 });
    await p.getByTestId("region").waitFor({ state: "visible" });
    return p;
  },
});
// Режим без LLM (7)
for (const tab of ["overview", "lenses", "journey", "findings", "technical", "experiments", "evidence"] as const) {
  add({
    surface: `nollm-${tab}`, state: "completed", nollm: true, marker: tab === "experiments" ? '[data-testid="experiments-stub"]' : panel(tab), how: `fx_nollm?tab=${tab} (llm_mode=none, банер «синтетичний аналіз не виконувався»)`,
    run: async (c) => {
      const p = await go(c, audit("fx_nollm", tab));
      await p.locator(`[data-testid="tab-${tab}"][aria-selected="true"]`).waitFor({ timeout: 30_000 });
      return p;
    },
  });
}

// ---------------------------------------------------------------- автоперевірка клітинки
interface Check { overflow: number; bad: string[]; contrastWorst: number; worstSel: string; textLen: number; markerOk: boolean; cyrillicOutsideQuotes: number; pageErrors: string[]; bannerNoLlm: boolean }
async function check(p: Page, marker: string | undefined, en: boolean): Promise<Check> {
  const r = await p.evaluate(({ marker, en }) => {
    const vis = (el: Element) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.visibility !== "hidden" && s.display !== "none" && b.width > 0 && b.height > 0; };
    const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): [number, number, number, number] => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255]; };
    const lum = (c: number[]) => { const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!); };
    const bgOf = (el: Element | null): number[] => { const stack: number[][] = []; while (el) { const c = rgba(getComputedStyle(el).backgroundColor); if (c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } el = el.parentElement; } let base = [255, 255, 255];  for (const c of stack.reverse()) base = [0, 1, 2].map((i) => c[i]! * c[3]! + base[i]! * (1 - c[3]!)); return base; };
    let worst = 99; let worstSel = "";
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (["SCRIPT", "STYLE", "NEXT-ROUTE-ANNOUNCER"].includes(el.tagName) || el.closest("nextjs-portal, [aria-hidden='true'], [disabled], [aria-disabled='true']")) continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!own || !vis(el)) continue;
      const fg = rgba(getComputedStyle(el).color); const bg = bgOf(el);
      const f = [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!));
      const a = lum(f), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < worst) { worst = ratio; worstSel = `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}: ${(el.textContent ?? "").trim().slice(0, 40)}`; }
    }
    const root = (document.querySelector("main") ?? document.body) as HTMLElement;
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("nextjs-portal, script, style").forEach((e) => e.remove());
    const t = clone.textContent ?? "";
    const bad: string[] = [];
    for (const [name, re] of [["undefined", /\bundefined\b/], ["NaN", /\bNaN\b/], ["object", /\[object /], ["json", /\{"[a-z_]+":/], ["i18n-key", /\b(?:tab|findings|overview|cost|technical|lenses|journey|progress|error|landing|evidence|lightbox|class|conf|priority|disc|banner|stage|cat|common|report|filter|lang|theme)\.[a-z_]+(?:\.[a-z_]+)*\b/]] as const) if (re.test(t)) bad.push(`${name}: ${(re.exec(t) ?? [""])[0]}`);
    let cyr = 0;
    if (en) { const c2 = root.cloneNode(true) as HTMLElement; c2.querySelectorAll("[data-quote], [data-claim-quote], .mono, code, nextjs-portal").forEach((e) => e.remove()); cyr = (c2.textContent ?? "").match(/[А-Яа-яІіЇїЄєҐґ]{2,}/g)?.length ?? 0; }
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.documentElement.clientWidth);
    return { overflow, bad, contrastWorst: Math.round(worst * 100) / 100, worstSel, textLen: (root.textContent ?? "").trim().length, markerOk: marker ? !!document.querySelector(marker) && vis(document.querySelector(marker)!) : true, cyrillicOutsideQuotes: cyr, bannerNoLlm: !!document.querySelector('[data-disclaimer="no_llm_mode"], [data-banner="no_llm"]') };
  }, { marker, en });
  return { ...r, pageErrors: errsOf.get(p) ?? [] };
}
const verdict = (c: Check, width: number, en: boolean, nollm: boolean): string[] => {
  const f: string[] = [];
  if (width === 390 && c.overflow > 0) f.push(`overflow390=${c.overflow}`);
  if (!c.markerOk) f.push("marker-missing");
  if (c.bad.length) f.push(`bad:${c.bad.join("|")}`);
  if (c.contrastWorst < 4.5) f.push(`contrast=${c.contrastWorst} (${c.worstSel})`);
  if (c.textLen < 8) f.push("blank");
  if (c.pageErrors.length) f.push(`pageerror:${c.pageErrors[0]}`);
  if (en && c.cyrillicOutsideQuotes > 0) f.push(`mixed-lang(cyr=${c.cyrillicOutsideQuotes})`);
  if (nollm && !c.bannerNoLlm) f.push("no-llm-banner-missing");
  return f;
};

// ---------------------------------------------------------------- основний прогін
const ENVS: Env[] = [
  { width: 1440, theme: "light", lang: "uk" }, { width: 1440, theme: "dark", lang: "uk" },
  { width: 390, theme: "light", lang: "uk" }, { width: 390, theme: "dark", lang: "uk" },
];
const rows: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const fileOf = (c: Cell, env: Env, lang: string) => `${c.surface}-${c.state}-${env.width}-${env.theme}${lang === "en" ? "-en" : ""}.png`;

async function runCell(c: Cell, env: Env, ctx: BrowserContext, lang: "uk" | "en") {
  const id = `${c.surface}/${c.state}/${env.width}/${env.theme}/${lang}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = { id, surface: c.surface, state: c.state, width: env.width, theme: env.theme, lang, how: c.how, nollm: !!c.nollm };
  if (c.na || !c.run) { row.status = "N/A"; row.reason = c.na; rows.push(row); return; }
  let page: Page | null = null;
  try {
    page = await c.run(ctx, env);
    await sleep(350); // дати відрендеритись анімаціям/шрифтам
    // стан має бути ВИДНО на скриншоті: панель вкладки (або маркер) — у верхню частину в'юпорта; модальні вікна (lightbox) не скролимо
    await page.evaluate((m) => {
      if (document.querySelector('[data-testid="lightbox"]')) return;
      const el = document.querySelector('[role="tabpanel"], [data-testid^="panel-"]') ?? (m ? document.querySelector(m) : null);
      el?.scrollIntoView({ block: "start" });
      // маркер стану поза в'юпортом (напр. journey-partial унизу вкладки) → прокрутити до нього, щоб стан був видно на знімку
      const mk = m ? document.querySelector(m) : null;
      if (mk) { const r = mk.getBoundingClientRect(); if (r.height < innerHeight * 0.8 && (r.top < 0 || r.bottom > innerHeight)) mk.scrollIntoView({ block: "center" }); }
    }, c.marker ?? null);
    await sleep(150);
    const file = fileOf(c, env, lang);
    await page.screenshot({ path: path.join(OUT, "screens", file) });
    row.file = `screens/${file}`;
    row.bytes = fs.statSync(path.join(OUT, "screens", file)).size;
    row.check = await check(page, c.marker, lang === "en");
    row.failures = verdict(row.check, env.width, lang === "en", !!c.nollm);
    row.status = row.failures.length ? "FAIL" : "PASS";
  } catch (e) {
    row.status = "FAIL";
    row.failures = [`exception: ${(e as Error).message.split("\n")[0]}`];
    if (page) { const file = fileOf(c, env, lang).replace(".png", "-ERR.png"); await page.screenshot({ path: path.join(OUT, "screens", file) }).catch(() => null); row.file = `screens/${file}`; }
  } finally {
    await page?.close().catch(() => null);
  }
  rows.push(row);
  console.log(`${row.status.padEnd(4)} ${id}${row.failures?.length ? "  " + row.failures.join("; ") : ""}`);
}

async function controls(): Promise<Record<string, unknown>> {
  // Позитивні контролі детекторів: кожна перевірка має ловити підкладений дефект.
  const ctx = await newCtx({ width: 390, theme: "dark", lang: "uk" });
  const p = await go(ctx, `${BASE}/`);
  await p.getByTestId("url-input").waitFor();
  const base = await check(p, '[data-testid="url-input"]', false);
  await p.evaluate(() => {
    const d = document.createElement("div");
    d.innerHTML = '<div style="width:1200px">wide</div><p>value is undefined and NaN here</p><p style="color:#111;background:#111">invisible dark text</p>';
    document.body.append(d);
  });
  const bad = await check(p, '[data-testid="does-not-exist"]', false);
  await ctx.close();
  const out = { baseline: verdict(base, 390, false, false), injected: verdict(bad, 390, false, false) };
  const need = ["overflow390", "marker-missing", "bad:", "contrast="];
  const missing = need.filter((n) => !out.injected.some((f) => f.startsWith(n)));
  return { ...out, detectorsCaught: need.length - missing.length, detectorsExpected: need.length, missing };
}

const only = (c: Cell) => !ONLY || `${c.surface}/${c.state}`.includes(ONLY);
let ctrl: Record<string, unknown> = {};
try {
  if (!REAL_EN_ONLY) {
    await startWeb();
    ctrl = await controls();
    console.log("controls", JSON.stringify(ctrl));
    for (const env of ENVS) {
      const ctx = await newCtx(env);
      for (const c of cells.filter(only)) await runCell(c, env, ctx, "uk");
      await ctx.close();
    }
  }
  // en: 10 поверхонь у completed, 1440 light
  const enEnv: Env = { width: 1440, theme: "light", lang: "en" };
  const enCtx = await newCtx(enEnv);
  const enCells: Cell[] = [];
  const RB = EN_BASE ?? BASE;
  if (!REAL_EN_ONLY) {
    enCells.push({ surface: "landing", state: "completed", marker: '[data-testid="url-input"]', how: "en: `/`", run: (c) => go(c, `${BASE}/`) });
    enCells.push({ surface: "progress", state: "completed", marker: '[data-testid="progress"]', how: "en: fx_running (UI-рядки прогресу)", run: (c) => go(c, audit("fx_running")) });
  }
  if (EN_AUDIT) {
    for (const tab of TABS) enCells.push({ surface: tab, state: "completed", marker: panel(tab), how: `en: реальний стек (${RB}), аудит ${EN_AUDIT}, language=en, llm_mode=none`, nollm: true, run: async (c) => { const p = await go(c, `${RB}/audit/${EN_AUDIT}?tab=${tab}`); await p.locator(`[data-testid="tab-${tab}"][aria-selected="true"]`).waitFor({ timeout: 30_000 }); return p; } });
    enCells.push({
      surface: "lightbox", state: "completed", marker: '[data-testid="region"]', how: `en: реальний стек, аудит ${EN_AUDIT}`,
      run: async (c) => {
        const p = await go(c, `${RB}/audit/${EN_AUDIT}?tab=evidence`);
        await p.locator('[data-testid="tab-evidence"][aria-selected="true"]').waitFor({ timeout: 30_000 });
        await p.getByTestId("open-evidence").first().click();
        await p.locator('[data-testid="lightbox"][data-state="loaded"]').waitFor({ timeout: 20_000 });
        await p.getByTestId("region").waitFor({ state: "visible" });
        return p;
      },
    });
  }
  for (const c of enCells) {
    await runCell(c, enEnv, enCtx, "en");
  }
  await enCtx.close();
} finally {
  const mf = path.join(OUT, "matrix.json");
  let all = rows;
  let controlsOut = ctrl;
  if (REAL_EN_ONLY && fs.existsSync(mf)) { const prev = JSON.parse(fs.readFileSync(mf, "utf8")); all = [...prev.rows.filter((r: any) => !(r.lang === "en" && rows.some((n) => n.id === r.id))), ...rows]; controlsOut = prev.controls; } // eslint-disable-line @typescript-eslint/no-explicit-any
  fs.writeFileSync(mf, JSON.stringify({ generated_at: new Date().toISOString(), controls: controlsOut, rows: all }, null, 2));
  await closeBrowser();
  if (!REAL_EN_ONLY) stopWeb();
}
const by = (s: string) => rows.filter((r) => r.status === s).length;
console.log(`\nMATRIX: PASS ${by("PASS")} / FAIL ${by("FAIL")} / N/A ${by("N/A")} (rows ${rows.length})`);
