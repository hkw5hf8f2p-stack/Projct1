/**
 * Ядро `pnpm validate` (S4, G0-7…G0-10, G0-18): E1 (дві цифри + абляція), E2 (3 прогони замороженого знімка з обходом кешу),
 * E3a (чиста сторінка), E3c (база vs деградована), E4 (бюджет токенів). Працює над ЗАМОРОЖЕНИМИ знімками (каталоги прогону
 * S1a: pages.json, evidence.json, …), тому не потребує браузера; браузерні аудити робить `scripts/validate.ts`.
 *
 * ЧЕСНІСТЬ: LLM-частина — scripted fake (`evaluator.ts`), НЕ модель. Вердикт «PASS (dev)» не означає ✅ для LLM-залежного:
 * усе, що залежить від відповіді живої моделі, має мітку ⏭️ live (OQ-1). Replay доводить обв'язку, не якість.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DirStore, MemoryStore, SESSION_ANSWERED_BY, SESSION_BANNER, loadPagesFromArtifacts, type PageInput } from "../../packages/llm/src/index.js";
import { buildReport, integrateSessions, llmResultsFromSessions, loadS1aRun, type AuditArtifacts, type IntegrationRejection, type LlmResults, type SessionResultIn } from "../../packages/reporting/src/index.js";
import type { Report } from "../../packages/schemas/src/index.js";
import {
  E1_GATE, E1_RANK_GATE, E2_THRESHOLDS, E3A_LIMITS, E3C_THRESHOLDS, e1, e1Gate, e1RankGate, e2Gate, e2Metrics, e2Validity, e3a, e3c, e4, isLlmOnly, rerankV1,
  type E1RankResult, type E1Result, type E2Gate, type E2Metrics, type E2Validity, type E3aResult, type E3cResult, type E4Result, type VFinding,
} from "../../packages/scoring/src/index.js";
import { toVFindings } from "./adapt.js";
import { formatE1Distribution, runE1Samples } from "./e1-samples.js";
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

/** S7 (DEV-82): бекенд `session`. phase=session — SessionProvider (export/import, той самий код); phase=replay — лише кеш сесії */
export interface SessionBackend { root: string; model: string; phase: "session" | "replay"; /** replay за логічним ключем (відповіді A записано до виправлення промпта; DEV-88) */ by_logical_key?: boolean }
/** запити прогону записано в requests/, відповідей ще немає: перевірка не рахується (не PASS/FAIL) */
export class RunAwaiting extends Error {
  constructor(readonly label: string, readonly awaiting: number, readonly planned: number, readonly requests: string[]) {
    super(`awaiting_session_model: ${label}: ${awaiting}/${planned} викликів чекають відповіді сесійної моделі`);
  }
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
  /** причини відхилення friction кодом (для діагностики «майже знайшов»; E1-вибірки) */
  rejections: IntegrationRejection[];
}
export interface RunOptions {
  spec: EvaluatorSpec;
  cache_mode: "use" | "bypass";
  max_audit_tokens: number;
  meter: ValidateMeter;
  store?: MemoryStore;
  ablate?: boolean;
  /** S7: транспорт session у цьому прогоні (namespace = ізоляція прогону; E2 бере окремий на кожен) */
  session?: SessionBackend & { namespace: string; scenario: string };
}

