/**
 * pnpm run audit:metamorphic — метаморфний набір класифікатора типу сторінки (planning/eval/page-type-tests.md §1, DEV-32/DEV-34).
 * Запуск: bash scripts/run-as-sitelens.sh pnpm run audit:metamorphic [--out-dir <шлях>] [--only U5,R1] [--workers 3]
 * Для кожної трансформації фікстури `shop`: S == S₀ (детектори × логічна сторінка × viewport), T == T₀ (типи сторінок за логічним id),
 * 0 не-GET; чиста пара (`shop-clean` + та сама трансформація) → 0 доказів. Формати цін × M10. Контроль: те саме на старому коді
 * (`engine:'v1'`) мусить ПАДАТИ на U5 — доказ, що набір уміє впасти. Це РЕГРЕСІЯ (той самий автор), НЕ held-out (DEV-33).
 * Результат: <out-dir>/metamorphic/summary.json з PASS/FAIL на кожну трансформацію.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSFORM_IDS } from "../fixtures/_shared/variants.js";
import type { Mutant } from "../fixtures/shop/server.js";
import type { SecureBrowser } from "../packages/browser/src/secure-launch.js";
import { auditFixture, launchForFixtures, writeJson, type Site } from "./fixture-harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k: string): string | undefined => (process.argv.indexOf(k) >= 0 ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const OUT = path.resolve(ROOT, arg("--out-dir") ?? process.env["AUDIT_OUT_DIR"] ?? "planning/qa/artifacts/sprint-1a-fix", "metamorphic");
const ONLY = (arg("--only") ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
const WORKERS = Number(arg("--workers") ?? process.env["MM_WORKERS"] ?? 3);
const BASE_PORT = 4410;

/** очікування (page-type-tests.md §1): T₀ за логічним id */
const T0_SPEC: Record<string, string[]> = {
  home: ["homepage"],
  catalog: ["category"],
  "product:aquapro-x200": ["product"],
  "product:aquapro-x220": ["product"],
  "product:softline-s1": ["product"],
  "configure:aquapro-x200": ["other"],
  "configure:aquapro-x220": ["other"],
  "configure:softline-s1": ["other"],
  help: ["other", "faq"],
  "help-shipping": ["info_shipping"],
  about: ["about"],
};
const NEW_PAGES: Record<string, string> = { "cart-view": "cart", "checkout-view": "checkout" };
const PRICE_FORMATS = ["2 499 грн", "2 499 грн", "2 499 грн", "₴2499", "2.499,00 €", "€2,499.00", "£2,499", "$24.99", "2 499,00 zł", "2 499 UAH"];
const FROM_FORMAT = "від 2 499 грн";
const KEY3 = new Set(["shipping_depth", "cta_below_fold", "price_first_viewport"]);

interface Run { site: Site; transforms: string[]; mutant?: Mutant; priceText?: string; engine?: "v1" | "v2"; limits?: { maxPages: number; maxDepth: number; maxProducts: number } }
/** R2 додає кошик І оформлення: база вже займає 11 із 12 сторінок crawl, тож для R2 бюджет піднято до 14 (DEV-37) */
const R2_LIMITS = { maxPages: 14, maxDepth: 3, maxProducts: 3 };
interface Out {
  types: Record<string, string>;
  ev: string[];
  ev_count: number;
  non_get: number;
  pages: number;
  detectors: string[];
}
interface Worker { sb: SecureBrowser; shopPort: number; cleanPort: number }

async function doRun(w: Worker, r: Run): Promise<Out> {
  const { result, server } = await auditFixture({
    sb: w.sb, site: r.site, mutant: r.mutant, transforms: r.transforms, priceText: r.priceText, engine: r.engine, limits: r.limits,
    port: r.site === "shop" ? w.shopPort : w.cleanPort, runDir: path.join(OUT, "_scratch", `${w.shopPort}`), shots: false, tiles: false,
  });
  const logical = new Map<string, string>();
  for (const row of server.log) if (row.logical) logical.set(row.path, row.logical);
  const lg = (p: string) => logical.get(p) ?? `?${p}`;
  const types: Record<string, string> = {};
  for (const p of result.captures) types[lg(p.path)] = p.page_type + (p.page_type_reason ? `(${p.page_type_reason})` : "");
  const ev = [...new Set(result.evidence.map((e) => `${e.detector_id}|${lg(e.page_path)}|${e.viewport}`))].sort();
  return { types, ev, ev_count: result.evidence.length, non_get: server.state.non_get, pages: result.captures.length, detectors: [...new Set(result.evidence.map((e) => e.detector_id))].sort() };
}

