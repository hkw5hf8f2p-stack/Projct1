/** Наявні артефакти S1a-fix валідуються схемами; навмисно зіпсовані докази відхиляються (предикат уміє впасти). */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Evidence, Finding, PageArtifactCapture, findingId, parseFindingKey, tierOf, buildFindingKey } from "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, "../../../planning/qa/artifacts/sprint-1a-fix");
const RUNS = ["shop", "shop-clean", "twin", "twin2"] as const;
const load = (run: string, f: string): unknown[] => JSON.parse(readFileSync(path.join(ROOT, run, f), "utf8")) as unknown[];
const fmt = (r: { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } }) =>
  r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

describe("артефакти S1a-fix проходять схеми", () => {
  for (const run of RUNS) {
    it(`${run}: pages.json / evidence.json / findings.json`, () => {
      expect(existsSync(path.join(ROOT, run, "pages.json"))).toBe(true);
      const pages = load(run, "pages.json");
      expect(pages.length).toBeGreaterThan(0);
      for (const p of pages) {
        const r = PageArtifactCapture.safeParse(p);
        expect(r.success, r.success ? "" : fmt(r)).toBe(true);
      }
      const evidence = load(run, "evidence.json");
      const findings = load(run, "findings.json");
      const ids = new Set<string>();
      for (const e of evidence) {
        const r = Evidence.safeParse(e);
        expect(r.success, r.success ? "" : fmt(r)).toBe(true);
        ids.add((e as { id: string }).id);
      }
      for (const f of findings) {
        const r = Finding.safeParse(f);
        expect(r.success, r.success ? "" : fmt(r)).toBe(true);
        for (const id of (f as { evidence_ids: string[] }).evidence_ids) expect(ids.has(id), `evidence ${id} існує`).toBe(true);
      }
      // ключі знахідок унікальні → findingId без колізій
      const keys = findings.map((f) => (f as { finding_key: string }).finding_key);
      expect(new Set(keys.map(findingId)).size).toBe(keys.length);
    });
  }

  it("покриття: у shop є і presence, і absence, і axe, і BENCHMARKED", () => {
    const ev = load("shop", "evidence.json") as Array<{ assertion: string; type: string; source_class: string }>;
    expect(new Set(ev.map((e) => e.assertion))).toEqual(new Set(["presence", "absence"]));
    expect(ev.some((e) => e.type === "axe" && e.source_class === "BENCHMARKED")).toBe(true);
  });

  it("tierOf: усі докази S1a — ET-DET (повне захоплення, self_confirming)", () => {
    for (const run of RUNS) for (const e of load(run, "evidence.json")) expect(tierOf(Evidence.parse(e))).toBe("ET-DET");
  });
});

describe("зіпсований Evidence відхиляється", () => {
  const good = () => structuredClone(load("shop", "evidence.json").find((e) => (e as { assertion: string }).assertion === "absence")) as Record<string, unknown>;
  const rejects = (mut: (e: Record<string, unknown>) => void, needle: RegExp) => {
    const e = good();
    expect(Evidence.safeParse(e).success, "базовий зразок валідний").toBe(true);
    mut(e);
    const r = Evidence.safeParse(e);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(needle);
  };

  it("без source_class", () => rejects((e) => { delete e.source_class; }, /source_class/));
  it("невідомий source_class", () => rejects((e) => { e.source_class = "GUESSED"; }, /source_class/));
  it("невідомий type", () => rejects((e) => { e.type = "vibes"; }, /"type"/));
  it("невідомий claim_kind", () => rejects((e) => { e.claim_kind = "looks_bad"; }, /claim_kind/));
  it("claim_kind не з категорії", () => rejects((e) => { e.claim_kind = "horizontal_overflow"; }, /не належить категорії/));
  it("без artifact_reference / selector_or_region (§23)", () => {
    rejects((e) => { delete e.artifact_reference; }, /artifact_reference/);
    rejects((e) => { e.selector_or_region = {}; }, /selector_or_region/);
  });
  it("VERIFIED-шлях: absence + capture_complete=false + self_confirming=true (DEV-17/19)", () =>
    rejects((e) => { e.capture_complete = false; e.incomplete_reasons = ["blocked_requests:1"]; e.self_confirming = true; }, /DEV-17/));
  it("capture_complete=false без incomplete_reasons", () => rejects((e) => { e.capture_complete = false; e.self_confirming = false; }, /incomplete_reasons/));
  it("evidence_tier ET-DET при capture_complete=false", () =>
    rejects((e) => { e.capture_complete = false; e.incomplete_reasons = ["x"]; e.self_confirming = false; e.evidence_tier = "ET-DET"; }, /ET-DET/));
  it("capture_complete=true, але є заблоковані запити", () =>
    rejects((e) => { (e.capture_context as Record<string, unknown>).blocked_requests_count = 2; }, /capture_context/));
  it("SYNTHETIC без session_id/lens_id і self_confirming=true", () =>
    rejects((e) => { e.source_class = "SYNTHETIC"; e.self_confirming = true; }, /SYNTHETIC/));
  it("невідоме поле (strict)", () => rejects((e) => { e.confidence_pct = 87; }, /Unrecognized|confidence_pct/));

  it("позитивний контроль: та сама ситуація, але чесно ET-INC — приймається", () => {
    const e = good();
    e.capture_complete = false; e.incomplete_reasons = ["blocked_requests:1"]; e.self_confirming = false;
    const r = Evidence.parse(e);
    expect(tierOf(r)).toBe("ET-INC");
  });
});

describe("зіпсований Finding відхиляється", () => {
  const base = () => structuredClone(load("shop", "findings.json")[2]) as Record<string, unknown>;
  const rejects = (mut: (f: Record<string, unknown>) => void, needle: RegExp) => {
    const f = base();
    expect(Finding.safeParse(f).success).toBe(true);
    mut(f);
    const r = Finding.safeParse(f);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(needle);
  };
  it("без доказів (§23)", () => rejects((f) => { f.evidence_ids = []; }, /evidence_ids/));
  it("VERIFIED на родині F-INC (DEV-17/19)", () =>
    rejects((f) => { f.evidence_families = ["F-INC"]; f.evidence_strength = 0.3; f.confidence = "VERIFIED"; }, /F-INC/));
  it("F-DET зі strength ≠ 1", () => rejects((f) => { f.evidence_strength = 0.4; }, /evidence_strength/));
  it("finding_key ≠ полям", () => rejects((f) => { f.finding_key = "pricing|product|below_fold"; }, /finding_key/));
  it("відсоток конверсії не проходить (strict)", () => rejects((f) => { f.uplift_pct = 12; }, /Unrecognized|uplift_pct/));
  it("finding_key: build/parse круговий і відхиляє сміття", () => {
    const k = buildFindingKey({ category: "accessibility", page_group: "*", claim_kind: "axe:button-name", component: "header/button" });
    expect(k).toBe("accessibility|*|axe:button-name|header/button");
    expect(parseFindingKey(k)?.component).toBe("header/button");
    expect(parseFindingKey("pricing|product")).toBeNull();
    expect(parseFindingKey("nope|product|below_fold")).toBeNull();
    expect(() => buildFindingKey({ category: "cta", page_group: "a|b", claim_kind: "below_fold" })).toThrow();
  });
});
