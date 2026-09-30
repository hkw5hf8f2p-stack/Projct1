import { describe, expect, it } from "vitest";
import { FORBIDDEN, normalize, scanClaims, targetFiles } from "./scan-claims.js";

const scan = (text: string) => scanClaims([{ path: "planning/STATE.md", text }]);
describe("scan-claims G0-17 (уміє впасти)", () => {
  /** 20 варіантів критика S8 (planning/reviews/critic-s8-2026-09-30.md: перелік пропусків + їхні uk/en відмінки, таблиці, ⏭️-обхід). */
  const CRITIC_20 = [
    "DoD: пройдено", "DoD §72 — пройдено", "| DoD §72 | ✅ |", "Definition of Done пройдено", "MVP — готовий", "MVP: ready", "DoD — passed",
    "DoD пройдено (⏭️ немає)", "DoD пройдено ⏭️", "| MVP | готово |", "MVP: готова", "**DoD §72**: ✅ (⏭️ див. нижче)", "Definition of Done — complete",
    "DoD: done", "MVP – done ⏭️ LLM", "DoD §72 | passed", "Усі 12 рядків DoD ✅ ⏭️", "DoD 12/12 ✅", "Definition of Done: ✅", "> MVP is now ready",
  ];
  const EXTRA = [
    "DoD пройдено", "Вердикт: DoD §72 пройдено повністю.", "DoD ✅", "MVP готовий до релізу", "MVP завершено? MVP завершений.", "Усі 12 рядків ✅",
    "всі рядки DoD пройдено", "DoD is complete", "DoD §72 has been passed", "DoD ✅ all green", "The MVP is now done", "All 12 DoD rows pass", "all DoD items are ✅",
    "DoD §72: 5 ✅ / 8 ⏭️ — перелік", // сума 13 ≠ 12
    "Пройдено DoD §72",
  ];
  it("рівно 20 варіантів критика", () => expect(new Set(CRITIC_20).size).toBe(20));
  it.each(CRITIC_20)("критик: %s → знайдено", (line) => {
    expect(scan(`# Вердикт\n${line}\n`).length).toBeGreaterThanOrEqual(1);
  });
  it.each(EXTRA)("додатковий: %s → знайдено", (line) => {
    expect(scan(`${line}\n`).length).toBeGreaterThanOrEqual(1);
  });
  it("жодне правило FORBIDDEN не мертве (кожне спрацьовує на підкладених рядках)", () => {
    for (const [rule, re] of FORBIDDEN) expect([...CRITIC_20, ...EXTRA].some((l) => re.test(normalize(l))), rule).toBe(true);
  });
  it("⏭️ у рядку не звільняє", () => {
    expect(scan("DoD ✅ окрім ⏭️ LLM-рядків").length).toBe(1);
    expect(scan("DoD §72: пройдено ⏭️").length).toBe(1);
  });
  it("негативний: дозволена формула, легітимні формулювання, цитата заборони", () => {
    for (const ok of [
      "DoD §72: 9 ✅ / 3 ⏭️ — LLM outputs validate, report (LLM) — дія власника: ключ",
      "DoD §72: 9 ✅ / 2 ⏭️ / 1 ❌ — guard held-out 44/52 < 90 %; дія: новий held-out",
      "| DoD §72 | 9 ✅ / 2 ⏭️ / 1 ❌ |",
      "DoD не пройдено: 3 рядки ⏭️", "DoD is not complete", "MVP не готовий без S6", "MVP is not ready", "Definition of Done §72 — 12 рядків",
      "DoD §72 — 12 рядків, з них 1 ❌", "MVP-метрики: 3 ⏭️", "Гейт: SSRF 178/178 ✅", "Заборонено «DoD пройдено» і «MVP готовий» (G0-17)",
      'Forbidden phrases: "DoD passed", `MVP ready`', "Метод: dodo ready", "S6 після DoD (DEV-14)",
    ]) expect(scan(ok), ok).toEqual([]);
  });
  it("цитата без маркера або поза лапками — не звільняє", () => {
    expect(scan("Заборонено, але DoD пройдено").length).toBe(1);
    expect(scan("«DoD пройдено»").length).toBe(1);
  });
  it("реальні файли: читаються і містять 0 заборонених формулювань", () => {
    const files = targetFiles();
    expect(files.map((f) => f.path)).toContain("README.md");
    expect(files.length).toBeGreaterThan(5);
    expect(scanClaims(files)).toEqual([]);
  });
});
