/**
 * Ядро `pnpm validate` (S4, G0-7…G0-10, G0-18): E1 (дві цифри + абляція), E2 (3 прогони замороженого знімка з обходом кешу),
 * E3a (чиста сторінка), E3c (база vs деградована), E4 (бюджет токенів). Працює над ЗАМОРОЖЕНИМИ знімками (каталоги прогону
 * S1a: pages.json, evidence.json, …), тому не потребує браузера; браузерні аудити робить `scripts/validate.ts`.
 *
 * ЧЕСНІСТЬ: LLM-частина — scripted fake (`evaluator.ts`), НЕ модель. Вердикт «PASS (dev)» не означає ✅ для LLM-залежного:
 * усе, що залежить від відповіді живої моделі, має мітку ⏭️ live (OQ-1). Replay доводить обв'язку, не якість.
 */
import { MemoryStore, loadPagesFromArtifacts, type PageInput } from "../../packages/llm/src/index.js";
import { buildReport, integrateSessions, llmResultsFromSessions, loadS1aRun, type AuditArtifacts, type LlmResults, type SessionResultIn } from "../../packages/reporting/src/index.js";
import type { Report } from "../../packages/schemas/src/index.js";
import {
  E1_GATE, E2_THRESHOLDS, E3A_LIMITS, E3C_THRESHOLDS, e1, e1Gate, e2Gate, e2Metrics, e2Validity, e3a, e3c, e4, isLlmOnly,
  type E1Result, type E2Gate, type E2Metrics, type E2Validity, type E3aResult, type E3cResult, type E4Result, type VFinding,
} from "../../packages/scoring/src/index.js";
import { toVFindings } from "./adapt.js";
import { plannedCalls, runSnapshotSessions, type EvalRun, type EvaluatorSpec } from "./evaluator.js";

export const FIXED_TS = "2026-09-30T00:00:00Z";
export const DEFAULT_MAX_VALIDATE_TOKENS = 2_000_000;
export const DEFAULT_MAX_AUDIT_TOKENS = 1_650_000;
/** Опорні детектори для №1/№3/№4 (SCORING_SPEC §8.1, G0-7): у абляції не потрапляють ні в докази, ні в промпти */
export const SUPPORT_HINT_DETECTORS = ["h1_category_overlap", "term_unexplained", "similar_products"] as const;

// ------------------------------------------------------------------------------------------------ глобальний ліміт токенів
export class ValidateBudgetStop extends Error {
  constructor(readonly used: number, readonly max: number, what: string) {
    super(`MAX_VALIDATE_TOKENS: ${what} не вміщується в залишок (використано ${used} з ${max}); validate зупинено`);
    this.name = "ValidateBudgetStop";
  }
}
/** Жорсткий ліміт на весь `validate`: перевіряється ДО кожного виклику (з резервом max_tokens) і фіксується ПІСЛЯ */
export class ValidateMeter {
  used = 0;
  calls = 0;
  stopped = false;
  constructor(readonly max: number) {
    if (!Number.isFinite(max) || max <= 0) throw new RangeError("MAX_VALIDATE_TOKENS має бути додатним числом");
  }
  before = (estimate: number): void => {
    if (this.used + estimate > this.max) {
      this.stopped = true;
      throw new ValidateBudgetStop(this.used, this.max, `виклик (оцінка ${estimate})`);
    }
  };
  after = (tokens: number): void => {
    this.used += tokens;
    this.calls++;
  };
}

// ------------------------------------------------------------------------------------------------ знімок → звіт
export interface LoadedSnapshot { dir: string; art: AuditArtifacts; pages: PageInput[] }
export function loadSnapshot(dir: string): LoadedSnapshot {
  return { dir, art: loadS1aRun(dir, { language: "uk", id: "aud_validate0000000", created_at: FIXED_TS, completed_at: FIXED_TS, snapshot_at: FIXED_TS }), pages: loadPagesFromArtifacts(dir) };
}

/** Абляція G0-7: прибирає опорні докази №1/№3/№4 (за detector_id або tier ET-SUP на цих детекторах). Повертає скільки прибрано. */
export function ablateHints(art: AuditArtifacts): { art: AuditArtifacts; removed: number } {
  const hint = (e: AuditArtifacts["evidence"][number]): boolean => (SUPPORT_HINT_DETECTORS as readonly string[]).includes(e.detector_id ?? "");
  const kept = art.evidence.filter((e) => !hint(e));
  return { art: { ...art, evidence: kept }, removed: art.evidence.length - kept.length };
}

