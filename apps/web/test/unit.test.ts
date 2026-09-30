import { describe, expect, it } from "vitest";
import { DISCLAIMER_TEXT, ERROR_CLASSES as SCHEMA_ERRORS, Report, AuditStatusResponse } from "@sitelens/schemas";
import { MESSAGES } from "../src/lib/messages";
import { ERROR_CLASSES } from "../src/lib/errors";
import { REPORT_VARIANTS, FIXTURE_IDS, fixtureSpec, reportVariant, statusView } from "../src/dev/fixtures";
import { stepViews } from "../src/lib/progress";
import { validateUrlInput } from "../src/lib/validate";

describe("i18n", () => {
  it("uk і en мають однакові набори ключів, без порожніх значень (критерій 5)", () => {
    const en = Object.keys(MESSAGES.en).sort(), uk = Object.keys(MESSAGES.uk).sort();
    expect(uk).toEqual(en);
    for (const l of ["uk", "en"] as const) for (const [k, v] of Object.entries(MESSAGES[l])) expect(v.trim().length, `${l}:${k}`).toBeGreaterThan(0);
  });
  it("керування має негативний випадок: підміна ключа ловиться", () => {
    const broken = { ...MESSAGES.uk } as Record<string, string>;
    delete broken["tab.findings"];
    expect(Object.keys(broken).sort()).not.toEqual(Object.keys(MESSAGES.en).sort());
  });
  it("тексти дисклеймерів у UI = каталог контракту (дрейф), обидві мови", () => {
    for (const [id, t] of Object.entries(DISCLAIMER_TEXT)) for (const l of ["uk", "en"] as const) expect(MESSAGES[l][`disc.${id}` as keyof typeof MESSAGES.en], `${l}:${id}`).toBe(t[l]);
  });
  it("12 класів помилок §48 збігаються з контрактом і мають переклад", () => {
    expect([...ERROR_CLASSES]).toEqual([...SCHEMA_ERRORS]);
    for (const c of ERROR_CLASSES) for (const l of ["uk", "en"] as const) expect(MESSAGES[l][`error.${c}` as keyof typeof MESSAGES.en]).toBeTruthy();
  });
});

describe("dev-фікстури проти контракту", () => {
  for (const v of REPORT_VARIANTS) {
    it(`варіант ${v} проходить повний Zod Report`, () => {
      const r = reportVariant(v);
      const p = Report.safeParse(r);
      expect(p.success, p.success ? "" : JSON.stringify(p.error.issues.slice(0, 3))).toBe(true);
    });
  }
  it("контроль: зіпсований варіант (число в шаблоні) контракт відхиляє", () => {
    const r = reportVariant("partial")!;
    r["audit"]["banners"][r["audit"]["banners"].length - 1]["text"]["template"] = "Етап впав: 12 разів";
    expect(Report.safeParse(r).success).toBe(false);
  });
  it("статус-відповіді всіх фікстур проходять AuditStatusResponse", () => {
    for (const id of FIXTURE_IDS) {
      const spec = fixtureSpec(id)!;
      const s = AuditStatusResponse.safeParse(statusView(spec, spec.report ?? null));
      expect(s.success, `${id}: ${s.success ? "" : JSON.stringify(s.error.issues.slice(0, 2))}`).toBe(true);
    }
  });
});

describe("прогрес §43", () => {
  it("8 кроків; частковий збій позначається; не-LLM режим пропускає LLM-кроки", () => {
    const v = stepViews({ crawl: { status: "done" }, capture: { status: "done" }, lighthouse: { status: "failed", reason: "x" }, accessibility: { status: "done" } }, false, true);
    expect(v).toHaveLength(8);
    expect(v[2]?.state).toBe("failed");
    expect(v[3]?.state).toBe("running");
    const nollm = stepViews({ site_profile: { status: "skipped", reason: "r" }, tasks: { status: "skipped", reason: "r" } }, true, true);
    expect(nollm[3]?.state).toBe("skipped");
  });
});

describe("валідація URL на лендінгу", () => {
  it("відхиляє порожнє, javascript:, file:, пробіли; приймає http(s) і host без схеми", () => {
    expect(validateUrlInput("")).toBe("landing.err.empty");
    expect(validateUrlInput("javascript:alert(1)")).toBe("landing.err.scheme");
    expect(validateUrlInput("file:///etc/passwd")).toBe("landing.err.scheme");
    expect(validateUrlInput("a b.com")).toBe("landing.err.invalid");
    expect(validateUrlInput("nodots")).toBe("landing.err.invalid");
    expect(validateUrlInput("https://example.com/x")).toBeNull();
    expect(validateUrlInput("example.com")).toBeNull();
  });
});

describe("BYO AI (/settings/ai)", () => {
  it("кожен код помилки перевірки має переклад uk і en; є запасний unknown", async () => {
    const { CHECK_ERROR_CLASSES, PROVIDER_KINDS } = await import("../src/lib/ai-settings");
    for (const l of ["uk", "en"] as const) {
      for (const c of CHECK_ERROR_CLASSES) expect(MESSAGES[l][`ai.err.check.${c}` as keyof typeof MESSAGES.en], `${l}:${c}`).toBeTruthy();
      for (const k of PROVIDER_KINDS) {
        expect(MESSAGES[l][`ai.kind.${k}` as keyof typeof MESSAGES.en]).toBeTruthy();
        expect(MESSAGES[l][`ai.kind.${k}.desc` as keyof typeof MESSAGES.en]).toBeTruthy();
      }
    }
    expect(CHECK_ERROR_CLASSES).toContain("unknown");
    const { AI_CHECK_ERROR_CLASSES } = await import("@sitelens/schemas");
    expect([...CHECK_ERROR_CLASSES].sort()).toEqual([...AI_CHECK_ERROR_CLASSES].sort());
  });
  it("набір провайдерів у UI = ProviderKind контракту", async () => {
    const { PROVIDER_KINDS } = await import("../src/lib/ai-settings");
    const { ProviderKind, MAX_AUDIT_TOKENS_MIN, MAX_AUDIT_TOKENS_MAX } = await import("@sitelens/schemas");
    const ui = await import("../src/lib/ai-settings");
    expect([ui.MAX_AUDIT_TOKENS_MIN, ui.MAX_AUDIT_TOKENS_MAX]).toEqual([MAX_AUDIT_TOKENS_MIN, MAX_AUDIT_TOKENS_MAX]);
    expect([...PROVIDER_KINDS].sort()).toEqual([...ProviderKind.options].sort());
  });
  it("валідатори: токени й base URL (позитив і негатив)", async () => {
    const { parseTokens, validBaseUrl } = await import("../src/lib/ai-settings");
    expect(parseTokens("200000")).toBe(200000);
    for (const bad of ["", "0", "9999", "5000001", "-5", "1.5", "abc", "12e3"]) expect(parseTokens(bad), bad).toBeNull();
    expect(validBaseUrl("http://localhost:11434/v1")).toBe(true);
    for (const bad of ["", "localhost:11434", "ftp://x", "javascript:alert(1)"]) expect(validBaseUrl(bad), bad).toBe(false);
  });
});
