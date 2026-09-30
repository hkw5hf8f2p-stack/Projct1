import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTextField, findDemographics, findInventedNumbers, type GuardedField } from "../src/index.js";

/**
 * Власний dev-корпус guard-ів (S3-Fix-1) — написаний автором guard-ів, тому це РЕГРЕСІЙНИЙ, а не незалежний набір.
 * Незалежну оцінку дає held-out (planning/eval/hostile-heldout, scripts/guard-heldout.ts), одноразовий.
 * Артефактів у planning/ ці тести не пишуть.
 */
type Row = { lang: "uk" | "en"; field: GuardedField; expected: "reject" | "pass"; category: string; text: string };
const rows = JSON.parse(readFileSync(path.join(import.meta.dirname, "guard-dev-corpus/cases.json"), "utf8")) as Row[];
const rejected = (r: Row) => checkTextField(r.field, r.text, "").length > 0;

describe("guard dev-корпус", () => {
  it("розмір і склад: ≥ 60 рядків, обидві мови, є і ворожі, і чисті", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    for (const lang of ["uk", "en"] as const) for (const e of ["reject", "pass"] as const) expect(rows.filter((r) => r.lang === lang && r.expected === e).length).toBeGreaterThan(5);
    expect(new Set(rows.filter((r) => r.expected === "reject").map((r) => r.category)).size).toBeGreaterThanOrEqual(10);
  });
  const hostile = rows.filter((r) => r.expected === "reject");
  const clean = rows.filter((r) => r.expected === "pass");
  it.each(hostile.map((r) => [`${r.category}/${r.lang}: ${r.text}`, r] as const))("відхиляє: %s", (_n, r) => { expect(rejected(r)).toBe(true); });
  it.each(clean.map((r) => [`${r.category}/${r.lang}: ${r.text}`, r] as const))("пропускає: %s", (_n, r) => { expect(checkTextField(r.field, r.text, "")).toEqual([]); });
  it("агрегати: recall 100 % / false-reject 0 % на dev-корпусі", () => {
    expect(hostile.filter(rejected).length).toBe(hostile.length);
    expect(clean.filter(rejected).length).toBe(0);
  });
  it("guard уміє впасти: «відхиляє все» дало б false-reject, «пропускає все» — recall 0 (контроль самого корпусу)", () => {
    expect(clean.length).toBeGreaterThan(0);
    expect(hostile.length).toBeGreaterThan(0);
  });
  it("нормалізація: NBSP, %-варіанти, невидимі символи не обходять guard", () => {
    expect(findInventedNumbers(["Зросте на 40 %"], "")).not.toEqual([]);
    expect(findInventedNumbers(["45​%"], "")).not.toEqual([]);
    expect(findInventedNumbers(["45٪ користувачів"], "")).not.toEqual([]);
    expect(findInventedNumbers(["Оборот 2 млн грн"], "")).not.toEqual([]);
  });
  it("доказ у корпусі дозволяє відсоток і обсяг, яких немає — ні", () => {
    expect(findInventedNumbers(["Знижка 20% на сайті"], "Акція: знижка 20% на всі фільтри")).toEqual([]);
    expect(findInventedNumbers(["Знижка 25% на сайті"], "Акція: знижка 20% на всі фільтри")).not.toEqual([]);
    expect(findInventedNumbers(["Ціна від 12 тис. грн"], "від 12 тис. грн")).toEqual([]);
    expect(findInventedNumbers(["Ціна від 12 тис. грн"], "від 9 тис. грн")).not.toEqual([]);
  });
  it("лінзи: відсоток/частка популяції → lens_market_percent, демографія → lens_demographics", () => {
    expect(findDemographics(["Це 35% ринку"]).some((i) => i.startsWith("lens_market_percent"))).toBe(true);
    expect(findDemographics(["Half of all customers hesitate"]).some((i) => i.startsWith("lens_market_percent"))).toBe(true);
    expect(findDemographics(["Pensioners who read slowly"]).some((i) => i.startsWith("lens_demographics"))).toBe(true);
    expect(findDemographics(["Reads every label before clicking"])).toEqual([]);
  });
});
