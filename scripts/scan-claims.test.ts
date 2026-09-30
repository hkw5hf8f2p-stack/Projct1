import { describe, expect, it } from "vitest";
import { FORBIDDEN, scanClaims, targetFiles } from "./scan-claims.js";

const scan = (text: string) => scanClaims([{ path: "planning/STATE.md", text }]);
describe("scan-claims G0-17 (уміє впасти)", () => {
  const BAD = [
    "DoD пройдено", "Вердикт: DoD §72 пройдено повністю.", "DoD ✅", "DoD §72: ✅", "MVP готовий до релізу", "MVP завершено? MVP завершений.",
    "Усі 12 рядків ✅", "всі рядки DoD пройдено", "DoD is complete", "DoD §72 has been passed", "DoD ✅ all green", "MVP is ready", "The MVP is now done", "All 12 DoD rows pass", "all DoD items are ✅",
  ];
  it.each(BAD)("позитивний: %s → знайдено", (line) => {
    expect(scan(`# Вердикт\n${line}\n`).length).toBeGreaterThanOrEqual(1);
  });
  it("кожне правило спрацьовує хоча б на одному підкладеному рядку (жодне не мертве)", () => {
    for (const [rule, re] of FORBIDDEN) expect(BAD.some((l) => re.test(l)), rule).toBe(true);
  });
  it("негативний: дозволена формула, рядок із переліком ⏭️, цитата заборони, заперечення", () => {
    expect(scan("DoD §72: 9 ✅ / 3 ⏭️ — LLM outputs validate, report (LLM) — дія власника: ключ").length).toBe(0);
    expect(scan("DoD ✅ окрім ⏭️ LLM-рядків").length).toBe(0);
    expect(scan("Заборонено «DoD пройдено» і «MVP готовий» (G0-17)").length).toBe(0);
    expect(scan("DoD не пройдено: 3 рядки ⏭️").length).toBe(0);
    expect(scan("MVP не готовий без S6").length).toBe(0);
    expect(scan("Definition of Done §72 — 12 рядків").length).toBe(0);
  });
  it("реальні файли: читаються і містять 0 заборонених формулювань", () => {
    const files = targetFiles();
    expect(files.map((f) => f.path)).toContain("README.md");
    expect(files.length).toBeGreaterThan(5);
    expect(scanClaims(files)).toEqual([]);
  });
});