async function pool<T>(items: T[], n: number, mk: (i: number) => Promise<Worker>, fn: (w: Worker, item: T) => Promise<void>): Promise<void> {
  const q = [...items];
  const workers = await Promise.all(Array.from({ length: Math.min(n, items.length) }, (_, i) => mk(i)));
  try {
    await Promise.all(
      workers.map(async (w) => {
        for (let it = q.shift(); it !== undefined; it = q.shift()) await fn(w, it);
      }),
    );
  } finally {
    await Promise.all(workers.map((w) => w.sb.close()));
  }
}

const diff = (a: string[], b: string[]) => ({ lost: b.filter((x) => !a.includes(x)), extra: a.filter((x) => !b.includes(x)) });
const detOf = (k: string) => k.split("|")[0]!;

async function main() {
  const started = Date.now();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const ids = (ONLY.length ? ONLY : [...TRANSFORM_IDS]) as string[];

  // ---- задачі: база (v2 і v1), кожна трансформація на shop (+ K2 із M10) і на shop-clean, формати цін
  const jobs: Array<{ key: string; run: Run }> = [
    { key: "base", run: { site: "shop", transforms: [] } },
    { key: "base_clean", run: { site: "clean", transforms: [] } },
    { key: "v1_base", run: { site: "shop", transforms: [], engine: "v1" } },
    { key: "v1_U5", run: { site: "shop", transforms: ["U5"], engine: "v1" } },
    { key: "v1_U5V2", run: { site: "shop", transforms: ["U5", "V2"], engine: "v1" } },
    { key: "base_M10", run: { site: "shop", transforms: [], mutant: "m10" } },
  ];
  for (const id of ids) {
    const mutant: Mutant | undefined = id === "K2" ? "m10" : undefined;
    const limits = id === "R2" ? R2_LIMITS : undefined;
    jobs.push({ key: `t_${id}`, run: { site: "shop", transforms: [id], mutant, limits } });
    jobs.push({ key: `c_${id}`, run: { site: "clean", transforms: [id], limits } });
  }
  if (!ONLY.length) {
    PRICE_FORMATS.concat(FROM_FORMAT).forEach((f, i) => {
      jobs.push({ key: `pf_base_${i}`, run: { site: "shop", transforms: [], priceText: f } });
      jobs.push({ key: `pf_m10_${i}`, run: { site: "shop", transforms: [], mutant: "m10", priceText: f } });
    });
  }
  const res = new Map<string, Out>();
  let done = 0;
  await pool(
    jobs,
    WORKERS,
    (i) => launchForFixtures([BASE_PORT + i * 2, BASE_PORT + i * 2 + 1]).then((sb) => ({ sb, shopPort: BASE_PORT + i * 2, cleanPort: BASE_PORT + i * 2 + 1 })),
    async (w, job) => {
      res.set(job.key, await doRun(w, job.run));
      console.log(`[${++done}/${jobs.length}] ${job.key}`);
    },
  );
  rmSync(path.join(OUT, "_scratch"), { recursive: true, force: true });

  const g = (k: string) => res.get(k)!;
  const base = g("base");
  const baseEv = base.ev;
  const baseT = base.types;
  const baseKeys = Object.keys(baseT);
  const noNew = (ev: string[]) => ev.filter((k) => !k.split("|")[1]!.match(/^(cart-view|checkout-view)$/));

  // ---- санітарна перевірка бази: T₀ зі специфікації, S₀ містить усі 7 класів детекторів
  const baseSanity = {
    types_match_spec: Object.entries(T0_SPEC).every(([k, want]) => want.some((w) => baseT[k] === w)),
    types: baseT,
    s0_detectors: base.detectors,
    s0_has_seven: ["shipping_depth", "cta_below_fold", "horizontal_overflow", "oversized_image", "price_first_viewport", "axe:image-alt"].every((d) => base.detectors.includes(d)) && base.detectors.some((d) => /^axe:(button-name|link-name|label)$/.test(d)),
    clean_evidence: g("base_clean").ev_count,
    pages: base.pages,
  };

  // ---- трансформації
  const rows = ids.map((id) => {
    const t = g(`t_${id}`);
    const c = g(`c_${id}`);
    const isK2 = id === "K2";
    const expS = isK2 ? noNew(g("base_M10").ev) : baseEv; // K2 — лише разом з M10 (№10 = 0, решта S₀∖{№10})
    const s = noNew(t.ev);
    const sd = diff(s, expS);
    const newPages = Object.keys(t.types).filter((k) => k in NEW_PAGES);
    const wantNew = id === "R1" ? ["cart-view"] : id === "R2" ? ["cart-view", "checkout-view"] : [];
    const typeProblems: string[] = [];
    for (const k of baseKeys) {
      const got = t.types[k];
      const want = T0_SPEC[k] ?? [baseT[k]!];
      if (got === undefined) typeProblems.push(`${k}: сторінку не досягнуто crawl`);
      else if (!want.includes(got)) typeProblems.push(`${k}: ${got} ≠ ${want.join("|")}`);
    }
    for (const k of wantNew) if (t.types[k] !== NEW_PAGES[k]) typeProblems.push(`${k}: ${t.types[k] ?? "не досягнуто"} ≠ ${NEW_PAGES[k]}`);
    const newPageKey3 = t.ev.filter((k) => (k.split("|")[1] ?? "") in NEW_PAGES && KEY3.has(detOf(k)));
    const cleanPageTypes = c.types;
    const checks = {
      S_equal_S0: sd.lost.length === 0 && sd.extra.length === 0,
      T_equal_T0: typeProblems.length === 0,
      new_pages_found: wantNew.every((k) => newPages.includes(k)),
      no_2_5_10_on_new_pages: newPageKey3.length === 0,
      non_get_zero: t.non_get === 0,
      clean_pair_zero: c.ev_count === 0,
    };
    const pass = Object.values(checks).every(Boolean);
    return {
      id,
      status: pass ? "PASS" : "FAIL",
      checks,
      pages_crawled: t.pages,
      s_diff: sd,
      type_problems: typeProblems,
      types: t.types,
      clean_pair: { evidence: c.ev_count, detectors: c.detectors, page_types: cleanPageTypes },
      note: isK2 ? "K2 виконано разом з M10: очікування — №10 = 0, решта S₀∖{№10}" : id === "R2" ? "бюджет crawl піднято до 14 сторінок (база = 11 із 12; R2 додає кошик і оформлення)" : undefined,
    };
  });

  // ---- формати цін
  const priceRows = PRICE_FORMATS.concat(FROM_FORMAT).map((f, i) => {
    const b = g(`pf_base_${i}`);
    const m = g(`pf_m10_${i}`);
    const isFrom = f === FROM_FORMAT;
    const mNo10 = m.ev.filter((k) => detOf(k) !== "price_first_viewport");
    const baseNo10 = g("base_M10").ev.filter((k) => detOf(k) !== "price_first_viewport");
    const n10 = m.ev.filter((k) => detOf(k) === "price_first_viewport").length;
    const typesOk = Object.entries(T0_SPEC).every(([k, want]) => want.includes(b.types[k] ?? "") && want.includes(m.types[k] ?? ""));
    const checks = {
      base_S_equal_S0: diff(b.ev, baseEv).lost.length === 0 && diff(b.ev, baseEv).extra.length === 0,
      T_equal_T0: typesOk,
      // M10 × формат: №10 = 0 (виняток «від/from» map §3.10/DEV-27: №10 ЛИШАЄТЬСЯ), решта S₀∖{№10}
      m10_price_first_viewport: isFrom ? n10 > 0 : n10 === 0,
      m10_others_equal: diff(mNo10, baseNo10).lost.length === 0 && diff(mNo10, baseNo10).extra.length === 0,
      non_get_zero: b.non_get === 0 && m.non_get === 0,
    };
    return { format: f, status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, m10_price_first_viewport_rows: n10 };
  });

  // ---- контроль: старий код (v1) МАЄ падати на U5 (доказ, що набір уміє впасти)
  const v1b = g("v1_base");
  const control = (key: string, label: string) => {
    const r = g(key);
    const d = diff(noNew(r.ev), noNew(v1b.ev));
    const lostDet = [...new Set(d.lost.map(detOf))].sort();
    // сторінки, що мають бути product/category: v1 їх або не розпізнає (unknown), або плутає (catalog → product)
    const wrongTypes = Object.entries(T0_SPEC).filter(([k, want]) => (want[0] === "product" || want[0] === "category") && r.types[k] !== want[0]).map(([k, want]) => `${k}: ${r.types[k] ?? "не досягнуто"} ≠ ${want[0]}`);
    return { transform: label, engine: "v1", lost_vs_v1_base: d.lost.length, extra_vs_v1_base: d.extra.length, lost_detectors: lostDet, lost_key_detectors: lostDet.filter((x) => KEY3.has(x)), extra_rows: d.extra, wrong_page_types: wrongTypes, types: r.types, fails_as_required: d.lost.length > 0 || d.extra.length > 0 || wrongTypes.length > 0 };
  };
  const cU5 = control("v1_U5", "U5");
  const cU5V2 = control("v1_U5V2", "U5+V2");
  const v1Base = { s0_equal_v2_s0: diff(v1b.ev, baseEv).lost.length === 0 && diff(v1b.ev, baseEv).extra.length === 0, detectors: v1b.detectors, types: v1b.types };
  // предикат контролю: v1 на базі = S₀; на U5 набір падає (S ≠ S₀ або T ≠ T₀); на U5+V2 v1 втрачає №2/№5/№10
  const controlPass = ONLY.length > 0 || (v1Base.s0_equal_v2_s0 && cU5.fails_as_required && cU5V2.lost_key_detectors.length === 3);

  const nPass = rows.filter((r) => r.status === "PASS").length;
  const pPass = priceRows.filter((r) => r.status === "PASS").length;
  const all = baseSanity.types_match_spec && baseSanity.s0_has_seven && baseSanity.clean_evidence === 0 && nPass === rows.length && (ONLY.length > 0 || pPass === priceRows.length) && controlPass;
  const summary = {
    schema: "sitelens-metamorphic-summary/v1",
    spec: "planning/eval/page-type-spec.md, planning/eval/page-type-tests.md",
    status_note: "регресія того самого автора, НЕ held-out (held-out = twin2 після тегу v2, DEV-33)",
    engine: "v2",
    base: baseSanity,
    transforms: { pass: nPass, of: rows.length, rows },
    price_formats: { pass: pPass, of: priceRows.length, rows: priceRows },
    control_v1: { base: v1Base, U5: cU5, "U5+V2": cU5V2, pass: controlPass, note: "v1 на базі = S₀; на U5 набір падає (T ≠ T₀ і/або S ≠ S₀); на U5+V2 v1 втрачає №2/№5/№10. На самому U5 v1 №2/№5/№10 НЕ втрачає: запасний шлях «h1 ∧ CTA_RE» ловить «Додати в кошик» — втрата настає, коли CTA поза словником v1 (V2)" },
    overall: all ? "PASS" : "FAIL",
    seconds: Math.round((Date.now() - started) / 1000),
  };
  writeJson(path.join(OUT, "summary.json"), summary);
  console.log(`\nМЕТАМОРФНИЙ НАБІР: трансформації ${nPass}/${rows.length}, формати цін ${pPass}/${priceRows.length}, контроль v1 (U5: втрачено ${cU5.lost_key_detectors.join(",") || "—"}, зайвих ${cU5.extra_vs_v1_base}, хибних типів ${cU5.wrong_page_types.length}; U5+V2: втрачено ${cU5V2.lost_key_detectors.join(",") || "—"} [${cU5V2.lost_vs_v1_base} рядків]) → ${summary.overall} (${summary.seconds} с)`);
  for (const r of rows) if (r.status === "FAIL") console.log(`  FAIL ${r.id}: ${JSON.stringify(r.checks)} S:${JSON.stringify(r.s_diff)} T:${r.type_problems.join("; ")}`);
  for (const r of priceRows) if (r.status === "FAIL") console.log(`  FAIL цін ${JSON.stringify(r.format)}: ${JSON.stringify(r.checks)}`);
  if (!all) process.exitCode = 1;
}
await main();