export async function buildRunReport(snap: LoadedSnapshot, label: string, o: RunOptions): Promise<RunResult> {
  const art0 = o.ablate ? ablateHints(snap.art).art : snap.art;
  const ev = await runSnapshotSessions({ pages: snap.pages, spec: o.spec, max_audit_tokens: o.max_audit_tokens, cache_mode: o.cache_mode, store: o.store, onCall: o.meter.after, beforeCall: o.meter.before, session: o.session });
  if (ev.awaiting > 0) throw new RunAwaiting(label, ev.awaiting, ev.planned_calls, ev.written_requests);
  const integ = integrateSessions({ sessions: ev.sessions as SessionResultIn[], pages: snap.art.pages });
  const b = ev.client.budget;
  const llm: LlmResults = {
    ...llmResultsFromSessions(integ, { mode: "replay", provider: "replay", model: o.session ? `session:${o.session.model}` : "scripted-fake:toy-evaluator-v1", prompt_versions: ["snapshot-evaluator-v1"], llm_calls: ev.client.records.length, used_tokens: b.used }),
    budget: { max_audit_tokens: b.max, used_tokens: b.used, billed_tokens: b.billed_tokens, cache_read_tokens: b.cache_read_tokens, llm_calls: ev.client.records.length, cost: null },
  };
  const stage = ev.budget_limited
    ? { status: "budget_limited" as const, reason: `обмежено бюджетом: MAX_AUDIT_TOKENS ${b.used}/${b.max} токенів, етап зупинено` }
    : { status: "done" as const, reason: null };
  const art: AuditArtifacts = { ...art0, audit: { ...art0.audit, stage_status: { ...art0.audit.stage_status, snapshot_sessions: stage } } };
  const { report } = buildReport(art, llm, { generated_at: FIXED_TS, provenance: { kind: "audit", note: o.session ? `validate; llm_mode=session; ${SESSION_BANNER}` : "validate" }, max_audit_tokens: o.max_audit_tokens });
  return {
    label, report, findings: toVFindings(report), eval: ev, planned_calls: ev.planned_calls, budget_limited: ev.budget_limited, friction_rejections: integ.rejected.length, rejections: integ.rejected,
    counters: { cache_read_tokens: report.budget.cache_read_tokens, cache_reads: ev.cache.reads, cache_mode: o.cache_mode, used_tokens: report.budget.used_tokens, llm_calls: report.budget.llm_calls, max_audit_tokens: o.max_audit_tokens },
  };
}

/**
 * E2 у транспорті session: «недійсний» = порушена незалежність або походження. Читає записи кешу кожного прогону (свій namespace) і перевіряє
 * provenance КОЖНОЇ відповіді: provider=session, answered_by=blind-subagent, synthetic=false. Синтетичний/чужий запис → INVALID.
 */
export function sessionProvenance(sess: SessionBackend, runs: readonly RunResult[], namespaces: readonly string[]): { valid: boolean; reasons: string[]; entries: number; keys_total: number; keys_differing: number } {
  const reasons: string[] = [];
  if (new Set(namespaces).size !== namespaces.length) reasons.push("namespace прогонів не різні");
  const store = new DirStore(`${sess.root}/cache`, true);
  const byKey = new Map<string, Set<string>>();
  let entries = 0;
  if (sess.by_logical_key) {
    // DEV-88: відповіді записано до виправлення промпта → хеші E5 не збігаються з поточними; походження перевіряємо напряму по записах моделі в кожному namespace, ключ = логічний
    for (const ns of namespaces) {
      const dir = path.join(sess.root, "cache", ns);
      for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")) : []) {
        const e = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { provider?: string; model?: string; synthetic?: boolean; rejected?: boolean; provenance?: { provider?: string; answered_by?: string; synthetic?: boolean; response_sha256?: string }; request_summary?: { logical_key?: Record<string, unknown> } };
        if (e.model !== sess.model) continue;
        entries++;
        const pv = e.provenance;
        if (e.synthetic !== false || pv?.provider !== "session" || pv.answered_by !== SESSION_ANSWERED_BY || pv.synthetic !== false) reasons.push(`${ns}/${f.slice(0, 10)}…: без provenance session/${SESSION_ANSWERED_BY}/synthetic:false`);
        const lk = e.request_summary?.logical_key;
        if (pv?.response_sha256 && !e.rejected && lk) { const k = JSON.stringify([lk["prompt_id"], lk["page_url"], lk["lens_id"], lk["task_id"], lk["step"] ?? 0, lk["attempt"] ?? 0]); const set = byKey.get(k) ?? new Set<string>(); set.add(pv.response_sha256); byKey.set(k, set); }
      }
    }
    return { valid: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 6), entries, keys_total: byKey.size, keys_differing: [...byKey.values()].filter((v) => v.size > 1).length };
  }
  runs.forEach((r, i) => {
    const ns = namespaces[i] as string;
    for (const rec of r.eval.client.records) {
      const e = store.get(ns, rec.request_hash);
      if (!e) { reasons.push(`${r.label}: запис ${rec.request_hash.slice(0, 10)}… відсутній у namespace ${ns}`); continue; }
      entries++;
      const pv = e.provenance as { provider?: string; answered_by?: string; synthetic?: boolean; response_sha256?: string } | undefined;
      if (e.synthetic !== false || pv?.provider !== "session" || pv.answered_by !== SESSION_ANSWERED_BY || pv.synthetic !== false) reasons.push(`${r.label}: запис ${rec.request_hash.slice(0, 10)}… без provenance session/${SESSION_ANSWERED_BY}/synthetic:false`);
      if (pv?.response_sha256 && !e.rejected) { const set = byKey.get(rec.request_hash) ?? new Set<string>(); set.add(pv.response_sha256); byKey.set(rec.request_hash, set); }
    }
  });
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 6), entries, keys_total: byKey.size, keys_differing: [...byKey.values()].filter((v) => v.size > 1).length };
}

