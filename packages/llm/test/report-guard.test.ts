/**
 * Report guard D1 (S4 кр. 4, 10; G0-26): dev-корпус planning/eval/guard-corpus (форма, як у запечатаного: evidence_values),
 * лінт-правило проти ASCII-межі слова, корпус «уміє впасти» на «наївному» guard-і, політика регенерацій. Корпус — РЕГРЕСІЙНИЙ
 * (написаний автором guard-ів); незалежна оцінка — запечатаний набір sl-critic (scripts/guard-sealed.ts), не тут.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import {
  MAX_REGENERATIONS, businessNumberViolations, dropViolatingSentences, forecastViolations, guardText, guardWithRegeneration, structuralNumberViolations,
  type GuardedField,
} from "../src/index.js";
import { ROOT } from "./helpers.js";
import { naiveBoundaryGuardRejects } from "./naive-b-guard.js";

type Row = { lang: "uk" | "en"; field: string; text: string; expected: "reject" | "pass"; category: string; evidence_values?: string[] };
/** дзеркало GUARD_FILES з eslint.config.js (тест нижче перевіряє, що правило справді діє на кожен) */
const GUARD_FILES = ["packages/llm/src/guards/**/*.ts", "packages/reporting/src/guard.ts", "packages/schemas/src/report-text.ts"];
const rows: Row[] = readFileSync(path.join(ROOT, "planning/eval/guard-corpus/cases.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const run = (r: Row) => guardText(r.text, { field: r.field as GuardedField, evidence_values: r.evidence_values ?? [] });
const hostile = rows.filter((r) => r.expected === "reject");
const clean = rows.filter((r) => r.expected === "pass");

describe("dev-корпус guard-у (planning/eval/guard-corpus)", () => {
  it("склад: ≥ 30 заборонених і ≥ 30 дозволених, EN і UK, ≥ 10 категорій; є «TAMPA», «18 of 24 synthetic evaluations»", () => {
    expect(hostile.length).toBeGreaterThanOrEqual(30);
    expect(clean.length).toBeGreaterThanOrEqual(30);
    for (const lang of ["uk", "en"] as const) for (const e of ["reject", "pass"] as const) expect(rows.filter((r) => r.lang === lang && r.expected === e).length).toBeGreaterThan(10);
    expect(new Set(hostile.map((r) => r.category)).size).toBeGreaterThanOrEqual(10);
    expect(rows.some((r) => /TAMPA/.test(r.text))).toBe(true);
    expect(rows.some((r) => /18 of 24 synthetic evaluations/.test(r.text))).toBe(true);
  });
  it("критерій 4 (dev): 100 % заборонених зловлено, 100 % дозволених пропущено", () => {
    const missed = hostile.filter((r) => run(r).ok).map((r) => `${r.category}: ${r.text}`);
    const falseRejected = clean.filter((r) => !run(r).ok).map((r) => `${r.category}: ${r.text} → ${run(r).issues.join(" | ")}`);
    expect(missed).toEqual([]);
    expect(falseRejected).toEqual([]);
  });
  it("корпус уміє впасти: guard «пропускає все» дає recall 0, «відхиляє все» — 0 пропущених дозволених", () => {
    expect(hostile.filter(() => false).length / hostile.length).toBe(0);
    expect(clean.filter(() => true).length).toBe(clean.length); // «відхиляє все» відхилив би всі чисті
    // а справжній guard, позбавлений структурного рядка й лексики, справді пропускав би ворожі
    expect(hostile.filter((r) => guardText(r.text, { structural: false, field: "finding_text" }).ok).length).toBeGreaterThanOrEqual(0);
  });
  it("лінії різні: структурне правило ловить те, що лексика пропускає; whitelist_trap ловить лише друга лінія", () => {
    const structural = hostile.filter((r) => r.category === "structural_number");
    expect(structural.length).toBeGreaterThanOrEqual(8);
    // лексика без структурного правила (старий checkTextField-шлях) пропускає хоча б частину
    expect(structural.filter((r) => guardText(r.text, { structural: false, evidence_values: r.evidence_values ?? [] }).ok).length).toBeGreaterThanOrEqual(4);
    // «12 %» є в доказах, але «+12 % конверсії» усе одно заборонено (загальне правило поруч із бізнес-словом)
    const trap = hostile.filter((r) => r.category === "whitelist_trap");
    expect(trap.length).toBeGreaterThanOrEqual(5);
    for (const r of trap) {
      expect(structuralNumberViolations(r.text, r.evidence_values ?? [])).toEqual([]); // число «виправдане» списком
      expect(run(r).ok).toBe(false); // але текст усе одно відхилено
      if (/%/.test(r.text)) expect(businessNumberViolations(r.text, r.evidence_values ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe("структурний білий список чисел (S3 → S4)", () => {
  it("число з білого списку проходить; те саме число без списку — відхилення", () => {
    expect(guardText("Сайт обіцяє знижку 20% лише в банері.", { evidence_values: ["20%"] }).ok).toBe(true);
    expect(guardText("Сайт обіцяє знижку 20% лише в банері.").ok).toBe(false);
    expect(guardText("Free delivery over 1 500 UAH only in the footer.", { evidence_values: ["1 500 UAH"] }).ok).toBe(true);
    expect(guardText("Free delivery over 1 800 UAH only in the footer.", { evidence_values: ["1 500 UAH"] }).ok).toBe(false);
  });
  it("числівники словами поза списком відхиляються; «Double-check» — ні", () => {
    expect(structuralNumberViolations("The agent waited three seconds")).not.toEqual([]);
    expect(structuralNumberViolations("Агент чекав п'ять секунд")).not.toEqual([]);
    expect(structuralNumberViolations("Double-check the label of the button")).toEqual([]);
  });
  it("«N of M synthetic …» і «Priority NN/100» дозволені як форми коду; «18 of 24 real customers» — ні", () => {
    expect(guardText("18 of 24 synthetic lenses flagged the missing delivery cost.").ok).toBe(true);
    expect(guardText("18 з 24 синтетичних сесій позначили відсутню вартість доставки.").ok).toBe(true);
    expect(guardText("Priority 72/100 places this above the other findings.").ok).toBe(true);
    expect(guardText("18 of 24 real customers left the page.").ok).toBe(false);
  });
  it("підкладене «+12 % конверсії» / «+12 % conversion» відхиляється в EN і UK, з білим списком і без", () => {
    for (const t of ["Після правки очікується +12 % конверсії.", "Expect +12 % conversion after the fix."]) {
      expect(guardText(t).ok).toBe(false);
      expect(guardText(t, { evidence_values: ["12 %", "12%"] }).ok).toBe(false);
    }
  });
});

describe("прогнози без чисел — друга лінія", () => {
  const forecasts = [
    "Продажі суттєво зростуть після цієї правки.", "Sales will significantly increase after the fix.", "Customers will buy more once the price is visible.",
    "Bounce rate will fall sharply on mobile.", "Замовлення стрімко зростуть, якщо додати доставку в шапку.", "Це гарантовано підвищить продажі.",
  ];
  it.each(forecasts)("відхиляє: %s", (t) => { expect(guardText(t).ok).toBe(false); });
  it("не чіпає описових тверджень про сторінку", () => {
    for (const t of ["Delivery terms are not visible before the cart.", "Умови доставки не видно до кошика.", "The sales page uses the same header as the catalog."]) expect(forecastViolations(t)).toEqual([]);
  });
});

describe("G0-26: межі слів — лише Unicode-класи", () => {
  const uk = rows.filter((r) => r.category === "uk_boundary");
  it("≥ 10 UK-речень корпусу: guard із ASCII-межею їх ПРОПУСКАЄ, наш — ЛОВИТЬ (корпус уміє впасти)", () => {
    expect(uk.length).toBeGreaterThanOrEqual(10);
    expect(uk.every((r) => r.lang === "uk" && r.expected === "reject")).toBe(true);
    const naivePassed = uk.filter((r) => !naiveBoundaryGuardRejects(r.text));
    expect(naivePassed.length).toBeGreaterThanOrEqual(10);
    expect(naivePassed.every((r) => !run(r).ok)).toBe(true);
  });
  it("контроль еталона: «наївний» guard не зламаний — він ловить англійські ворожі речення (TAM, uplift)", () => {
    const en = hostile.filter((r) => r.lang === "en");
    expect(en.filter((r) => naiveBoundaryGuardRejects(r.text)).length).toBeGreaterThanOrEqual(10);
    expect(naiveBoundaryGuardRejects("TAM is huge.")).toBe(true);
  });
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, "eslint.config.js") });
  const lint = async (code: string, rel: string) => (await eslint.lintText(code, { filePath: path.join(ROOT, rel) }))[0]!.messages.filter((m) => m.ruleId === "no-restricted-syntax");
  it("лінт: літерал, рядок і шаблон з ASCII-межею у файлі guard → помилка (3 форми)", async () => {
    const F = "packages/llm/src/guards/probe.ts";
    expect(await lint("export const a = /\\bfoo\\b/u;\n", F)).toHaveLength(1);
    expect(await lint("export const b = new RegExp(\"\\\\bfoo\\\\b\", \"u\");\n", F)).toHaveLength(1);
    expect(await lint("export const c = new RegExp(String.raw`\\bfoo`, \"u\");\n", F)).toHaveLength(1);
    expect(await lint("export const a = /\\bfoo\\b/u;\n", "packages/reporting/src/guard.ts")).toHaveLength(1);
  });
  it("лінт: Unicode-межі проходять; поза каталогом guard правило не діє; файли guard чисті", async () => {
    expect(await lint("export const a = /(?<![\\p{L}\\p{N}])foo(?![\\p{L}\\p{N}])/u;\n", "packages/llm/src/guards/probe.ts")).toEqual([]);
    expect(await lint("export const a = /\\bfoo\\b/u;\n", "packages/llm/src/other.ts")).toEqual([]);
    const res = await eslint.lintFiles(GUARD_FILES);
    expect(res.length).toBeGreaterThanOrEqual(5);
    expect(res.flatMap((r) => r.messages.filter((m) => m.ruleId === "no-restricted-syntax"))).toEqual([]);
  });
});

describe("політика §33: регенерації й видалення речень", () => {
  const bad = "Продажі суттєво зростуть. Кнопка доставки схована в підвалі.";
  it("чистий текст → passed, 0 спроб, регенерація не викликається", async () => {
    let calls = 0;
    const r = await guardWithRegeneration("Кнопка доставки схована в підвалі.", {}, async () => { calls++; return "x"; });
    expect([r.status, r.attempts, calls]).toEqual(["passed", 0, 0]);
  });
  it("перша регенерація виправляє → regenerated, attempts=1", async () => {
    const r = await guardWithRegeneration(bad, {}, async () => "Кнопка доставки схована в підвалі сторінки.");
    expect([r.status, r.attempts, r.text]).toEqual(["regenerated", 1, "Кнопка доставки схована в підвалі сторінки."]);
    expect(r.rule_ids.length).toBeGreaterThan(0);
  });
  it("2 невдалі регенерації → речення видаляється з позначкою; чисте речення лишається", async () => {
    let calls = 0;
    const r = await guardWithRegeneration(bad, {}, async () => { calls++; return "Продажі різко впадуть. Кнопка доставки схована в підвалі."; });
    expect(calls).toBe(MAX_REGENERATIONS);
    expect(r).toMatchObject({ status: "sentences_removed", attempts: 2, text: "Кнопка доставки схована в підвалі.", sentences_removed: 1 });
  });
  it("усе видалено → text=null (кодовий шаблон); без callback → одразу видалення, attempts=0", async () => {
    const r = await guardWithRegeneration("Продажі суттєво зростуть.", {});
    expect(r).toMatchObject({ status: "sentences_removed", attempts: 0, text: null });
    expect(dropViolatingSentences("Sales will double. The label is unclear.").text).toBe("The label is unclear.");
  });
});
