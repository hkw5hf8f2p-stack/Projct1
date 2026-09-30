/**
 * buildReport (S4 п.3): детермінований звіт без LLM на артефактах sprint-1a-fix; критерії S4 №1, №2, №6; §29; DEV-49.
 * Артефакт: planning/qa/artifacts/sprint-4/report-fixture-nollm*.json (лише з SL_WRITE_ARTIFACTS=1, X-1).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Evidence, Report, collectTexts, renderText, type Report as ReportT } from "@sitelens/schemas";
import { artifactDir } from "../../../scripts/artifact-dir.js";
import { buildReport, loadS1aRun, positiveFindings, type AuditArtifacts } from "../src/index.js";
import { EXAMPLE_LLM } from "../src/testing/example-llm.js";
import { exampleReport, FIXED_TS, SHOP_CLEAN_RUN_DIR, SHOP_RUN_DIR } from "../src/testing/example-report.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const EXPECTED = JSON.parse(readFileSync(path.join(ROOT, "fixtures/shop/EXPECTED.json"), "utf8")) as {
  defects: Array<{ id: number; type: string; categories: string[]; page_groups: string[]; detector_id: string | null; detector_ids?: string[] }>;
};
const load = (dir: string): AuditArtifacts => loadS1aRun(dir, { language: "uk", id: `aud_${path.basename(dir)}`, created_at: FIXED_TS, completed_at: FIXED_TS, snapshot_at: FIXED_TS });
const build = (dir: string) => buildReport(load(dir), null, { generated_at: FIXED_TS }).report;

/** EXPECTED.json → знахідка звіту (E1 detected, SCORING_SPEC §8.1): категорія, page_group («*» = будь-яка), детектор, VERIFIED */
function detected(r: ReportT) {
  return EXPECTED.defects.filter((d) => d.type === "deterministic").map((d) => {
    const dets = d.detector_ids ?? [d.detector_id];
    const f = r.findings.find((x) => d.categories.includes(x.category) && (d.page_groups.includes("*") || d.page_groups.includes(x.page_group)) && x.evidence_ids.some((id) => dets.includes(r.evidence.find((e) => e.id === id)?.detector_id ?? "")));
    return { id: d.id, key: f?.finding_key ?? null, verified: f?.confidence.level === "VERIFIED", rank: f?.rank ?? null };
  });
}

const save = (name: string, v: unknown) => {
  const dir = artifactDir("sprint-4");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(v, null, 2) + "\n");
};