// ------------------------------------------------------------------------------------------------ результати перевірок
export type CheckId = "E1" | "E2" | "E3a" | "E3c" | "E4" | "INJ";
/** DEFERRED — гейт не можна закрити без живої моделі (⏭️ live); не PASS і не FAIL, у вердикті перелічується окремо */
export type Status = "PASS" | "FAIL" | "INVALID" | "NOT_RUN" | "DEFERRED" | "AWAITING_SESSION_MODEL";

/**
 * Статус E3c (DEV-77). Поріг один, зафіксований до S4: Σ worse ≥ 4/5 (SCORING_SPEC §8.3). Dev (без --strict-live): рахуються
 * ЛИШЕ виміри, підтверджені кодом (F-DET/F-SUP/F-BRW); fake-LLM у статус не входить (його правила — дзеркало деградації).
 * Код ≥ 4 → PASS; інакше DEFERRED (⏭️: закриває лише живий пас). strict-live: усі виміри (код + жива модель) ≥ 4 → PASS, інакше FAIL.
 */
export function e3cStatus(res: Pick<E3cResult, "worse" | "worse_code">, strictLive: boolean): { status: Status; label: string } {
  const min = E3C_THRESHOLDS.min_worse;
  if (strictLive) {
    return res.worse >= min
      ? { status: "PASS", label: `гірше в ${res.worse} з 5 (гейт ≥ ${min}, strict-live: код + модель) → PASS` }
      : { status: "FAIL", label: `гірше в ${res.worse} з 5 < ${min} (strict-live: код + модель) → FAIL` };
  }
  return res.worse_code >= min
    ? { status: "PASS", label: `dev: кодом гірше в ${res.worse_code} з 5 (гейт ≥ ${min}) → PASS без LLM` }
    : { status: "DEFERRED", label: `⏭️ dev: кодом гірше в ${res.worse_code} з 5 < ${min} → гейт ≥ ${min}/5 не закривається без живої моделі (FAIL за кодом; статус ⏭️ live, не PASS)` };
}
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
  snapshots: { shop: string; clean: string; degraded?: string; /** S7: заморожений знімок фікстури ін'єкції (page.json + viewport.png) */ injection?: string };
  checks?: readonly CheckId[];
  /** сценарії негативних контролів: підміна оцінювача за перевіркою й номером прогону */
  evaluators?: Partial<Record<"e1" | "e2" | "e3a" | "e3c" | "e4", (run: number) => EvaluatorSpec>>;
  /** сценарій (б): знімок НЕ заморожений — інший каталог на прогін E2 (справжній збій, який E2 мусить ловити) */
  e2Snapshot?: (run: number) => string;
  /** сценарій (в): підміна режиму кешу для прогону E2 */
  e2CacheMode?: (run: number) => "use" | "bypass";
  /** true → «сума E1 ≥ 8» і LLM-виміри E3c стають гейтом (живий прогін S7); у dev вони лише показуються (fake) */
  strict_live?: boolean;
  /** S7 (DEV-82): LLM-частина через транспорт session (замість scripted fake) */
  session?: SessionBackend;
  /** E1: додатково розподіл y/3 по незалежних вибірках (моделі сесії з кешу; лише replay). DEV-88 */
  e1_samples?: { models: readonly string[] };
  max_validate_tokens?: number;
  max_audit_tokens?: number;
  /** E4: частка від використаних токенів, яку виставляємо як MAX_AUDIT_TOKENS обмеженого прогону */
  e4_limit_fraction?: number;
}
export interface ValidateResult {
  verdict: "PASS" | "FAIL" | "STOPPED" | "AWAITING";
  checks: CheckResult[];
  tokens: { max: number; used: number; provider_calls: number };
  provider: "scripted-fake" | "session";
  /** fake | session (Claude у сесії, без API) */
  llm_mode: "fake" | "session";
  banner: string | null;
  /** id запитів, записаних у requests/ під час цього прогону (лише session) */
  requests_written: string[];
  stopped_reason: string | null;
  /** звіти прогонів (для артефактів) */
  reports: Record<string, Report>;
}