export interface RunCounters { cache_read_tokens: number; cache_reads: number; cache_mode: "use" | "bypass"; used_tokens: number; llm_calls: number; max_audit_tokens: number }
export interface RunResult {
  label: string;
  report: Report;
  findings: VFinding[];
  counters: RunCounters;
  eval: EvalRun;
  planned_calls: number;
  budget_limited: boolean;
  friction_rejections: number;
}
export interface RunOptions {
  spec: EvaluatorSpec;
  cache_mode: "use" | "bypass";
  max_audit_tokens: number;
  meter: ValidateMeter;
  store?: MemoryStore;
  ablate?: boolean;
}

export async function buildRunReport(snap: LoadedSnapshot, label: string, o: RunOptions): Promise<RunResult> {
  const art0 = o.ablate ? ablateHints(snap.art).art : snap.art;
  const ev = await runSnapshotSessions({ pages: snap.pages, spec: o.spec, max_audit_tokens: o.max_audit_tokens, cache_mode: o.cache_mode, store: o.store, onCall: o.meter.after, beforeCall: o.meter.before });
  const integ = integrateSessions({ sessions: ev.sessions as SessionResultIn[], pages: snap.art.pages });
  const b = ev.client.budget;
  const llm: LlmResults = {
    ...llmResultsFromSessions(integ, { mode: "replay", provider: "replay", model: "scripted-fake:toy-evaluator-v1", prompt_versions: ["snapshot-evaluator-v1"], llm_calls: ev.client.records.length, used_tokens: b.used }),
    budget: { max_audit_tokens: b.max, used_tokens: b.used, billed_tokens: b.billed_tokens, cache_read_tokens: b.cache_read_tokens, llm_calls: ev.client.records.length, cost: null },
  };
  const stage = ev.budget_limited
    ? { status: "budget_limited" as const, reason: `обмежено бюджетом: MAX_AUDIT_TOKENS ${b.used}/${b.max} токенів, етап зупинено` }
    : { status: "done" as const, reason: null };
  const art: AuditArtifacts = { ...art0, audit: { ...art0.audit, stage_status: { ...art0.audit.stage_status, snapshot_sessions: stage } } };
  const { report } = buildReport(art, llm, { generated_at: FIXED_TS, provenance: { kind: "audit", note: "validate" }, max_audit_tokens: o.max_audit_tokens });
  return {
    label, report, findings: toVFindings(report), eval: ev, planned_calls: ev.planned_calls, budget_limited: ev.budget_limited, friction_rejections: integ.rejected.length,
    counters: { cache_read_tokens: report.budget.cache_read_tokens, cache_reads: ev.cache.reads, cache_mode: o.cache_mode, used_tokens: report.budget.used_tokens, llm_calls: report.budget.llm_calls, max_audit_tokens: o.max_audit_tokens },
  };
}

// ------------------------------------------------------------------------------------------------ результати перевірок
export type CheckId = "E1" | "E2" | "E3a" | "E3c" | "E4";
export type Status = "PASS" | "FAIL" | "INVALID" | "NOT_RUN";
export interface CheckResult {
  id: CheckId;
  status: Status;
  /** рядки для людини (числа з коду) */
  lines: string[];
  /** що залежить від живої моделі й тому ⏭️ live (не ✅) */
  live_deferred: string[];
  data: unknown;
}

export interface ValidateOptions {
  snapshots: { shop: string; clean: string; degraded?: string };
  checks?: readonly CheckId[];
  /** сценарії негативних контролів: підміна оцінювача за перевіркою й номером прогону */
  evaluators?: Partial<Record<"e1" | "e2" | "e3a" | "e3c" | "e4", (run: number) => EvaluatorSpec>>;
  /** сценарій (б): знімок НЕ заморожений — інший каталог на прогін E2 (справжній збій, який E2 мусить ловити) */
  e2Snapshot?: (run: number) => string;
  /** сценарій (в): підміна режиму кешу для прогону E2 */
  e2CacheMode?: (run: number) => "use" | "bypass";
  /** true → «сума E1 ≥ 8» і LLM-виміри E3c стають гейтом (живий прогін S7); у dev вони лише показуються (fake) */
  strict_live?: boolean;
  max_validate_tokens?: number;
  max_audit_tokens?: number;
  /** E4: частка від використаних токенів, яку виставляємо як MAX_AUDIT_TOKENS обмеженого прогону */
  e4_limit_fraction?: number;
}
export interface ValidateResult {
  verdict: "PASS" | "FAIL" | "STOPPED";
  checks: CheckResult[];
  tokens: { max: number; used: number; provider_calls: number };
  provider: "scripted-fake";
  stopped_reason: string | null;
  /** звіти прогонів (для артефактів) */
  reports: Record<string, Report>;
}

