/**
 * `pnpm validate` — критерій S4 №8 (чесно: 3 FAIL + 1 показник) і PASS на коректному fake-наборі, без браузера
 * (закомічені знімки sprint-1a-fix: shop, shop-clean; E3c — sprint-4/validate/snapshots site-a/site-b). Кожна перевірка — позитив і негатив.
 *  (а) оцінювач вигадує terminology на чистій сторінці → E3a FAIL
 *  (б) три різні топи → E2 FAIL (тривіально: різні знімки). Чутлива форма — нестабільний ОЦІНЮВАЧ на ЗАМОРОЖЕНОМУ знімку:
 *      E2(б) Jcat < 0.4 (показник падає й це видно), але E2(а) PASS — E2(б) за G0-8 не гейт (відоме обмеження)
 *  (в) cache_read_tokens > 0 → E2 «недійсний» (INVALID)
 *  (г) абляція: LLM-лише 0/3 → показник 0/3 видно, у dev не гейт (з --strict-live → FAIL)
 * Плюс гейт рангу E1 (кр.2, DEV-76) з контролем scoring-v1 і E3c dev-статус лише за кодом (DEV-77).
 * Плюс: жорсткий MAX_VALIDATE_TOKENS зі стопом, обхід кешу доведено лічильником, replay-плумбінг, механізм абляції, правила fake-оцінювача.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, loadPagesFromArtifacts } from "../../packages/llm/src/index.js";
import { ablateHints, e3cStatus, loadSnapshot, runValidation, formatResult, buildRunReport, ValidateMeter, ValidateBudgetStop, type CheckResult, type ValidateResult } from "./core.js";
import { VALIDATE_LENSES, pagesToEvaluate, plannedCalls, runSnapshotSessions, type EvaluatorSpec } from "./evaluator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const A = (s: string) => path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix", s);
const SNAP = { shop: A("shop"), clean: A("shop-clean") };
const V = (s: string) => path.join(ROOT, "planning/qa/artifacts/sprint-4/validate/snapshots", s);
const CHECKS = ["E1", "E2", "E3a", "E4"] as const;
const by = (r: ValidateResult, id: string): CheckResult => r.checks.find((c) => c.id === id) as CheckResult;

let good: ValidateResult;
beforeAll(async () => {
  good = await runValidation({ snapshots: SNAPSHOT_OK(), checks: CHECKS });
});
function SNAPSHOT_OK() { return SNAP; }

describe("коректний fake-набір → PASS (E1, E2, E3a, E4)", () => {
  it("вердикт PASS; усі чотири перевірки PASS", () => {
    expect(good.verdict).toBe("PASS");
    expect(good.checks.map((c) => [c.id, c.status])).toEqual([["E1", "PASS"], ["E2", "PASS"], ["E3a", "PASS"], ["E4", "PASS"]]);
  });
  it("E1: дві цифри окремо — детерміновані 7/7 і LLM-лише 3/3 (fake); сума 10", () => {
    const d = by(good, "E1").data as { full: { det: { x: number; of: number }; total: number }; ablation: { llm: { y: number; of: number } } };
    expect(d.full.det).toEqual({ x: 7, of: 7 });
    expect(d.ablation.llm).toEqual({ y: 3, of: 3 });
    expect(d.full.total).toBe(10);
    expect(by(good, "E1").lines.join("\n")).toMatch(/детерміновані x\/7 = 7\/7/);
    expect(by(good, "E1").lines.join("\n")).toMatch(/LLM-лише y\/3 = 3\/3/);
  });
  it("E1 гейт рангу (кр.2, DEV-76): 7/7 у топ-10 на повному звіті з 4 гіпотезами; контроль scoring-v1 на тому ж звіті → FAIL, №8 → 12", () => {
    const d = by(good, "E1").data as { rank: { pass: boolean; in_top: number; findings: number; hypotheses: number; ranks: Array<{ id: number; rank: number | null }> }; rank_v1_control: { pass: boolean; in_top: number; ranks: Array<{ id: number; rank: number | null }> } };
    expect([d.rank.pass, d.rank.in_top, d.rank.findings, d.rank.hypotheses]).toEqual([true, 7, 12, 4]);
    expect(d.rank.ranks.find((x) => x.id === 8)?.rank).toBe(8);
    expect([d.rank_v1_control.pass, d.rank_v1_control.in_top]).toEqual([false, 6]);
    expect(d.rank_v1_control.ranks.find((x) => x.id === 8)?.rank).toBe(12);
    const txt = by(good, "E1").lines.join("\n");
    expect(txt).toMatch(/ранг \[ГЕЙТ, кр\.2\]: детерміновані в топ-10 = 7\/7/);
    expect(txt).toMatch(/контроль рангу: .* → 6\/7 FAIL ✓/);
    // у звіті: усі VERIFIED вище всіх гіпотез
    const lv = good.reports["e1-full"]!.findings.map((f) => f.confidence.level);
    expect(lv.lastIndexOf("VERIFIED")).toBeLessThan(lv.findIndex((l) => l !== "VERIFIED"));
    expect(good.reports["e1-full"]!.scoring_version).toBe("scoring-v2");
  });
  it("E2: 3 прогони bypass, cache_read_tokens = 0/0/0 при ПРОГРІТОМУ кеші; контроль use дає > 0", () => {
    const d = by(good, "E2").data as { validity: { valid: boolean }; control: { cache_read_tokens: number; invalid: boolean }; metrics: { jcat_mean: number; k3: string[] } };
    expect(d.validity.valid).toBe(true);
    expect(d.control.cache_read_tokens).toBeGreaterThan(0);
    expect(d.control.invalid).toBe(true);
    expect(d.metrics.jcat_mean).toBe(1);
    expect(d.metrics.k3.length).toBeGreaterThanOrEqual(3);
    for (const r of ["e2-run1", "e2-run2", "e2-run3"]) expect(good.reports[r]!.budget.cache_read_tokens, r).toBe(0);
  });
  it("E3a: 0 знахідок на чистому магазині (7 сторінок); E4: обмежений прогін має позначку, повний — ні", () => {
    expect((by(good, "E3a").data as { findings: string[] }).findings).toEqual([]);
    const e4 = by(good, "E4").data as { full: { llm_calls: number; planned_calls: number }; limited: { llm_calls: number; planned_calls: number }; tamper_detected: boolean };
    expect(e4.full.llm_calls).toBe(e4.full.planned_calls);
    expect(e4.limited.llm_calls).toBeLessThan(e4.limited.planned_calls);
    expect(e4.tamper_detected).toBe(true);
    expect(good.reports["e4-limited"]!.audit.banners.map((b) => b.code)).toContain("budget_limited");
  });
  it("провайдер названо чесно: scripted fake; звіт має банер replay_not_live; LLM-частина мічена ⏭️ live", () => {
    expect(good.provider).toBe("scripted-fake");
    expect(good.reports["e1-full"]!.audit.banners.map((b) => b.code)).toContain("replay_not_live");
    expect(good.reports["e1-full"]!.audit.llm_model).toMatch(/scripted-fake/);
    expect(formatResult(good)).toMatch(/⏭️ live/);
    expect(good.checks.filter((c) => c.id !== "E4").every((c) => c.live_deferred.length > 0)).toBe(true);
  });
  it("детермінізм: повторний запуск дає ті самі числа (крім нічого)", async () => {
    const again = await runValidation({ snapshots: SNAP, checks: ["E1", "E3a"] });
    expect(JSON.stringify(by(again, "E1").data)).toBe(JSON.stringify(by(good, "E1").data));
  });
});

describe("(а) оцінювач вигадує terminology на чистій сторінці → E3a FAIL", () => {
  let r: ValidateResult;
  beforeAll(async () => {
    r = await runValidation({ snapshots: SNAP, checks: ["E3a"], evaluators: { e3a: () => ({ kind: "invent_terminology" }) } });
  });
  it("E3a = FAIL, вердикт FAIL, порушення називають terminology", () => {
    expect(by(r, "E3a").status).toBe("FAIL");
    expect(r.verdict).toBe("FAIL");
    expect(by(r, "E3a").lines.join("\n")).toMatch(/terminology/);
  });
  it("вигадка ПРОЙШЛА агрегацію (цитата справжня) — тобто провалило саме гейт E3a, а не §23-відсів", () => {
    const rep = r.reports["e3a-clean"]!;
    expect(rep.findings.some((f) => f.category === "terminology")).toBe(true);
    expect((by(r, "E3a").data as { friction_rejections: number }).friction_rejections).toBe(0);
  });
  it("той самий прогін із чесним оцінювачем → PASS (перевірка не падає завжди)", () => {
    expect(by(good, "E3a").status).toBe("PASS");
  });
});

describe("(б) знімок не заморожений → три різні топи → E2 FAIL", () => {
  it("E2 = FAIL за J і K3, але прогони ДІЙСНІ (кеш обійдено); вердикт FAIL", async () => {
    const snaps = [A("shop"), A("shop-clean"), A("mutants/M5")];
    const r = await runValidation({ snapshots: SNAP, checks: ["E2"], e2Snapshot: (i) => snaps[i] as string });
    const c = by(r, "E2");
    expect(c.status).toBe("FAIL");
    expect(r.verdict).toBe("FAIL");
    const d = c.data as { validity: { valid: boolean }; gate: { pass: boolean; failed: string[] }; metrics: { jcat_mean: number; k3: string[] } };
    expect(d.validity.valid).toBe(true);
    expect(d.gate.pass).toBe(false);
    expect(d.metrics.jcat_mean).toBeLessThan(0.6);
    expect(d.gate.failed.some((f) => f.startsWith("Jcat_mean"))).toBe(true);
  });
  it("вбудований контроль E2(б) у кожному validate: нестабільний оцінювач на тому ж замороженому знімку → Jcat < 0.4, рядок видно", () => {
    const d = by(good, "E2").data as { control_unstable: { llm_only: { jcat_mean: number }; gate_a_pass: boolean; caught: boolean } };
    expect(d.control_unstable.caught).toBe(true);
    expect(d.control_unstable.llm_only.jcat_mean).toBeLessThan(0.4);
    expect(d.control_unstable.gate_a_pass).toBe(true);
    expect(by(good, "E2").lines.join("\n")).toMatch(/контроль E2\(б\): .* < 0\.4 ✓ .*E2\(а\) при цьому PASS \(обмеження/);
  });
  it("нестабільний ОЦІНЮВАЧ на замороженому знімку: E2(а) лишається PASS (топ-5 — детерміновані), E2(б) показує низьку стабільність LLM-знахідок", async () => {
    const r = await runValidation({ snapshots: SNAP, checks: ["E2"], evaluators: { e2: (run) => ({ kind: "unstable", run }) } });
    const d = by(r, "E2").data as { llm_only: { jcat_mean: number }; gate: { pass: boolean } };
    expect(d.gate.pass).toBe(true);
    expect(d.llm_only.jcat_mean).toBeLessThan(0.4);
    expect(by(r, "E2").lines.join("\n")).toMatch(/E2\(б\).*ціль ≥ 0\.4: ні/);
  });
});

describe("(в) cache_read_tokens > 0 → E2 «недійсний»", () => {
  it("прогін 2 у cache_mode=use на прогрітому кеші → INVALID (не PASS і не «FAIL метрик»), вердикт FAIL", async () => {
    const r = await runValidation({ snapshots: SNAP, checks: ["E2"], e2CacheMode: (i) => (i === 1 ? "use" : "bypass") });
    const c = by(r, "E2");
    expect(c.status).toBe("INVALID");
    expect(r.verdict).toBe("FAIL");
    expect(c.lines.join("\n")).toMatch(/НЕДІЙСНИЙ.*run 2: cache_read_tokens=\d+ > 0/);
    expect(r.reports["e2-run2"]!.budget.cache_read_tokens).toBeGreaterThan(0);
    expect(r.reports["e2-run1"]!.budget.cache_read_tokens).toBe(0);
  });
  it("обхід кешу доведено: bypass на наповненому кеші → 0 читань, кеш не змінюється (і не наповнюється bypass-прогоном)", async () => {
    const snap = loadSnapshot(SNAP.shop);
    const store = new MemoryStore();
    const meter = new ValidateMeter(5_000_000);
    await buildRunReport(snap, "warm", { spec: { kind: "honest" }, cache_mode: "use", max_audit_tokens: 1_650_000, meter, store });
    const size = store.data.size;
    expect(size).toBe(plannedCalls(snap.pages));
    const b = await buildRunReport(snap, "bypass", { spec: { kind: "honest" }, cache_mode: "bypass", max_audit_tokens: 1_650_000, meter, store });
    expect(b.counters).toMatchObject({ cache_read_tokens: 0, cache_reads: 0, cache_mode: "bypass" });
    expect(store.data.size).toBe(size);
    expect(b.eval.client.records.every((x) => x.source === "provider")).toBe(true);
    const u = await buildRunReport(snap, "use", { spec: { kind: "honest" }, cache_mode: "use", max_audit_tokens: 1_650_000, meter, store });
    expect(u.counters.cache_read_tokens).toBeGreaterThan(0);
    expect(u.eval.client.records.every((x) => x.source === "cache")).toBe(true);
  });
});

describe("(г) абляція: LLM-лише = 0/3 → показник видно, у dev не гейт", () => {
  let r: ValidateResult;
  beforeAll(async () => {
    r = await runValidation({ snapshots: SNAP, checks: ["E1"], evaluators: { e1: () => ({ kind: "silent" }) } });
  });
  it("рядок «LLM-лише y/3 = 0/3» надруковано; детерміновані все ще 7/7; E1 PASS у dev", () => {
    const c = by(r, "E1");
    expect(c.lines.join("\n")).toMatch(/LLM-лише y\/3 = 0\/3/);
    expect(c.lines.join("\n")).toMatch(/детерміновані x\/7 = 7\/7/);
    expect(c.status).toBe("PASS");
    expect(r.verdict).toBe("PASS");
    expect((c.data as { ablation: { llm: { y: number } } }).ablation.llm.y).toBe(0);
  });
  it("сума 7 < 8 показана, але не гейт; з --strict-live (живий прогін S7) — стає гейтом → FAIL", async () => {
    expect(by(r, "E1").lines.join("\n")).toMatch(/разом 7\/10 \(за старим правилом категорії 7; гейт ≥ 8: не виконано/);
    const strict = await runValidation({ snapshots: SNAP, checks: ["E1"], strict_live: true, evaluators: { e1: () => ({ kind: "silent" }) } });
    expect(by(strict, "E1").status).toBe("FAIL");
  });
  it("без гіпотез (silent) у звіті 8 знахідок ≤ 10: гейт рангу тривіальний за побудовою — і це надруковано; контроль v1 теж не падає", () => {
    const d = by(r, "E1").data as { rank: { pass: boolean; findings: number }; rank_v1_control: { pass: boolean } };
    expect([d.rank.pass, d.rank.findings, d.rank_v1_control.pass]).toEqual([true, 8, true]);
    expect(by(r, "E1").lines.join("\n")).toMatch(/гейт тривіальний за побудовою/);
    expect(by(r, "E1").lines.join("\n")).toMatch(/контроль НЕ впав/);
  });
  it("E1 падає, коли детерміновану знахідку втрачено (знімок без M2-дефекту): x/7 = 6/7 → FAIL", async () => {
    const m2 = await runValidation({ snapshots: { shop: A("mutants/M2"), clean: SNAP.clean }, checks: ["E1"] });
    expect(by(m2, "E1").status).toBe("FAIL");
    expect((by(m2, "E1").data as { full: { det: { x: number } } }).full.det.x).toBe(6);
  });
});

describe("E3c dev-статус лише за кодом (DEV-77): fake у статус не входить", () => {
  const E3C = { shop: SNAP.shop, clean: V("site-a"), degraded: V("site-b") };
  let honestDev: ValidateResult;
  beforeAll(async () => {
    honestDev = await runValidation({ snapshots: E3C, checks: ["E3c"] });
  });
  it("dev: код 2/5 < 4/5 → ⏭️ DEFERRED (не PASS і не FAIL); fake 5/5 — лише рядок обв'язки; вердикт PASS із переліком ⏭️", () => {
    const c = by(honestDev, "E3c");
    expect(c.status).toBe("DEFERRED");
    expect((c.data as { worse: number; worse_code: number }).worse_code).toBe(2);
    expect((c.data as { worse: number }).worse).toBe(5);
    expect(c.lines[0]).toMatch(/⏭️ dev: кодом гірше в 2 з 5 < 4/);
    expect(c.lines.join("\n")).toMatch(/обв'язка \(НЕ статус\): з fake-оцінювачем гірше в 5 з 5/);
    expect(honestDev.verdict).toBe("PASS");
    expect(formatResult(honestDev)).toMatch(/не закрито в dev \(⏭️\): E3c/);
  });
  it("silent-оцінювач на degraded: dev-статус ТОЙ САМИЙ (fake не впливає); strict-live → FAIL (2 < 4); strict-live з fake → PASS (обв'язка)", async () => {
    const silent = await runValidation({ snapshots: E3C, checks: ["E3c"], evaluators: { e3c: () => ({ kind: "silent" }) } });
    expect(by(silent, "E3c").status).toBe("DEFERRED");
    expect((by(silent, "E3c").data as { worse_code: number }).worse_code).toBe(2);
    const strictSilent = await runValidation({ snapshots: E3C, checks: ["E3c"], strict_live: true, evaluators: { e3c: () => ({ kind: "silent" }) } });
    expect(by(strictSilent, "E3c").status).toBe("FAIL");
    expect(strictSilent.verdict).toBe("FAIL");
    const strictFake = await runValidation({ snapshots: E3C, checks: ["E3c"], strict_live: true });
    expect(by(strictFake, "E3c").status).toBe("PASS");
  });
  it("e3cStatus: таблиця (поріг ≥ 4/5 один для dev і live, SCORING_SPEC §8.3)", () => {
    const cases: Array<[number, number, boolean, string]> = [
      [5, 2, false, "DEFERRED"], [0, 0, false, "DEFERRED"], [4, 3, false, "DEFERRED"], [4, 4, false, "PASS"], [5, 5, false, "PASS"],
      [3, 2, true, "FAIL"], [4, 2, true, "PASS"], [0, 0, true, "FAIL"],
    ];
    for (const [worse, worse_code, strict, want] of cases) expect(e3cStatus({ worse, worse_code }, strict).status, `${worse}/${worse_code}/${strict}`).toBe(want);
  });
});

describe("MAX_VALIDATE_TOKENS: жорсткий ліміт зі стопом", () => {
  it("ліміт менший за потрібний → STOPPED; перевірки після стопу NOT_RUN; використано ≤ ліміту", async () => {
    const max = 90_000;
    const r = await runValidation({ snapshots: SNAP, checks: CHECKS, max_validate_tokens: max });
    expect(r.verdict).toBe("STOPPED");
    expect(r.stopped_reason).toMatch(/MAX_VALIDATE_TOKENS/);
    expect(r.tokens.used).toBeLessThanOrEqual(max);
    expect(r.checks.some((c) => c.status === "NOT_RUN")).toBe(true);
    expect(r.checks.filter((c) => c.status === "NOT_RUN").every((c) => /зупинено/.test(c.lines[0] ?? ""))).toBe(true);
  });
  it("ліміт достатній → не зупиняється (контроль: стоп не спрацьовує завжди)", () => {
    expect(good.verdict).not.toBe("STOPPED");
    expect(good.tokens.used).toBeLessThan(good.tokens.max);
  });
  it("ValidateMeter: резерв перевіряється ДО виклику; після стопу лічильник не росте; некоректний ліміт — виняток", () => {
    const m = new ValidateMeter(100);
    m.before(60);
    m.after(60);
    expect(() => m.before(50)).toThrow(ValidateBudgetStop);
    expect(m.used).toBe(60);
    expect(m.stopped).toBe(true);
    expect(() => new ValidateMeter(0)).toThrow(RangeError);
    expect(() => new ValidateMeter(Number.NaN)).toThrow(RangeError);
  });
});

describe("абляція G0-7: механізм", () => {
  it("опорні докази №1/№3/№4 прибираються (позитив), решта лишається; без ET-SUP-доказів прибрано 0 (негатив)", () => {
    const snap = loadSnapshot(SNAP.shop);
    expect(ablateHints(snap.art).removed).toBe(0);
    const base = snap.art.evidence[0]!;
    const withHints = { ...snap.art, evidence: [...snap.art.evidence, ...["h1_category_overlap", "term_unexplained", "similar_products"].map((d, i) => ({ ...base, id: `ev_hint${i}`, detector_id: d }))] };
    const a = ablateHints(withHints);
    expect(a.removed).toBe(3);
    expect(a.art.evidence.length).toBe(snap.art.evidence.length);
    expect(a.art.evidence.some((e) => e.id.startsWith("ev_hint"))).toBe(false);
  });
});

describe("replay доводить обв'язку (не якість)", () => {
  it("запис (use) → replay: ті самі сесії, усі виклики з кешу, 0 звернень до провайдера; replay+bypass — ConfigError", async () => {
    const snap = loadSnapshot(SNAP.shop);
    const store = new MemoryStore();
    const rec = await runSnapshotSessions({ pages: snap.pages, spec: { kind: "honest" }, max_audit_tokens: 1_650_000, cache_mode: "use", store });
    const rep = await runSnapshotSessions({ pages: snap.pages, spec: { kind: "honest" }, max_audit_tokens: 1_650_000, cache_mode: "use", store, mode: "replay" });
    expect(JSON.stringify(rep.sessions)).toBe(JSON.stringify(rec.sessions));
    expect(rep.client.records.every((x) => x.source === "cache")).toBe(true);
    expect(rep.client.budget.cache_read_tokens).toBe(rep.client.budget.used);
    await expect(runSnapshotSessions({ pages: snap.pages, spec: { kind: "honest" }, max_audit_tokens: 1_650_000, cache_mode: "bypass", store, mode: "replay" })).rejects.toThrow(/bypass/);
  });
});

describe("fake-оцінювач: правила мають і позитив, і негатив", () => {
  const shopPages = loadPagesFromArtifacts(SNAP.shop);
  const cleanPages = loadPagesFromArtifacts(SNAP.clean);
  const cats = async (pages: typeof shopPages, spec: EvaluatorSpec = { kind: "honest" }) => {
    const r = await runSnapshotSessions({ pages, spec, max_audit_tokens: 1_650_000, cache_mode: "bypass" });
    return { r, cats: new Set(r.sessions.flatMap((s) => s.frictions.map((f) => f.category))) };
  };
  it("shop (10 дефектів): value_proposition, terminology, comparison (LLM-дефекти №1/№3/№4); trust мовчить (є «Про нас»)", async () => {
    const { cats: c } = await cats(shopPages);
    expect([...c].sort()).toEqual(["comparison", "terminology", "value_proposition"]);
  });
  it("shop-clean: жодної friction (негатив); без `silent` — так само", async () => {
    expect([...(await cats(cleanPages)).cats]).toEqual([]);
  });
  it("silent: жодної friction навіть на shop; invent_terminology: friction на КОЖНІЙ оцінюваній сторінці чистого магазину", async () => {
    expect([...(await cats(shopPages, { kind: "silent" })).cats]).toEqual([]);
    const inv = await cats(cleanPages, { kind: "invent_terminology" });
    expect([...inv.cats]).toEqual(["terminology"]);
    expect(new Set(inv.r.sessions.filter((s) => s.frictions.length).map((s) => s.pages_seen[0])).size).toBe(pagesToEvaluate(cleanPages).length);
  });
  it("план: сторінок × лінз = викликів; головна + каталог + ≤ 2 товари", () => {
    expect(pagesToEvaluate(shopPages).map((p) => p.page_type)).toEqual(["homepage", "category", "product", "product"]);
    expect(plannedCalls(shopPages)).toBe(4 * VALIDATE_LENSES.length);
  });
});

describe("CLI: непідтримуваний провайдер → код 3 із ⏭️, без запуску браузера", () => {
  it("--provider replay і --provider anthropic", () => {
    for (const p of ["replay", "anthropic"]) {
      const r = spawnSync("pnpm", ["exec", "tsx", "scripts/validate.ts", "--provider", p], { cwd: ROOT, encoding: "utf8" });
      expect(r.status, p).toBe(3);
      expect(r.stderr).toMatch(/⏭️/);
    }
  });
});