const honest = (): EvaluatorSpec => ({ kind: "honest" });
const f3 = (x: number): string => x.toFixed(3);
const FAKE_LLM = "оцінювач — scripted fake, не модель: відповідь живої моделі (⏭️ live, OQ-1)";
const SESSION_LLM = "оцінювач — Claude у сесії (сліпі агенти), без API: якість = відповіді цієї моделі; адаптери API, usage/$ і конкретна продакшн-модель — ⏭️ (DEV-82)";

export async function runValidation(opts: ValidateOptions): Promise<ValidateResult> {
  const want = new Set<CheckId>(opts.checks ?? (opts.session ? ["E1", "E2", "E3a", "E3c", "E4", "INJ"] : ["E1", "E2", "E3a", "E3c", "E4"]));
  const meter = new ValidateMeter(opts.max_validate_tokens ?? DEFAULT_MAX_VALIDATE_TOKENS);
  const maxAudit = opts.max_audit_tokens ?? DEFAULT_MAX_AUDIT_TOKENS;
  const ev = (k: "e1" | "e2" | "e3a" | "e3c" | "e4", run = 0): EvaluatorSpec => opts.evaluators?.[k]?.(run) ?? honest();
  const LIVE_LLM = opts.session ? SESSION_LLM : FAKE_LLM;
  const requestsWritten: string[] = [];
  /** режим кешу й транспорт для прогону: fake → bypass (як було); session → use у namespace (bypass несумісний із кешем сесії; E2 = окремий namespace) */
  const mode = (ns: string, scenario: string): Pick<RunOptions, "cache_mode" | "session"> =>
    opts.session ? { cache_mode: "use", session: { ...opts.session, namespace: ns, scenario } } : { cache_mode: "bypass" };
  /** виконує прогони до кінця, навіть якщо котрийсь чекає відповідей: усі незалежні запити експортуються за один прохід */
  const collect = async <T,>(jobs: Array<() => Promise<T>>): Promise<T[]> => {
    const out: T[] = []; const waits: RunAwaiting[] = [];
    for (const j of jobs) { try { out.push(await j()); } catch (e) { if (e instanceof RunAwaiting) { waits.push(e); requestsWritten.push(...e.requests); } else throw e; } }
    if (waits.length) throw new RunAwaiting(waits.map((w) => w.label).join("+"), waits.reduce((a, w) => a + w.awaiting, 0), waits.reduce((a, w) => a + w.planned, 0), waits.flatMap((w) => w.requests));
    return out;
  };
  const awaitingCheck = (id: CheckId, e: unknown): void => {
    if (!(e instanceof RunAwaiting)) throw e;
    requestsWritten.push(...e.requests);
    checks.push({ id, status: "AWAITING_SESSION_MODEL", lines: [`awaiting_session_model: ${e.awaiting} з ${e.planned} викликів (${e.label}) чекають відповідей у responses/; нових запитів записано ${e.requests.length}`], live_deferred: [], data: { awaiting: e.awaiting, planned: e.planned, requests_written: e.requests } });
  };
  const shop = loadSnapshot(opts.snapshots.shop);
  const clean = loadSnapshot(opts.snapshots.clean);
  const checks: CheckResult[] = [];
  const reports: Record<string, Report> = {};
  let stopped: string | null = null;
  const keep = (r: RunResult) => { reports[r.label] = r.report; return r; };

  try {
    // ------------------------------------------------------------------ E1
    if (want.has("E1")) try {
      const full = keep(await buildRunReport(shop, "e1-full", { spec: ev("e1"), ...mode("s7", "fixture-shop"), max_audit_tokens: maxAudit, meter }));
      const abl = ablateHints(shop.art);
      const ablated = keep(await buildRunReport(shop, "e1-ablation", { spec: ev("e1"), ...mode("s7", "fixture-shop"), max_audit_tokens: maxAudit, meter, ablate: true }));
      const rFull: E1Result = e1(full.findings);
      const rAbl: E1Result = e1(ablated.findings);
      const detOk = rFull.det.x === E1_GATE.det_of;
      const totalOk = e1Gate(rFull);
      // критерій S4 №2 (DEV-76): 7/7 детермінованих у топ-10 ПОВНОГО звіту з гіпотезами; контроль — той самий звіт у порядку scoring-v1
      const rank: E1RankResult = e1RankGate(full.findings);
      const rankV1: E1RankResult = e1RankGate(rerankV1(full.findings));
      const dist = opts.e1_samples && opts.session ? await runE1Samples({ shop, root: opts.session.root, models: opts.e1_samples.models, meter, max_audit_tokens: maxAudit, primary: { model: opts.session.model, y: rAbl.llm.y } }) : null;
      const status: Status = detOk && rank.pass && (!opts.strict_live || totalOk) ? "PASS" : "FAIL";
      const rankLine = (r: E1RankResult) => r.ranks.map((x) => `№${x.id}→${x.rank ?? "—"}`).join(" ");
      checks.push({
        id: "E1", status,
        lines: [
          `детерміновані x/7 = ${rFull.det.x}/${rFull.det.of} (VERIFIED, F-DET; гейт ${E1_GATE.det_of}/7)`,
          `ранг [ГЕЙТ, кр.2]: детерміновані в топ-${E1_RANK_GATE.top} = ${rank.in_top}/${rank.of} (${rankLine(rank)}; у звіті ${rank.findings} знахідок, з них гіпотез ${rank.hypotheses}${rank.findings <= E1_RANK_GATE.top ? " — ≤ 10, гейт тривіальний за побудовою" : ""})`,
          `контроль рангу: той самий звіт у порядку scoring-v1 (лише priority desc) → ${rankV1.in_top}/${rankV1.of} ${rankV1.pass ? "PASS (контроль НЕ впав: гіпотез замало, щоб перевірити правило)" : `FAIL ✓ (${rankLine(rankV1)})`}`,
          `LLM-лише y/3 = ${rAbl.llm.y}/${rAbl.llm.of} (абляція: прибрано ${abl.removed} опорних доказів №1/№3/№4; показник, не гейт)`,
          `разом ${rFull.total}/10 (гейт ≥ ${E1_GATE.min_total}: ${totalOk ? "виконано" : "не виконано"} — залежить від LLM, ${opts.strict_live ? "ГЕЙТ (strict-live)" : "⏭️ live, у dev не гейт"})`,
          `опорні детектори №1/№3/№4 (${SUPPORT_HINT_DETECTORS.join(", ")}) у S1a НЕ реалізовані → ablation-arm ≡ full-arm за побудовою (прибрано ${abl.removed}); механізм абляції перевірено тестом`,
          `непередбачені знахідки (не гейт): ${rFull.unexpected.length ? rFull.unexpected.join(", ") : "немає"}`,
          `не вимірюється тут: 7 мутантів мовчать і двійник — \`pnpm run audit:fixture\` / S1a (E1, SCORING_SPEC §8.1)`,
          ...(dist ? formatE1Distribution(dist) : []),
        ],
        live_deferred: [`E1_llm=${rAbl.llm.y}/3 і сума ${rFull.total}/10: ${LIVE_LLM}`],
        data: { full: rFull, ablation: rAbl, removed_hints: abl.removed, gate: { det_ok: detOk, total_ok: totalOk, rank_ok: rank.pass }, rank, rank_v1_control: rankV1, ...(dist ? { samples: dist } : {}) },
      });
    }

    catch (e) { awaitingCheck("E1", e); }

    // ------------------------------------------------------------------ E2
    if (want.has("E2") && opts.session) try {
      // S7: три прогони замороженого знімка з ОКРЕМИМ namespace (bypass у розумінні E2: жодного спільного кешу між прогонами; відповіді — незалежні)
      const sess = opts.session;
      const nss = [1, 2, 3].map((i) => `s7-e2-run${i}`);
      const runs = await collect(nss.map((ns, i) => () => buildRunReport(opts.e2Snapshot ? loadSnapshot(opts.e2Snapshot(i)) : shop, `e2-run${i + 1}`, { spec: ev("e2", i), ...mode(ns, `fixture-shop/e2-run${i + 1}`), max_audit_tokens: maxAudit, meter }).then(keep)));
      const prov = sessionProvenance(sess, runs, nss);
      const m: E2Metrics = e2Metrics(runs.map((r) => r.findings));
      const gate: E2Gate = e2Gate(m);
      const mb: E2Metrics = e2Metrics(runs.map((r) => r.findings.filter(isLlmOnly)));
      const unstable: RunResult[] = [];
      for (let i = 0; i < 3; i++) unstable.push(await buildRunReport(shop, `e2-control-unstable${i + 1}`, { spec: { kind: "unstable", run: i }, cache_mode: "bypass", max_audit_tokens: maxAudit, meter }));
      const mu: E2Metrics = e2Metrics(unstable.map((r) => r.findings.filter(isLlmOnly)));
      const unstableCaught = mu.jcat_mean < E2_THRESHOLDS.llm_jcat_mean_target;
      const llmEmpty = mb.set_sizes.every((n) => n === 0);
      const status: Status = !prov.valid ? "INVALID" : gate.pass ? "PASS" : "FAIL";
      checks.push({
        id: "E2", status,
        lines: [
          prov.valid
            ? `валідність: 3 прогони в різних namespace (${nss.join(", ")}), кожна відповідь має provenance {provider:session, answered_by:${SESSION_ANSWERED_BY}, synthetic:false}; ${prov.entries} записів, спільного кешу між прогонами немає. cache_read_tokens ≠ 0 тут НЕ є ознакою недійсності: це відтворення записаних відповідей власного namespace (replay ≠ повторне використання відповіді іншого прогону)`
            : `НЕДІЙСНИЙ: ${prov.reasons.join("; ")}`,
          `незалежність: для ${prov.keys_differing}/${prov.keys_total} однакових запитів відповіді між прогонами відрізняються (байтово)`,
          `E2(а) повний звіт [ГЕЙТ]: Jcat mean/min ${f3(m.jcat_mean)}/${f3(m.jcat_min)} (≥ ${E2_THRESHOLDS.jcat_mean}/${E2_THRESHOLDS.jcat_min}), Jpg mean/min ${f3(m.jpg_mean)}/${f3(m.jpg_min)}, |K3|=${m.k3.length} (≥ ${E2_THRESHOLDS.k3_min}) → ${gate.pass ? "PASS" : "FAIL"}`,
          `E2(б) лише LLM-знахідки [показник]: ${llmEmpty ? "LLM-знахідок немає (J тривіально 1 — НЕ доказ стабільності)" : `Jcat mean ${f3(mb.jcat_mean)} (ціль ≥ ${E2_THRESHOLDS.llm_jcat_mean_target}), розміри множин ${mb.set_sizes.join("/")}`}`,
          `контроль E2(б) (scripted fake, не сесія): нестабільний оцінювач → E2(б) Jcat mean ${f3(mu.jcat_mean)} ${unstableCaught ? `< ${E2_THRESHOLDS.llm_jcat_mean_target} ✓ (показник вміє впасти)` : "— КОНТРОЛЬ НЕ СПРАЦЮВАВ"}`,
          `RBO(p=0.8) топ-10 [інформативно]: ${m.rbo10.map(f3).join("/")} (середнє ${f3(m.rbo10_mean)})`,
        ],
        live_deferred: [`стабільність LLM-знахідок (E2(б), RBO): ${LIVE_LLM}; три «прогони» = три незалежні відповіді сліпих агентів тієї самої моделі-сесії, не три виклики API`],
        data: { validity: prov, metrics: m, gate, llm_only: mb, control_unstable: { llm_only: mu, caught: unstableCaught }, namespaces: nss, top5: runs.map((r) => r.findings.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map((f) => f.finding_key)) },
      });
    } catch (e) { awaitingCheck("E2", e); }
    if (want.has("E2") && !opts.session) {
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
      // контроль E2(б) (кр.8, сценарій (б) у чутливій формі): НЕСТАБІЛЬНИЙ оцінювач на ТОМУ САМОМУ замороженому знімку.
      // Показник E2(б) мусить упасти нижче цілі; E2(а) при цьому може лишитися PASS (топ-5 — детерміновані) — це видно в рядку.
      const unstable: RunResult[] = [];
      for (let i = 0; i < 3; i++) unstable.push(await buildRunReport(shop, `e2-control-unstable${i + 1}`, { spec: { kind: "unstable", run: i }, cache_mode: "bypass", max_audit_tokens: maxAudit, meter }));
      const mu: E2Metrics = e2Metrics(unstable.map((r) => r.findings.filter(isLlmOnly)));
      const gu: E2Gate = e2Gate(e2Metrics(unstable.map((r) => r.findings)));
      const unstableCaught = mu.jcat_mean < E2_THRESHOLDS.llm_jcat_mean_target;
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
          `контроль E2(б): нестабільний оцінювач на тому ж замороженому знімку → E2(б) Jcat mean ${f3(mu.jcat_mean)} ${unstableCaught ? `< ${E2_THRESHOLDS.llm_jcat_mean_target} ✓ (показник вміє впасти)` : `≥ ${E2_THRESHOLDS.llm_jcat_mean_target} — КОНТРОЛЬ НЕ СПРАЦЮВАВ`}; E2(а) при цьому ${gu.pass ? "PASS (обмеження: E2(а) на shop нечутливий до LLM — топ-5 детерміновані; E2(б) — показник, не гейт, G0-8)" : "FAIL"}`,
          `RBO(p=0.8) топ-10 [інформативно]: ${m.rbo10.map(f3).join("/")} (середнє ${f3(m.rbo10_mean)})`,
          `топ-5 (прогін 1): ${runs[0]!.findings.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map((f) => f.finding_key).join(" · ")}`,
        ],
        live_deferred: [`стабільність LLM-знахідок (E2(б), RBO): ${LIVE_LLM}; fake детермінований → J=1 доводить обв'язку, не стабільність моделі`],
        data: { validity, metrics: m, gate, llm_only: mb, control: { cache_read_tokens: control.counters.cache_read_tokens, invalid: controlInvalid }, control_unstable: { llm_only: mu, gate_a_pass: gu.pass, caught: unstableCaught }, top5: runs.map((r) => r.findings.slice().sort((a, b) => a.rank - b.rank).slice(0, 5).map((f) => f.finding_key)) },
      });
    }

    // ------------------------------------------------------------------ E3a
    if (want.has("E3a")) try {
      const r = keep(await buildRunReport(clean, "e3a-clean", { spec: ev("e3a"), ...mode("s7", "shop-clean"), max_audit_tokens: maxAudit, meter }));
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

    catch (e) { awaitingCheck("E3a", e); }

    // ------------------------------------------------------------------ E3c
    if (want.has("E3c")) try {
      if (!opts.snapshots.degraded) {
        checks.push({ id: "E3c", status: "NOT_RUN", lines: ["знімок деградованої копії не надано (потрібен браузерний аудит site-b.test)"], live_deferred: [], data: null });
      } else {
        const degraded = loadSnapshot(opts.snapshots.degraded);
        // session: «оригінал» = ті самі запити, що E3a (той самий знімок, лінзи, задачі) → ті самі відповіді; fake: окремий bypass-прогін як було
        const [a, b] = await collect([
          () => buildRunReport(clean, "e3c-original", { spec: ev("e3c"), ...mode("s7", "shop-clean-degraded"), max_audit_tokens: maxAudit, meter }).then(keep),
          () => buildRunReport(degraded, "e3c-degraded", { spec: ev("e3c"), ...mode("s7", "shop-clean-degraded"), max_audit_tokens: maxAudit, meter }).then(keep),
        ]) as [RunResult, RunResult];
        const res: E3cResult = e3c(a.findings, b.findings);
        const st = e3cStatus(res, !!opts.strict_live);
        checks.push({
          id: "E3c", status: st.status,
          lines: [
            st.label,
            `КОДОМ (F-DET/F-SUP/F-BRW) гірше в ${res.worse_code}/5: ${res.dims.filter((d) => d.worse_code).map((d) => d.label).join(", ") || "жодного"}; лише LLM ${res.worse_llm_only}/5`,
            ...res.dims.map((d) => `  ${d.label}: D ${d.d_original}→${d.d_degraded}, нових STRONG/VERIFIED ${d.new_strong_or_verified.length}, worse=${d.worse ? "так" : "ні"} [${d.source}]`),
            `обв'язка (НЕ статус): з fake-оцінювачем гірше в ${res.worse} з 5. Правила fake написано під ці самі 5 змін деградації (comparison = «немає цін на картках», trust = «немає "Про нас" і гарантії», headline = H1 без основ сайту) — кругова перевірка плумбінгу, не вимір`,
            `шум решти категорій |ΔD| (інформативно): ${Object.entries(res.other_delta).map(([k, v]) => `${k}=${v}`).join(", ") || "немає"}`,
            `сліпий прогін: нейтральні хости site-a.test (база) / site-b.test (копія), слова «degraded» немає в URL/тексті/заголовках (перевіряє тест фікстури)`,
          ],
          live_deferred: [`LLM-виміри (headline, comparison, trust) і сам гейт ≥ ${E3C_THRESHOLDS.min_worse}/5: ${LIVE_LLM}. Код сам дає ${res.worse_code}/5 < ${E3C_THRESHOLDS.min_worse}: без живої LLM гейт E3c недосяжний за побудовою (DEV-77)`],
          data: res,
        });
      }
    }

    catch (e) { awaitingCheck("E3c", e); }

    // ------------------------------------------------------------------ INJ (лише session)
    if (want.has("INJ") && opts.session) try {
      if (!opts.snapshots.injection) checks.push({ id: "INJ", status: "NOT_RUN", lines: ["знімок фікстури ін'єкції не надано"], live_deferred: [], data: null });
      else {
        const { runInjection } = await import("./injection.js");
        const r = await runInjection(opts.snapshots.injection, opts.session);
        checks.push({ id: "INJ", status: r.status, lines: r.lines, live_deferred: [`стійкість моделі до ін'єкцій на вибірці більшій за 4 виклики й на живому API: ${LIVE_LLM}`], data: r.data });
      }
    } catch (e) { awaitingCheck("INJ", e); }

    // ------------------------------------------------------------------ E4
    if (want.has("E4") && opts.session) {
      checks.push({ id: "E4", status: "NOT_RUN", lines: ["E4 у транспорті session не вимірюється: токени — оцінка за символами (estimated), не usage провайдера; обмежений прогін теж не має сенсу для відповідей, які вже записано"], live_deferred: ["E4: фактичні токени/вартість — ⏭️ (API-адаптер або claude-cli з usage)"], data: null });
    } else if (want.has("E4")) {
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
  const awaitingAny = checks.some((c) => c.status === "AWAITING_SESSION_MODEL");
  for (const id of ["E1", "E2", "E3a", "E3c", "E4", "INJ"] as const) if (want.has(id) && !ran.has(id)) checks.push({ id, status: "NOT_RUN", lines: ["не виконано: validate зупинено лімітом MAX_VALIDATE_TOKENS"], live_deferred: [], data: null });
  const bad = checks.some((c) => c.status === "FAIL" || c.status === "INVALID");
  return {
    verdict: stopped ? "STOPPED" : bad ? "FAIL" : awaitingAny ? "AWAITING" : "PASS", checks, tokens: { max: meter.max, used: meter.used, provider_calls: meter.calls },
    provider: opts.session ? "session" : "scripted-fake", llm_mode: opts.session ? "session" : "fake", banner: opts.session ? SESSION_BANNER : null,
    requests_written: [...new Set(requestsWritten)], stopped_reason: stopped, reports,
  };
}

// ------------------------------------------------------------------------------------------------ вивід
export function formatResult(r: ValidateResult): string {
  const out: string[] = [];
  out.push(r.llm_mode === "session"
    ? `pnpm validate — llm_mode=session — ${SESSION_BANNER}. Відповіді — сліпі агенти (provenance answered_by=${SESSION_ANSWERED_BY}); токени — оцінка (estimated); адаптери API, usage/$, продакшн-модель — ⏭️`
    : `pnpm validate — провайдер: scripted fake (НЕ модель); LLM-залежне = ⏭️ live, не ✅`);
  for (const c of r.checks) {
    const mark = c.status === "AWAITING_SESSION_MODEL" ? "AWAITING_SESSION_MODEL (не completed)" : c.status === "PASS" ? "PASS" : c.status === "NOT_RUN" ? "NOT RUN" : c.status === "DEFERRED" ? "⏭️ DEFERRED (live)" : c.status;
    out.push(`\n[${c.id}] ${mark}`);
    for (const l of c.lines) out.push(`  ${l}`);
    for (const d of c.live_deferred) out.push(`  ⏭️ live: ${d}`);
  }
  out.push(`\nтокени: ${r.tokens.used}/${r.tokens.max} (MAX_VALIDATE_TOKENS), викликів провайдера ${r.tokens.provider_calls}`);
  if (r.stopped_reason) out.push(`ЗУПИНЕНО: ${r.stopped_reason}`);
  const deferred = r.checks.filter((c) => c.status === "DEFERRED").map((c) => c.id);
  out.push(`ВЕРДИКТ (${r.llm_mode === "session" ? "session" : "dev"}): ${r.verdict}${r.verdict === "AWAITING" ? " — чекаємо відповідей сесійної моделі (responses/), результат НЕ рахується" : ""}${r.verdict === "PASS" ? ` — обв'язка працює; якість моделі не перевірено (⏭️ live)${deferred.length ? `; не закрито в dev (⏭️): ${deferred.join(", ")}` : ""}` : ""}`);
  return out.join("\n");
}

export { plannedCalls };