describe("звіт без LLM на фікстурі shop (llm_mode=none)", () => {
  const r = build(SHOP_RUN_DIR);
  const det = detected(r);
  save("report-fixture-nollm.json", r);
  save("report-fixture-nollm-e1.json", { schema: "sitelens-s4-e1/v1", source: "planning/qa/artifacts/sprint-1a-fix/shop", llm_mode: r.audit.llm_mode, deterministic: det, verified_in_top10: det.filter((d) => d.verified && (d.rank ?? 99) <= 10).length, of: det.length });

  it("критерій 2: 7/7 детермінованих дефектів — VERIFIED і в топ-10", () => {
    expect(det).toHaveLength(7);
    expect(det.filter((d) => d.verified && d.rank !== null && d.rank <= 10).map((d) => d.id)).toEqual([2, 5, 6, 7, 8, 9, 10]);
  });
  it("перевірка 7/7 уміє впасти: без доказів детектора №7 рахується 6/7", () => {
    const art = load(SHOP_RUN_DIR);
    art.evidence = art.evidence.filter((e) => e.detector_id !== "horizontal_overflow");
    const d2 = detected(buildReport(art, null, { generated_at: FIXED_TS }).report);
    expect(d2.filter((d) => d.verified).length).toBe(6);
  });
  it("критерій 1: 0 знахідок без доказу, 0 рекомендацій поза знахідкою (структурно)", () => {
    const ids = new Set(r.evidence.map((e) => e.id));
    expect(r.findings.every((f) => f.evidence_ids.length > 0 && f.evidence_ids.every((id) => ids.has(id)))).toBe(true);
    expect(Object.keys(r).includes("recommendations")).toBe(false);
  });
  it("режим none (DEV-11): банер, LLM-розділи null, 0 токенів, лише тексти коду, LLM-етапи skipped", () => {
    expect(r.audit.banners.map((b) => b.code)).toContain("no_llm");
    expect([r.site_understanding, r.lenses, r.executive_summary.primary_conversion_goal]).toEqual([null, null, null]);
    expect([r.budget.used_tokens, r.budget.llm_calls, r.budget.cost]).toEqual([0, 0, null]);
    expect(collectTexts(r).every((t) => t.text.origin === "code")).toBe(true);
    expect(r.audit.stage_status.snapshot_sessions?.status).toBe("skipped");
  });
  it("кожен текст рендериться; поза плейсхолдерами — жодної цифри (числа лише з полів)", () => {
    for (const { text } of collectTexts(r)) {
      expect(() => renderText(text, r, "uk")).not.toThrow();
      expect(text.template.replace(/\{[a-z_]+\}/g, "")).not.toMatch(/\p{Nd}/u);
    }
  });
  it("shop: позитивів немає — кожен вимір має проблемну знахідку (позитив уміє бути хибним)", () => {
    expect(r.positive_findings).toEqual([]);
  });
});

describe("звіт без LLM на shop-clean: 0 знахідок + позитивні знахідки §29", () => {
  const r = build(SHOP_CLEAN_RUN_DIR);
  save("report-fixture-nollm-shop-clean.json", r);
  it("0 знахідок, ≥ 1 позитив, кожен позитив має OBSERVED-докази", () => {
    expect(r.findings).toHaveLength(0);
    expect(r.positive_findings.map((p) => p.key)).toEqual([
      "cta_in_first_viewport|product", "images_have_alt|*", "no_horizontal_overflow|*", "price_in_first_viewport|product", "shipping_on_product_page|product",
    ]);
    for (const p of r.positive_findings) {
      expect(p.evidence_ids.length).toBeGreaterThan(0);
      expect(p.evidence_ids.every((id) => r.evidence.find((e) => e.id === id)?.polarity === "positive")).toBe(true);
    }
    expect(r.executive_summary.top_strength_ids).toHaveLength(5);
  });
  it("предикат позитиву вміє впасти: ціна поза першим екраном на одному товарі → позитиву ціни немає", () => {
    const art = load(SHOP_CLEAN_RUN_DIR);
    const p = art.pages.find((x) => x.page_type === "product")!;
    p.captures.M!.price_candidates = p.captures.M!.price_candidates.map((c) => ({ ...c, in_fv: false }));
    expect(positiveFindings(art.pages, []).positives.map((x) => x.kind)).not.toContain("price_in_first_viewport");
  });
  it("неповне захоплення → позитив утримано (withheld), не показано", () => {
    const art = load(SHOP_CLEAN_RUN_DIR);
    const p = art.pages.find((x) => x.page_type === "product")!;
    p.capture.D = { capture_complete: false, incomplete_reasons: ["blocked_requests"] };
    const res = positiveFindings(art.pages, []);
    expect(res.positives.map((x) => x.kind)).not.toContain("price_in_first_viewport");
    expect(res.withheld.find((w) => w.key === "price_in_first_viewport|product")?.reason).toMatch(/^capture_incomplete:/);
  });
  it("проблемна знахідка того самого виміру прибирає позитив (узгодженість)", () => {
    const art = load(SHOP_CLEAN_RUN_DIR);
    expect(positiveFindings(art.pages, ["pricing|product|not_in_first_viewport"]).positives.map((x) => x.kind)).not.toContain("price_in_first_viewport");
  });
});

