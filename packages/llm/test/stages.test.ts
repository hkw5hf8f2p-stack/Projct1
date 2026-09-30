import { beforeAll, describe, expect, it } from "vitest";
import {
  LlmClient, ReplayMissError, ScriptedFakeProvider, TokenBudget, buildScenarioMatrix, buildSiteProfile, createClientFromEnv, generateLenses, generateTasks, loadPagesFromArtifacts,
  poleById, resolveAuditLanguage, selectPagesForProfile, wrapPageData, candidateToLens, LensCandidate, MAX_PROFILE_IMAGES, type LogicalKey, type PageInput, type ScriptEntry,
} from "../src/index.js";
import { lensGeneratorV1 } from "../prompts/lens-generator-v1.js";
import { siteProfileV1 } from "../prompts/site-profile-v1.js";
import { shopLensCandidates, shopProfileResponse, shopTasksResponse } from "../src/testing/synthetic-shop.js";
import { SHOP_ARTIFACTS } from "./helpers.js";

let pages: PageInput[];
beforeAll(() => { pages = loadPagesFromArtifacts(SHOP_ARTIFACTS); });
const fake = (entries: Array<[LogicalKey, ScriptEntry]>) => new LlmClient({ mode: "fake", provider: ScriptedFakeProvider.from(entries), budget: new TokenBudget(5_000_000) });
const goodProfile = () => { const { evidence: _e, ...core } = shopProfileResponse(); void _e; return core as never; };
const lens = (id: string, ds: number, dp: number, k: number) => ({ ...shopLensCandidates()[5]!, id, name: `Дослідник ${k}`, decision_speed: ds, detail_preference: dp, primary_goal: `Унікальна мета дослідження номер ${k} ${id}`, category_knowledge: 0.2 + k / 20, price_sensitivity: k / 10, trust_requirement: 0.3 + k / 15 });

describe("генерація лінз: запит недостатніх полюсів (§9.4) і прапорці", () => {
  const p6 = poleById("P6");
  const withoutP6 = () => shopLensCandidates().filter((c) => !p6.pred(candidateToLens(LensCandidate.parse(c), "r").lens));
  it("немає P6 серед кандидатів → ОДИН додатковий запит про відсутній полюс → покрито, poles_requested_again", async () => {
    expect(withoutP6().length).toBeLessThan(18);
    const extra = { lenses: [lens("l19", 0.1, 0.9, 1), lens("l20", 0.15, 0.85, 2), lens("l21", 0.2, 0.8, 3)] };
    const client = fake([
      [{ prompt_id: lensGeneratorV1.id, step: 0 }, { response: { lenses: withoutP6() } }],
      [{ prompt_id: lensGeneratorV1.id, step: 1 }, { response: extra }],
    ]);
    const r = await generateLenses({ audit_run_id: "r", client, language: "uk" }, { profile: goodProfile() });
    expect(r.status).toBe("done");
    expect(r.flags).toContain("poles_requested_again");
    expect(r.flags).not.toContain("pole_unmet:P6");
    expect(r.output!.lenses.some((l) => p6.pred(l))).toBe(true);
    expect(r.output!.lenses).toHaveLength(12);
    expect(client.records).toHaveLength(2);
    expect(client.records[1]!.prompt_id).toBe(lensGeneratorV1.id);
  });
  it("і після запиту полюса нема → pole_unmet:P6 + найближчий кандидат, етап done (не мовчазний пропуск)", async () => {
    const client = fake([
      [{ prompt_id: lensGeneratorV1.id, step: 0 }, { response: { lenses: withoutP6() } }],
      [{ prompt_id: lensGeneratorV1.id, step: 1 }, { response: { lenses: [lens("l19", 0.9, 0.9, 4), lens("l20", 0.8, 0.2, 5), lens("l21", 0.7, 0.3, 6)] } }],
    ]);
    const r = await generateLenses({ audit_run_id: "r", client, language: "uk" }, { profile: goodProfile() });
    expect(r.status).toBe("done");
    expect(r.flags).toContain("pole_unmet:P6");
    expect(r.output!.selection.unmet_poles).toContain("P6");
    expect(r.output!.lenses).toHaveLength(12);
  });
  it("unknown у змінній → 0.5 + прапорець unknown_var (SCORING_SPEC §9.1), лінза не відкидається", async () => {
    const c = shopLensCandidates(); (c[8] as Record<string, unknown>).social_proof_need = "unknown";
    const r = await generateLenses({ audit_run_id: "r", client: fake([[{ prompt_id: lensGeneratorV1.id, step: 0 }, { response: { lenses: c } }]]), language: "uk" }, { profile: goodProfile(), k: 18 });
    expect(r.flags).toContain("unknown_var:l09:social_proof_need");
    expect(r.output!.lenses.find((l) => l.id === "l09")!.social_proof_need).toBe(0.5);
  });
  it("промпт лінз: мова аудиту, 18 кандидатів, профіль загорнуто як дані, sampling без temperature", async () => {
    const provider = ScriptedFakeProvider.from([[{ prompt_id: lensGeneratorV1.id, step: 0 }, { response: { lenses: shopLensCandidates() } }]]);
    const seen: string[] = [];
    const spy = { ...provider, name: "fake" as const, model: "scripted-fake", received: provider.received, complete: async (req: Parameters<typeof provider.complete>[0]) => { seen.push(JSON.stringify(req)); return provider.complete(req); } };
    await generateLenses({ audit_run_id: "r", client: new LlmClient({ mode: "fake", provider: spy, budget: new TokenBudget(1e7) }), language: "uk" }, { profile: goodProfile() });
    const req = JSON.parse(seen[0]!);
    expect(req.content[0].text).toContain("Ukrainian");
    expect(req.content[0].text).toContain("exactly 18");
    expect(req.content[0].text).toContain("<<<DERIVED_DATA>>>");
    expect(req.sampling).toEqual({ max_tokens: 8000 });
  });
});

