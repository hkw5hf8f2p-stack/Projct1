import { describe, expect, it } from "vitest";
import { PROMPTS } from "../prompts/index.js";
import { a11yOutlineText, buildRequest, fill } from "../src/stages/prompt-util.js";

const names = (tpl: string): string[] => [...new Set([...tpl.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1] as string))];

describe("рендер шаблонів: жодного незаповненого {{…}} (fail-closed)", () => {
  for (const p of PROMPTS) {
    it(`${p.id}: усі плейсхолдери (включно з цифрами, напр. A11Y_DATA) підставляються`, () => {
      const vars = Object.fromEntries(names(p.user_template).map((k) => [k, `<<${k.toLowerCase()}-value>>`]));
      const req = buildRequest({ stage: "snapshot_sessions", prompt: p, vars, logical: { page_url: "u", lens_id: "l", task_id: "t", step: 0 }, max_tokens: 10 });
      const text = req.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      expect(text).not.toMatch(/\{\{/);
      for (const k of names(p.user_template)) expect(text).toContain(`<<${k.toLowerCase()}-value>>`);
    });
    it(`${p.id}: пропущена змінна → помилка, а не тихий {{…}}`, () => {
      const ks = names(p.user_template);
      if (!ks.length) return;
      const vars = Object.fromEntries(ks.slice(1).map((k) => [k, "x"]));
      expect(() => fill(p.user_template, vars)).toThrow(/без значення/);
    });
  }
  it("змінна з цифрами (A11Y_DATA) справді підставляється — регресія на regex [A-Z_]", () => {
    expect(fill("a {{A11Y_DATA}} b", { A11Y_DATA: "OUT" })).toBe("a OUT b");
    expect(() => fill("a {{A11Y_DATA}} b", {})).toThrow(/A11Y_DATA/);
  });
  it("некоректне ім'я плейсхолдера в шаблоні → помилка", () => {
    expect(() => fill("a {{a11y-data}} b", { "a11y-data": "x" })).toThrow(/некоректне/);
  });
  it("{{…}} усередині ЗНАЧЕННЯ (вміст сайту) не інтерпретується і не блокує рендер", () => {
    expect(fill("t {{X}}", { X: "site says {{Y}}" })).toBe("t site says {{Y}}");
  });
  it("порожній outline → явний рядок з причиною, не порожнеча", () => {
    for (const v of ["", "   \n", null, undefined]) expect(a11yOutlineText(v)).toMatch(/^\(accessibility outline unavailable: .+\)$/);
    expect(a11yOutlineText("main\n  heading 'x'")).toBe("main\n  heading 'x'");
  });
});