describe("з LLM-даними (приклад, replay): структурне правило, асиметрія, DEV-49", () => {
  const { report, rejected } = buildReport(load(SHOP_RUN_DIR), EXAMPLE_LLM, { generated_at: FIXED_TS, provenance: { kind: "example_fixture", note: null } });
  it("тексти з цифрою або числівником відхилено й замінено шаблоном коду", () => {
    expect(rejected.map((x) => x.reason.split(":")[0])).toEqual(["number", "number"]);
    expect(rejected.some((x) => x.reason.includes("3"))).toBe(true);
    expect(rejected.some((x) => /Половина/i.test(x.reason))).toBe(true);
    expect(collectTexts(report).some(({ text }) => /Половина|\p{Nd}/u.test(text.template.replace(/\{[a-z_]+\}/g, "")))).toBe(false);
  });
  it("«N of M synthetic …» підставляє код; застереження G0-25 присутнє", () => {
    const f = report.findings.find((x) => x.finding_key === "terminology|category|general")!;
    expect(renderText(f.problem, report, "uk")).toContain("3 з 4 синтетичних лінз");
    expect(report.disclaimers).toContain("synthetic_single_model_correlated");
  });
  it("критерій 2 з гіпотезами поруч: 7/7 VERIFIED і в топ-10", () => {
    expect(detected(report).filter((d) => d.verified && (d.rank ?? 99) <= 10)).toHaveLength(7);
  });
  it("DEV-49: pole_unmet з етапу лінз доходить до звіту", () => {
    expect(report.coverage.pole_unmet).toEqual([{ pole: "P6", nearest_lens_id: "lens_expert" }]);
    const r2 = buildReport(load(SHOP_RUN_DIR), { ...EXAMPLE_LLM, pole_unmet: [] }, { generated_at: FIXED_TS, provenance: { kind: "example_fixture", note: null } }).report;
    expect(r2.coverage.pole_unmet).toEqual([]);
  });
  it("закомічений приклад для S5 = вихід будівника (без дрейфу)", () => {
    const committed = JSON.parse(readFileSync(path.join(ROOT, "packages/schemas/examples/report.fixture.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(exampleReport())));
    expect(Report.safeParse(committed).success).toBe(true);
  });
});

describe("детермінізм звіту (критерій 6)", () => {
  it("контракт відмовляє «аудиту» з LLM-текстами, що не пройшли guard (guard звіту ще не підключено)", () => {
    expect(() => buildReport(load(SHOP_RUN_DIR), EXAMPLE_LLM, { generated_at: FIXED_TS })).toThrow(/без guard/);
  });
  it("3 прогони й перестановка доказів → байт-ідентичний звіт", () => {
    const o = { generated_at: FIXED_TS, provenance: { kind: "example_fixture" as const, note: null } };
    const runs = [0, 1, 2].map(() => JSON.stringify(buildReport(load(SHOP_RUN_DIR), EXAMPLE_LLM, o).report));
    const art = load(SHOP_RUN_DIR);
    art.evidence = art.evidence.slice().reverse();
    const llm = { ...EXAMPLE_LLM, evidence: EXAMPLE_LLM.evidence.slice().reverse(), sessions: EXAMPLE_LLM.sessions.slice().reverse() };
    runs.push(JSON.stringify(buildReport(art, llm, o).report));
    expect(new Set(runs).size).toBe(1);
  });
  it("контроль: інший вхід → інший звіт", () => {
    const art = load(SHOP_RUN_DIR);
    art.evidence = art.evidence.filter((e) => e.detector_id !== "oversized_image");
    expect(JSON.stringify(buildReport(art, null, { generated_at: FIXED_TS }).report)).not.toBe(JSON.stringify(build(SHOP_RUN_DIR)));
  });
  it("вхідні докази — валідні за v3-контрактом S1a", () => {
    expect(load(SHOP_RUN_DIR).evidence.every((e) => Evidence.safeParse(e).success)).toBe(true);
  });
});