const honest = (): EvaluatorSpec => ({ kind: "honest" });
const f3 = (x: number): string => x.toFixed(3);
const LIVE_LLM = "оцінювач — scripted fake, не модель: відповідь живої моделі (⏭️ live, OQ-1)";

export async function runValidation(opts: ValidateOptions): Promise<ValidateResult> {
  const want = new Set<CheckId>(opts.checks ?? ["E1", "E2", "E3a", "E3c", "E4"]);
  const meter = new ValidateMeter(opts.max_validate_tokens ?? DEFAULT_MAX_VALIDATE_TOKENS);
  const maxAudit = opts.max_audit_tokens ?? DEFAULT_MAX_AUDIT_TOKENS;
  const ev = (k: "e1" | "e2" | "e3a" | "e3c" | "e4", run = 0): EvaluatorSpec => opts.evaluators?.[k]?.(run) ?? honest();
  const shop = loadSnapshot(opts.snapshots.shop);
  const clean = loadSnapshot(opts.snapshots.clean);
  const checks: CheckResult[] = [];
  const reports: Record<string, Report> = {};
  let stopped: string | null = null;
  const keep = (r: RunResult) => { reports[r.label] = r.report; return r; };

  try {
    // ------------------------------------------------------------------ E1
    if (want.has("E1")) {
      const full = keep(await buildRunReport(shop, "e1-full", { spec: ev("e1"), cache_mode: "bypass", max_audit_tokens: maxAudit, meter }));
      const abl = ablateHints(shop.art);
      const ablated = keep(await buildRunReport(shop, "e1-ablation", { spec: ev("e1"), cache_mode: "bypass", max_audit_tokens: maxAudit, meter, ablate: true }));
      const rFull: E1Result = e1(full.findings);
      const rAbl: E1Result = e1(ablated.findings);
      const detOk = rFull.det.x === E1_GATE.det_of;
      const totalOk = e1Gate(rFull);
      const status: Status = detOk && (!opts.strict_live || totalOk) ? "PASS" : "FAIL";
      checks.push({
        id: "E1", status,
        lines: [
          `детерміновані x/7 = ${rFull.det.x}/${rFull.det.of} (VERIFIED, F-DET; гейт ${E1_GATE.det_of}/7)`,
          `LLM-лише y/3 = ${rAbl.llm.y}/${rAbl.llm.of} (абляція: прибрано ${abl.removed} опорних доказів №1/№3/№4; показник, не гейт)`,
          `разом ${rFull.total}/10 (гейт ≥ ${E1_GATE.min_total}: ${totalOk ? "виконано" : "не виконано"} — залежить від LLM, ${opts.strict_live ? "ГЕЙТ (strict-live)" : "⏭️ live, у dev не гейт"})`,
          `опорні детектори №1/№3/№4 (${SUPPORT_HINT_DETECTORS.join(", ")}) у S1a НЕ реалізовані → ablation-arm ≡ full-arm за побудовою (прибрано ${abl.removed}); механізм абляції перевірено тестом`,
          `непередбачені знахідки (не гейт): ${rFull.unexpected.length ? rFull.unexpected.join(", ") : "немає"}`,
          `не вимірюється тут: 7 мутантів мовчать і двійник — \`pnpm run audit:fixture\` / S1a (E1, SCORING_SPEC §8.1)`,
        ],
        live_deferred: [`E1_llm=${rAbl.llm.y}/3 і сума ${rFull.total}/10: ${LIVE_LLM}`],
        data: { full: rFull, ablation: rAbl, removed_hints: abl.removed, gate: { det_ok: detOk, total_ok: totalOk } },
      });
    }

    // ------------------------------------------------------------------ E2
    if (want.has("E2")) {
      // прогріваємо кеш (cache_mode=use, MemoryStore), щоб обхід було що порушувати: bypass має лишити лічильник 0 попри наповнений кеш
      const store = new MemoryStore();
      await buildRunReport(shop, "e2-warmup", { spec: honest(), cache_mode: "use", max_audit_tokens: maxAudit, meter, store });
      const runs: RunResult[] = [];
      for (let i = 0; i < 3; i++) runs.push(keep(await buildRunReport(opts.e2Snapshot ? loadSnapshot(opts.e2Snapshot(i)) : shop, `e2-run${i + 1}`, { spec: ev("e2", i), cache_mode: opts.e2CacheMode?.(i) ?? "bypass", max_audit_tokens: maxAudit, meter, store })));
      const validity: E2Validity = e2Validity(runs.map((r) => r.counters));
      const m: E2Metrics = e2Metrics(runs.map((r) => r.findings));
      const gate: E2Gate = e2Gate(m);
      const llmRuns = runs.map((r) => r.findings.filter(isLlmOnly));
      const mb: E2Metrics = e2Metrics(llmRuns);
      // позитивний контроль лічильника: use на прогрітому кеші МАЄ дати cache_read_tokens > 0 (інакше перевірка не вміла б впасти)
      const control = await buildRunReport(shop, "e2-control-use", { spec: honest(), cache_mode: "use", max_audit_tokens: maxAudit, meter, store });
      const controlInvalid = !e2Validity([control.counters, control.counters, control.counters]).valid && control.counters.cache_read_tokens > 0;
      const status: Status = !validity.valid ? "INVALID" : gate.pass ? "PASS" : "FAIL";
      const llmEmpty = mb.set_sizes.every((n) => n === 0);
      checks.push({
        id: "E2", status,
        lines: [
          validity.valid
            ? `валідність: 3 прогони cache_mode=bypass, cache_read_tokens = ${runs.map((r) => r.counters.cache_read_tokens).join("/")}, читань кешу ${runs.map((r) => r.counters.cache_reads).join("/")} (кеш прогріто: ${store.data.size} записів) → дійсні`
            : `НЕДІЙСНИЙ: ${validity.reasons.join("; ")}`,
          `контроль лічильника: cache_mode=use на тому ж кеші → cache_read_tokens=${control.counters.cache_read_tokens} > 0 → «недійсний» ${controlInvalid ? "(перевірка вміє впасти)" : "— КОНТРОЛЬ НЕ СПРАЦЮВАВ"}`,
          `E2(а) повний звіт [ГЕЙТ]: Jcat mean/min ${f3(m.jcat_mean)}/${f3(m.jcat_min)} (≥ ${E2_THRESHOLDS.jcat_mean}/${E2_THRESHOLDS.jcat_min}), Jpg mean/min ${f3(m.jpg_mean)}/${f3(m.jpg_min)}, |K3|=${m.k3.length} (≥ ${E2_THRESHOLDS.k3_min})${gate.pass ? "" : " ✗ " + gate.failed.join("; ")}`,
          `E2(б) лише LLM-знахідки [показник]: ${llmEmpty ? "LLM-знахідок немає (J тривіально 1 — НЕ доказ стабільності)" : `Jcat mean ${f3(mb.jcat_mean)} (ціль ≥ ${E2_THRESHOLDS.llm_jcat_mean_target}: ${mb.jcat_mean >= E2_THRESHOLDS.llm_jcat_mean_target ? "так" : "ні"}), Jpg mean ${f3(mb.jpg_mean)}, розмір підмножин ${mb.set_sizes.join("/")}`}`,
          `RBO(p=0.8) топ-10 [інформативно]: ${m.rbo10.map(f3).join("/")} (середнє ${f3(m.rbo10_mean)})`,
          `топ-5 (прогін 1): ${runs[0]!.findings.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map((f) => f.finding_key).join(" · ")}`,
        ],
        live_deferred: [`стабільність LLM-знахідок (E2(б), RBO): ${LIVE_LLM}; fake детермінований → J=1 доводить обв'язку, не стабільність моделі`],
        data: { validity, metrics: m, gate, llm_only: mb, control: { cache_read_tokens: control.counters.cache_read_tokens, invalid: controlInvalid }, top5: runs.map((r) => r.findings.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map((f) => f.finding_key)) },
      });
    }

    // ------------------------------------------------------------------ E3a
    if (want.has("E3a")) {
      const r = keep(await buildRunReport(clean, "e3a-clean", { spec: ev("e3a"), cache_mode: "bypass", max_audit_tokens: maxAudit, meter }));
      const res: E3aResult = e3a(r.findings, clean.art.pages.map((p) => p.path));
      const strongNoDet = r.findings.filter((f) => (f.confidence === "VERIFIED" || f.confidence === "STRONG_HYPOTHESIS") && !f.families.includes("F-DET")).length;
      const forbidden = r.findings.filter((f) => isLlmOnly(f) && (E3A_LIMITS.forbidden_categories as readonly string[]).includes(f.category)).length;
      const maxHyp = Math.max(0, ...Object.values(res.hypothesis_per_page));
      checks.push({
        id: "E3a", status: res.pass ? "PASS" : "FAIL",
        lines: [
          `чистих сторінок ${clean.art.pages.length}; знахідок усього ${r.findings.length}; STRONG/VERIFIED без F-DET: ${strongNoDet} (гейт 0); terminology/value_proposition (LLM): ${forbidden} (гейт 0); LLM HYPOTHESIS на сторінку max ${maxHyp} (гейт ≤ ${E3A_LIMITS.max_llm_hypothesis_per_page}); F-DET-знахідок: ${r.findings.filter((f) => f.families.includes("F-DET")).length} (гейт 0)`,
          ...(res.pass ? [] : res.violations.map((v) => `✗ ${v}`)),
          `відхилено кодом friction без перевіреного доказу (§23): ${r.friction_rejections}`,
        ],
        live_deferred: [`специфічність живої моделі на чистих сторінках: ${LIVE_LLM}`],
        data: { result: res, findings: r.findings.map((f) => f.finding_key), friction_rejections: r.friction_rejections },
      });
    }

    // ------------------------------------------------------------------ E3c
    if (want.has("E3c")) {
      if (!opts.snapshots.degraded) {
        checks.push({ id: "E3c", status: "NOT_RUN", lines: ["знімок деградованої копії не надано (потрібен браузерний аудит site-b.test)"], live_deferred: [], data: null });
      } else {
        const degraded = loadSnapshot(opts.snapshots.degraded);
        const a = keep(await buildRunReport(clean, "e3c-original", { spec: ev("e3c"), cache_mode: "bypass", max_audit_tokens: maxAudit, meter }));
        const b = keep(await buildRunReport(degraded, "e3c-degraded", { spec: ev("e3c"), cache_mode: "bypass", max_audit_tokens: maxAudit, meter }));
        const res: E3cResult = e3c(a.findings, b.findings);
        const CODE_DIMS_EXPECTED = 2; // shipping + cta: обидва мають ловитися детекторами (порогів не змінювати після прогону)
        const codeOk = res.worse_code >= CODE_DIMS_EXPECTED;
        const totalOk = res.worse >= E3C_THRESHOLDS.min_worse;
        const status: Status = totalOk && codeOk ? "PASS" : "FAIL";
        checks.push({
          id: "E3c", status,
          lines: [
            `гірше в ${res.worse} з 5 (гейт ≥ ${E3C_THRESHOLDS.min_worse}); з них КОДОМ (F-DET/F-SUP/F-BRW) ${res.worse_code}/5 (dev-гейт ≥ ${CODE_DIMS_EXPECTED}: shipping, CTA); лише LLM ${res.worse_llm_only}/5 (⏭️ live)`,
            ...res.dims.map((d) => `  ${d.label}: D ${d.d_original}→${d.d_degraded}, нових STRONG/VERIFIED ${d.new_strong_or_verified.length}, worse=${d.worse ? "так" : "ні"} [${d.source}]`),
            `шум решти категорій |ΔD| (інформативно): ${Object.entries(res.other_delta).map(([k, v]) => `${k}=${v}`).join(", ") || "немає"}`,
            `сліпий прогін: нейтральні хости site-a.test (база) / site-b.test (копія), слова «degraded» немає в URL/тексті/заголовках (перевіряє тест фікстури)`,
          ],
          live_deferred: [`LLM-виміри (headline, comparison, trust): ${LIVE_LLM}. Код сам дає ${res.worse_code}/5 < 4: без живої LLM гейт E3c недосяжний за побудовою`],
          data: res,
        });
      }
    }

    // ------------------------------------------------------------------ E4
    if (want.has("E4")) {
      const full = await buildRunReport(shop, "e4-full", { spec: ev("e4"), cache_mode: "bypass", max_audit_tokens: maxAudit, meter });
      const limit = Math.max(1, Math.floor(full.counters.used_tokens * (opts.e4_limit_fraction ?? 0.4)));
      const lim = keep(await buildRunReport(shop, "e4-limited", { spec: ev("e4"), cache_mode: "bypass", max_audit_tokens: limit, meter }));
      const asInput = (r: RunResult) => ({
        max_audit_tokens: r.counters.max_audit_tokens, used_tokens: r.counters.used_tokens, cache_read_tokens: r.counters.cache_read_tokens, llm_calls: r.counters.llm_calls,
        client_used_tokens: r.eval.client.budget.used, planned_calls: r.planned_calls, stage_budget_limited: r.report.audit.stage_status["snapshot_sessions"]?.status === "budget_limited",
        banner_budget_limited: r.report.audit.banners.some((x) => x.code === "budget_limited"),
      });
      const a: E4Result = e4(asInput(full));
      const b: E4Result = e4(asInput(lim));
      // контроль, що перевірка вміє впасти: тиха обрізка без позначки
      const tamper = e4({ ...asInput(lim), banner_budget_limited: false });
      const ok = a.pass && !a.limited && b.pass && b.limited && !tamper.pass;
      checks.push({
        id: "E4", status: ok ? "PASS" : "FAIL",
        lines: [
          `повний прогін: ${full.counters.llm_calls}/${full.planned_calls} викликів, ${full.counters.used_tokens} токенів ≤ MAX_AUDIT_TOKENS ${full.counters.max_audit_tokens}; позначки немає ${a.pass && !a.limited ? "✓" : "✗ " + a.failed.join("; ")}`,
          `обмежений (MAX_AUDIT_TOKENS=${limit}): ${lim.counters.llm_calls}/${lim.planned_calls} викликів, ${lim.counters.used_tokens} токенів; етап snapshot_sessions=budget_limited, банер «обмежено бюджетом» є ${b.pass && b.limited ? "✓" : "✗ " + b.failed.join("; ")}`,
          `лічильник у звіті (OBSERVED) = лічильник клієнта: ${lim.counters.used_tokens} = ${lim.eval.client.budget.used}; $ не показується (немає дати прайсу, G0-24)`,
          `контроль: та сама обрізка без банера → E4 ${tamper.pass ? "НЕ ВПАЛО (перевірка порожня)" : "FAIL ✓ (перевірка вміє впасти)"}`,
        ],
        live_deferred: ["фактична вартість аудиту на живій моделі й $ (⏭️ S7, потрібен ключ і дата прайсу)"],
        data: { full: asInput(full), limited: asInput(lim), limit, tamper_detected: !tamper.pass },
      });
    }
  } catch (e) {
    if (e instanceof ValidateBudgetStop) stopped = e.message;
    else throw e;
  }

  const ran = new Set(checks.map((c) => c.id));
  for (const id of ["E1", "E2", "E3a", "E3c", "E4"] as const) if (want.has(id) && !ran.has(id)) checks.push({ id, status: "NOT_RUN", lines: ["не виконано: validate зупинено лімітом MAX_VALIDATE_TOKENS"], live_deferred: [], data: null });
  const bad = checks.some((c) => c.status === "FAIL" || c.status === "INVALID");
  return {
    verdict: stopped ? "STOPPED" : bad ? "FAIL" : "PASS", checks, tokens: { max: meter.max, used: meter.used, provider_calls: meter.calls }, provider: "scripted-fake", stopped_reason: stopped, reports,
  };
}

// ------------------------------------------------------------------------------------------------ вивід
export function formatResult(r: ValidateResult): string {
  const out: string[] = [];
  out.push(`pnpm validate — провайдер: scripted fake (НЕ модель); LLM-залежне = ⏭️ live, не ✅`);
  for (const c of r.checks) {
    const mark = c.status === "PASS" ? "PASS" : c.status === "NOT_RUN" ? "NOT RUN" : c.status;
    out.push(`\n[${c.id}] ${mark}`);
    for (const l of c.lines) out.push(`  ${l}`);
    for (const d of c.live_deferred) out.push(`  ⏭️ live: ${d}`);
  }
  out.push(`\nтокени: ${r.tokens.used}/${r.tokens.max} (MAX_VALIDATE_TOKENS), викликів провайдера ${r.tokens.provider_calls}`);
  if (r.stopped_reason) out.push(`ЗУПИНЕНО: ${r.stopped_reason}`);
  out.push(`ВЕРДИКТ (dev): ${r.verdict}${r.verdict === "PASS" ? " — обв'язка працює; якість моделі не перевірено (⏭️ live)" : ""}`);
  return out.join("\n");
}

export { plannedCalls };
