/**
 * Контракт звіту (S4 день 1): JSON Schema ↔ Zod, приклад для S5, і — головне — що КОЖЕН інваріант уміє впасти
 * (підкладені порушення відхиляються) та пропускає коректне.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Report, numberViolations, renderText, reportJsonSchema, type Report as ReportT } from "../src/index.js";

const require = createRequire(import.meta.url);
// ajv — devDependency пакета schemas (незалежний валідатор JSON Schema draft 2020-12)
const Ajv2020 = require("ajv/dist/2020").default as new (o: object) => { compile: (s: object) => ((d: unknown) => boolean) & { errors?: unknown[] } };
const addFormats = require("ajv-formats").default as (a: unknown) => void;

const PKG = path.resolve(import.meta.dirname, "..");
const schemaFile = JSON.parse(readFileSync(path.join(PKG, "report.schema.json"), "utf8"));
const example = JSON.parse(readFileSync(path.join(PKG, "examples/report.fixture.json"), "utf8")) as ReportT;
const clone = (): ReportT => structuredClone(example);
const issues = (r: unknown): string[] => {
  const p = Report.safeParse(r);
  return p.success ? [] : p.error.issues.map((i) => i.message);
};

describe("DEV-86: audit.llm_provider", () => {
  it("приймає всі провайдери (openai_compatible, claude_cli, session…) і null; відхиляє невідоме", () => {
    for (const p of ["anthropic", "openai", "openai_compatible", "claude_cli", "replay", "session", null]) {
      const r = clone(); (r.audit as { llm_provider: string | null }).llm_provider = p;
      expect(issues(r), String(p)).toEqual([]);
    }
    for (const bad of ["claude-cli", "none", "gemini"]) {
      const r = clone(); (r.audit as { llm_provider: string | null }).llm_provider = bad;
      expect(issues(r).length, bad).toBeGreaterThan(0);
    }
  });
});

describe("JSON Schema звіту", () => {
  it("закомічений report.schema.json = згенерований із Zod (без дрейфу; перегенерувати: tsx scripts/gen-report-contract.ts)", () => {
    expect(schemaFile).toEqual(JSON.parse(JSON.stringify(reportJsonSchema())));
  });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schemaFile);
  it("приклад для UI проходить JSON Schema (ajv strict, draft 2020-12)", () => {
    expect(validate(example), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });
  it("JSON Schema вміє впасти: зайве поле / невідомий enum / відсутнє обов'язкове", () => {
    const a = clone() as unknown as Record<string, unknown>;
    a["uplift_percent"] = 12;
    expect(validate(a)).toBe(false);
    const b = clone();
    (b.findings[0] as { confidence: { level: string } }).confidence.level = "CERTAIN";
    expect(validate(b)).toBe(false);
    const c = clone() as unknown as Record<string, unknown>;
    delete c["disclaimers"];
    expect(validate(c)).toBe(false);
  });
});

describe("Zod-інваріанти (крос-польові): приклад проходить, кожне підкладене порушення — ні", () => {
  it("приклад валідний", () => expect(issues(example)).toEqual([]));
  it("приклад показує всі класи й рівні (корисний для S5)", () => {
    const cls = new Set(example.evidence.map((e) => e.source_class));
    expect([...cls].sort()).toEqual(["BENCHMARKED", "INFERRED", "OBSERVED", "SYNTHETIC"]);
    expect(new Set(example.findings.map((f) => f.confidence.level))).toEqual(new Set(["VERIFIED", "STRONG_HYPOTHESIS", "HYPOTHESIS"]));
    expect(example.coverage.pole_unmet.length).toBeGreaterThan(0);
  });

  const CASES: Array<[string, (r: ReportT) => void, RegExp]> = [
    ["priority ≠ перерахунок компонентів", (r) => { r.findings[0]!.priority.value += 1; }, /priority .* ≠/],
    ["базова вага не з SCORING_SPEC", (r) => { r.findings[0]!.priority.components[0]!.base_weight = 0.4; }, /base_weight severity/],
    ["цифра в LLM-шаблоні", (r) => { r.findings.find((f) => f.title.origin === "llm")!.title.template = "Конверсія зросте на 12%"; }, /структурне правило чисел: digit/],
    ["числівник словом у LLM-шаблоні", (r) => { r.findings.find((f) => f.title.origin === "llm")!.title.template = "Половина відвідувачів іде"; }, /numeral_word/],
    ["цифра в шаблоні коду", (r) => { r.findings[0]!.title.template = "Ціни немає на 3 сторінках"; }, /digit/],
    ["вказівник усередину іншого тексту", (r) => { const f = r.findings[0]!; f.problem.template = "Див. {x}"; f.problem.params = { x: { ptr: "/findings/1/title/template", format: "text" } }; }, /веде в текст/],
    ["вказівник, що не резолвиться", (r) => { const f = r.findings[0]!; f.problem.template = "Сторінок: {x}"; f.problem.params = { x: { ptr: "/findings/0/nope", format: "int" } }; }, /не резолвиться/],
    ["плейсхолдер без params", (r) => { r.findings[0]!.problem.template = "Сторінок: {missing}"; r.findings[0]!.problem.params = {}; }, /без params/],
    ["доказ, якого немає", (r) => { r.findings[0]!.evidence_ids.push("ev_ffffffffffff"); }, /не існує/],
    ["без застереження G0-25 при «N of M synthetic»", (r) => { r.disclaimers = r.disclaimers.filter((d) => d !== "synthetic_single_model_correlated"); }, /G0-25/],
    ["VERIFIED із синтетичним покриттям у priority", (r) => { const f = r.findings.find((x) => x.confidence.level === "VERIFIED")!; f.synthetic.in_priority = true; }, /VERIFIED ⇔/],
    ["HYPOTHESIS без кепу асиметрії", (r) => { const f = r.findings.find((x) => x.confidence.level === "HYPOTHESIS")!; f.priority.cap = null; }, /кеп асиметрії/],
    ["порушений порядок рангів", (r) => { [r.findings[0], r.findings[7]] = [r.findings[7]!, r.findings[0]!]; }, /rank ≠ позиція|priority desc/],
    ["top_problem_ids не з рангу", (r) => { r.executive_summary.top_problem_ids.reverse(); }, /top_problem_ids/],
    ["SyntheticCount n > m", (r) => { const f = r.findings.find((x) => x.synthetic.lens_coverage)!; f.synthetic.lens_coverage!.n = 99; }, /n > m/],
    ["llm_mode=none із SYNTHETIC-доказами й без банера", (r) => { r.audit.llm_mode = "none"; }, /llm_mode=none/],
    ["аудит (не приклад) із LLM-текстами без guard", (r) => { r.provenance.kind = "audit"; r.audit.banners = r.audit.banners.filter((b) => b.code !== "example_fixture"); }, /без guard/],
    ["LLM-текст із класом OBSERVED (C4)", (r) => { r.findings.find((f) => f.title.origin === "llm")!.title.source_class = "OBSERVED"; }, /INFERRED або SYNTHETIC/],
    ["опис доказу з іншим класом, ніж доказ (C4)", (r) => { r.evidence[0]!.description.source_class = "SYNTHETIC"; }, /клас опису/],
    ["позитивний доказ у проблемній знахідці", (r) => { const p = r.evidence.find((e) => e.polarity === "problem")!; p.polarity = "positive"; }, /позитивний доказ|не positive/],
    ["a11y без застереження «не аудит WCAG»", (r) => { r.disclaimers = r.disclaimers.filter((d) => d !== "automated_a11y_not_wcag_audit"); }, /WCAG/],
    ["етап budget_limited без банера", (r) => { r.audit.stage_status.snapshot_sessions = { status: "budget_limited", reason: "MAX_AUDIT_TOKENS" }; }, /budget_limited без банера/],
    ["page_count ≠ pages.length", (r) => { r.findings[0]!.page_count += 1; }, /page_count/],
  ];
  it.each(CASES)("відхиляє: %s", (_n, mutate, re) => {
    const r = clone();
    mutate(r);
    const got = issues(r);
    expect(got.length, "порушення мало бути відхилене").toBeGreaterThan(0);
    expect(got.join("\n")).toMatch(re);
  });
  it("DEV-76 (scoring-v2): VERIFIED нижче гіпотези з тим самим priority → відхилено; той самий порядок у scoring-v1 — ні (контроль)", () => {
    const swap = (r: ReportT) => {
      const i = r.findings.findIndex((f) => f.confidence.level !== "VERIFIED");
      const [v, h] = [r.findings[i - 1]!, r.findings[i]!];
      expect(v.confidence.level).toBe("VERIFIED");
      expect(h.priority.value).toBe(v.priority.value); // priority desc не порушено — ловить саме смуга
      [r.findings[i - 1], r.findings[i]] = [h, v];
      h.rank = i;
      v.rank = i + 1;
    };
    const v2 = clone();
    expect(v2.scoring_version).toBe("scoring-v2");
    swap(v2);
    expect(issues(v2).join("\n")).toMatch(/гіпотеза вище перевіреного факту/);
    const v1 = clone();
    v1.scoring_version = "scoring-v1";
    swap(v1);
    expect(issues(v1).filter((x) => /порядок/.test(x))).toEqual([]);
    expect(issues(clone())).toEqual([]);
  });
  it("у контракті немає поля «% confidence» / uplift / conversion-прогнозу", () => {
    const keys = JSON.stringify(schemaFile).match(/"[a-z_]+":/g) ?? [];
    expect(keys.filter((k) => /percent|uplift|conversion_rate|revenue|confidence_pct/.test(k))).toEqual([]);
  });
});

describe("структурне правило чисел (report-text)", () => {
  const FORBIDDEN_LLM = [
    "Conversion will increase by 12%.", "Half of your visitors leave before the price.", "Sales could double after the fix.", "Three quarters of shoppers hesitate.",
    "A majority of users skip the page.", "Checkout completes twice as often.", "This lifts revenue tenfold.", "Every second visitor is lost.",
    "Twenty percent of buyers churn.", "A percentage of customers leave.", "Revenue grows by a third.", "Hundreds of customers abandon the cart.",
    "Конверсія зросте на 12%.", "Половина відвідувачів іде до ціни.", "Продажі зростуть удвічі.", "Третина покупців вагається.",
    "Більшість клієнтів не бачить доставки.", "Кожен другий відвідувач іде.", "Двоє з п'яти покупців вагаються.", "Виручка зросте втричі.",
    "Сотні клієнтів залишають кошик.", "Десятки покупців не знаходять ціну.", "Частка ринку — сім відсотків.", "Результат покращиться багатократно.",
    "Прибуток зросте на ٣٠ відсотків.", "Revenue up by 5 000 грн.",
  ];
  const ALLOWED_LLM = [
    "The price is not visible in the first screen.", "One of the products has no description.", "The first screen shows no delivery terms.", "The most important task is finding delivery cost.",
    "Show the price next to the product name.", "Delivery terms appear only on the help page.", "Visitors may not understand the model names.", "A single button leads to checkout.",
    "Ціни не видно в першому екрані.", "Один із товарів не має опису.", "Перший екран не показує умов доставки.", "Другий крок — вибір моделі.",
    "Сім'я назв моделей незрозуміла новачкам.", "Покажіть ціну поруч із назвою товару.", "Новачкам може бути незрозуміло, чим відрізняються моделі.", "Посилання на доставку веде на сторінку допомоги.",
  ];
  it.each(FORBIDDEN_LLM)("LLM-текст відхиляється: %s", (t) => expect(numberViolations(t, true).length).toBeGreaterThan(0));
  it.each(ALLOWED_LLM)("LLM-текст проходить: %s", (t) => expect(numberViolations(t, true)).toEqual([]));
  it("шаблон коду: лише цифри заборонені, числівники — ні (код не перефразовує)", () => {
    expect(numberViolations("Half of the rows", false)).toEqual([]);
    expect(numberViolations("Rows: 3", false).length).toBe(1);
  });
  it("рендер «N of M synthetic …» і «Priority NN/100» лише кодом", () => {
    const r = { f: { c: { form: "n_of_m_synthetic", n: 9, m: 12, unit: "lenses", disclaimer: "synthetic_single_model_correlated" }, p: 82 } };
    const t = { template: "{c} reported this; {p}.", params: { c: { ptr: "/f/c", format: "n_of_m" as const }, p: { ptr: "/f/p", format: "priority" as const } }, origin: "llm" as const };
    expect(renderText(t, r, "en")).toBe("9 of 12 synthetic lenses reported this; Priority 82/100.");
    expect(renderText({ ...t, template: "{c} повідомили; {p}." }, r, "uk")).toBe("9 з 12 синтетичних лінз повідомили; Пріоритет 82/100.");
  });
  it("межа правила (свідомо): перефразований прогноз БЕЗ числа структурне правило не ловить — це робота guard (G2)", () => {
    expect(numberViolations("This change will noticeably boost sales.", true)).toEqual([]);
    expect(numberViolations("Продажі суттєво зростуть.", true)).toEqual([]);
  });
});