describe("SiteProfile / tasks: поведінка етапів", () => {
  it("ReplayMissError НЕ проковтується етапом (гучна помилка доходить до worker, G0-16)", async () => {
    const client = fake([]); // порожній скрипт
    await expect(buildSiteProfile({ audit_run_id: "r", client, language: "uk" }, { pages })).rejects.toBeInstanceOf(ReplayMissError);
  });
  it("вибір сторінок і зображень обмежено (SPEC §51): ≤ 8 сторінок, ≤ 3 зображення, ≤ 2 товари; тайли, не full-page", () => {
    const sel = selectPagesForProfile(pages);
    expect(sel.length).toBeLessThanOrEqual(8);
    expect(sel.filter((p) => p.page_type === "product").length).toBeLessThanOrEqual(2);
    expect(MAX_PROFILE_IMAGES).toBe(3);
    for (const p of sel) if (p.image) expect(p.image.path).toMatch(/1440x1000\/viewport\.png$/);
  });
  it("profile: запит містить ≤ 3 зображення, делімітери, мову; вихід несе prompt_id і посилання на докази", async () => {
    const first = selectPagesForProfile(pages)[0]!;
    const client = fake([[{ prompt_id: siteProfileV1.id, page_url: first.url, step: 0 }, { response: shopProfileResponse() }]]);
    const r = await buildSiteProfile({ audit_run_id: "r", client, language: "uk" }, { pages });
    expect(r.status).toBe("done");
    expect(r.output!.prompt_id).toBe("site-profile-v1");
    expect(r.output!.evidence.length).toBeGreaterThanOrEqual(3);
    expect(r.output!.pages_used).toContain("index");
    expect(wrapPageData(selectPagesForProfile(pages))).toContain("<<<END_PAGE_DATA");
  });
  it("tasks: 4–7, start page → URL сторінки, audit_run_id проставляє код; «оплата» як ТЕМА (доставка й оплата) не блокується, як ДІЯ — блокується", async () => {
    const ok = shopTasksResponse();
    ok.tasks[3]!.goal = "З'ясувати умови доставки й оплати при отриманні."; // тема, не дія
    const r = await generateTasks({ audit_run_id: "run_t", client: fake([[{ prompt_id: "task-generator-v1", step: 0 }, { response: ok }]]), language: "uk" }, { pages, profile: goodProfile() });
    expect(r.status).toBe("done");
    expect(r.output!.tasks).toHaveLength(6);
    expect(r.output!.tasks[0]!.recommended_start_page).toMatch(/^http:\/\/127\.0\.0\.1:4210/);
    expect(r.output!.tasks.every((t) => t.audit_run_id === "run_t")).toBe(true);
    const bad = shopTasksResponse(); bad.tasks[3]!.goal = "Оплатити доставку карткою.";
    const rb = await generateTasks({ audit_run_id: "run_t", client: fake([[{ prompt_id: "task-generator-v1", step: 0 }, { response: bad }], [{ prompt_id: "task-generator-v1", step: 0, attempt: 1 }, { response: bad }]]), language: "uk" }, { pages, profile: goodProfile() });
    expect(rb.status).toBe("failed");
  });
  it("матриця без LLM-виклику; при llm_mode none — skipped", async () => {
    const { client } = createClientFromEnv({});
    const r = await buildScenarioMatrix({ audit_run_id: "r", client, language: "uk" }, { lenses: [], tasks: [] });
    expect(r.status).toBe("skipped");
  });
});

describe("мова аудиту (D2, OQ-4, R-19)", () => {
  const pg = (t: string): PageInput => ({ id: "p", url: "http://x/", page_type: "homepage", title: "", meta_description: "", headings: [], visible_text: t, link_texts: [], image: null });
  it("за замовчуванням — мова сайту; явне значення має пріоритет; невизначене → uk", () => {
    expect(resolveAuditLanguage(undefined, pages)).toBe("uk");
    expect(resolveAuditLanguage(undefined, [pg("We sell water filters and softeners for your home. Free delivery in two days across the country.")])).toBe("en");
    expect(resolveAuditLanguage("en", pages)).toBe("en");
    expect(resolveAuditLanguage("uk", [pg("We sell water filters and softeners for your home. Free delivery in two days.")])).toBe("uk");
    expect(resolveAuditLanguage(undefined, [pg("ok")])).toBe("uk");
    expect(resolveAuditLanguage("de", pages)).toBe("uk");
  });
});
