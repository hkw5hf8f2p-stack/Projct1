/**
 * E1_llm за SCORING_SPEC §14.2 (DEV-91): дефект №1/№3/№4 зараховується лише за точну сторінку EXPECTED + категорію + перевірену
 * цитату, прив'язану до якоря засіяного елемента. Кожне правило — позитив і контроль (правило вміє НЕ зарахувати).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorHit, e1, e1LlmAnchored, type E1AnchorSpec, type Family, type VEvidence, type VFinding } from "../src/index.js";

const EXP = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/shop/EXPECTED.json"), "utf8")) as {
  defects: Array<{ id: number; type: string; pages: string[]; categories: string[]; claim_kind: string | null; anchors?: string[] }>;
};
const SPECS: E1AnchorSpec[] = EXP.defects.filter((d) => d.type !== "deterministic").map((d) => ({ id: d.id, pages: d.pages, categories: d.categories, claim_kind: d.claim_kind, anchors: d.anchors ?? [] }));

const pg = (p: string) => (p === "/" ? "/" : p.startsWith("/product/") ? "product" : p === "/catalog" ? "category" : p);
const L = (category: string, evidence: VEvidence[], o: { families?: Family[]; claim_kind?: string } = {}): VFinding => ({
  finding_key: `${category}|${pg(evidence[0]?.page_path ?? "/")}|${o.claim_kind ?? "general"}`, category, page_group: pg(evidence[0]?.page_path ?? "/"),
  claim_kind: o.claim_kind ?? "general", confidence: "HYPOTHESIS", priority: 50, rank: 1, families: o.families ?? ["F-SYN"],
  pages: evidence.map((e) => e.page_path), evidence,
});
const Q = (page_path: string, excerpt: string | null): VEvidence => ({ page_path, source_class: "SYNTHETIC", excerpt });
const got = (fs: VFinding[]) => { const r = e1LlmAnchored(SPECS, fs); return Object.fromEntries(r.detected.map((d) => [d.id, d.detected])); };

describe("EXPECTED.json: №1/№3/№4 мають якорі й точні сторінки (зафіксовано до перерахунку)", () => {
  it("pages і anchors", () => {
    expect(SPECS.map((s) => [s.id, s.pages])).toEqual([[1, ["/"]], [3, ["/catalog"]], [4, ["/catalog"]]]);
    for (const s of SPECS) expect(s.anchors.length).toBeGreaterThan(0);
  });
});

describe("e1LlmAnchored: позитив", () => {
  it("№1: value_proposition на / з цитатою H1 (без лапок у моделі — excerpt уже перевірено §14.1)", () => {
    expect(got([L("value_proposition", [Q("/", "Ідеї, що змінюють будні")])])).toEqual({ 1: true, 3: false, 4: false });
  });
  it("№1: частина підзаголовка засіяного блоку (якір ⊇ цитата)", () => {
    expect(got([L("visual_hierarchy", [Q("/", "Ми підбираємо речі, які роблять день простішим.")])])[1]).toBe(true);
  });
  it("№3: terminology на /catalog, цитата містить термін HFX (цитата ⊇ якір)", () => {
    expect(got([L("terminology", [Q("/catalog", "AquaPro X200 (система HFX)")])])).toEqual({ 1: false, 3: true, 4: false });
  });
  it("№4: comparison на /catalog, однаковий опис карток", () => {
    expect(got([L("comparison", [Q("/catalog", "Фільтр для води з проточною кухонною установкою")])])).toEqual({ 1: false, 3: false, 4: true });
  });
  it("неоднозначність фікстури (задокументована): product_selection + «AquaPro X200 (система HFX)» на /catalog → і №3, і №4", () => {
    expect(got([L("product_selection", [Q("/catalog", "AquaPro X200 (система HFX)")])])).toEqual({ 1: false, 3: true, 4: true });
  });
  it("інша форма лапок/регістр/пробіли у цитаті-доказі не заважає прив'язці", () => {
    expect(anchorHit("  ідеї, що ЗМІНЮЮТЬ  будні…", ["Ідеї, що змінюють будні"])).toBe(true);
  });
});

describe("e1LlmAnchored: контролі — НЕ зараховується", () => {
  it("та сама категорія з прив'язаною цитатою на ІНШІЙ сторінці (жаргон на сторінці продукту) → №3 ні; діагностика other_page", () => {
    const f = L("terminology", [Q("/product/aquapro-x200", "AquaPro X200 (система HFX)")]);
    const r = e1LlmAnchored(SPECS, [f]);
    expect(r.y).toBe(0);
    expect(r.other_page.map((x) => [x.id, x.page])).toEqual([[3, "/product/aquapro-x200"]]);
    // старе правило категорії (§8.1) цю знахідку зарахувало б — саме це й звужено
    expect(e1([{ ...f, page_group: "product" }]).llm.y).toBe(1);
  });
  it("№1: value_proposition на /catalog (правильна категорія, чужа сторінка) → ні", () => {
    expect(got([L("value_proposition", [Q("/catalog", "Ідеї, що змінюють будні")])])[1]).toBe(false);
  });
  it("потрібна сторінка й категорія, але цитата не засіяного місця («Прибрати з порівняння») → ні; діагностика unanchored", () => {
    const r = e1LlmAnchored(SPECS, [L("terminology", [Q("/catalog", "Прибрати з порівняння")]), L("comparison", [Q("/catalog", "Три моделі для щоденного вжитку.")])]);
    expect(r.y).toBe(0);
    expect(r.unanchored.map((x) => x.id).sort()).toEqual([3, 4]);
    expect(r.unexpected.length).toBe(2);
  });
  it("NOT_FOUND (excerpt = null) не зараховує: нема чим прив'язати", () => {
    expect(got([L("value_proposition", [Q("/", null)])])[1]).toBe(false);
  });
  it("прив'язана цитата, але категорія не з EXPECTED (shipping на /) → ні", () => {
    expect(got([L("shipping", [Q("/", "Ідеї, що змінюють будні")])])[1]).toBe(false);
  });
  it("не LLM-лише (є F-DET) або не SYNTHETIC-доказ → ні", () => {
    expect(got([L("value_proposition", [Q("/", "Ідеї, що змінюють будні")], { families: ["F-DET", "F-SYN"] })])[1]).toBe(false);
    expect(got([L("value_proposition", [{ page_path: "/", source_class: "OBSERVED", excerpt: "Ідеї, що змінюють будні" }])])[1]).toBe(false);
  });
  it("знахідка без evidence (старий формат VFinding) → ні", () => {
    const f = L("value_proposition", [Q("/", "x")]);
    expect(got([{ ...f, evidence: undefined }])[1]).toBe(false);
  });
  it("порожня цитата/порожній якір не збігаються", () => {
    expect(anchorHit("", ["HFX"])).toBe(false);
    expect(anchorHit("будь-що", [""])).toBe(false);
  });
});
