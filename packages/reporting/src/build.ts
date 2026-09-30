/**
 * buildReport(артефакти аудиту, llm-результати?) → Report за контрактом `@sitelens/schemas` (report.ts).
 * Числа ставить `@sitelens/scoring`; тексти — шаблони коду або LLM-тексти, що пройшли структурне правило чисел (DEV-58).
 * Результат валідується `Report` (Zod) перед поверненням — невалідний звіт не виходить із функції.
 */
import { createHash } from "node:crypto";
import {
  DISCLAIMER_TEXT, FUNNEL_STAGES, REPORT_SCHEMA_VERSION, Report, numberViolations, placeholders,
  type Evidence, type ReportEvidence, type ReportFinding, type PositiveFinding, type TemplatedText, type SyntheticCount,
} from "@sitelens/schemas";
import { aggregate, funnel, SCORING_VERSION, type ScoredFinding } from "@sitelens/scoring";
import type { GuardedField } from "@sitelens/llm";
import { GUARD_VERSION, guardLlmTextSync, scanReport } from "./guard.js";
import { guardText } from "@sitelens/llm";
import { positiveFindings } from "./positives.js";
import {
  AXE_TEMPLATES, BANNER_TEXT, EVIDENCE_TEMPLATES, FINDING_TEMPLATES, GENERIC_TEMPLATES, POSITIVE_TEMPLATES, codeText, type FindingTemplates,
} from "./templates.js";
import type { AuditArtifacts, BuildOptions, LlmResults, LlmText, VP } from "./types.js";

type Lang = "uk" | "en";
type ReportT = Report;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const LLM_STAGES = ["site_profile", "tasks", "lenses", "scenario_matrix", "snapshot_sessions", "browser_sessions"] as const;
export const DEFAULT_MAX_AUDIT_TOKENS = 1_650_000; // DEV-44 (packages/llm/src/budget.ts)
const THRESHOLD_BYTES = 512_000; // DEV-20

/** словник плейсхолдерів, доступних LLM-тексту знахідки → поле знахідки */
export const FINDING_VARS: Record<string, { field: string; format: TemplatedText["params"][string]["format"] }> = {
  page_count: { field: "page_count", format: "int" },
  instances: { field: "instances", format: "int" },
  priority: { field: "priority/value", format: "priority" },
  lens_coverage: { field: "synthetic/lens_coverage", format: "n_of_m" },
  session_frequency: { field: "synthetic/session_frequency", format: "n_of_m" },
  task_coverage: { field: "synthetic/task_coverage", format: "n_of_m" },
};

export interface StructuralRejection { where: string; reason: string }

/** лічильники guard за один buildReport (SPEC §33): on=false лише для provenance=example_fixture (тексти лишаються `pending`) */
interface GuardState { on: boolean; fields: number; interventions: number; sentences_removed: number }
const guardFieldOf = (where: string): GuardedField => (where.startsWith("lens:") ? "lens_description" : where.startsWith("site_understanding") ? "site_profile" : "finding_text");

/** LLM-текст → TemplatedText або відхилення (цифра / числівник / невідомий чи недоступний плейсхолдер) */
function llmText(t: LlmText | undefined, lang: Lang, ptrBase: string | null, available: ReadonlySet<string>, where: string, rej: StructuralRejection[], gs: GuardState): TemplatedText | null {
  if (!t) return null;
  if (t.text.trim().length === 0) { if (gs.on) { gs.interventions++; rej.push({ where, reason: "guard:all_sentences_removed" }); } return null; }
  const v = numberViolations(t.text, true);
  if (v.length) {
    rej.push({ where, reason: `number:${v.map((x) => x.span).join(",")}` });
    return null;
  }
  const ph = placeholders(t.text);
  const bad = ph.filter((p) => !FINDING_VARS[p] || ptrBase === null || !available.has(p));
  if (bad.length || /[{}]/.test(t.text.replace(/\{[a-z][a-z0-9_]*\}/g, ""))) {
    rej.push({ where, reason: `placeholder:${bad.join(",") || "braces"}` });
    return null;
  }
  const params = Object.fromEntries(ph.map((p) => [p, { ptr: `${ptrBase}/${(FINDING_VARS[p] as { field: string }).field}`, format: (FINDING_VARS[p] as { format: TemplatedText["params"][string]["format"] }).format }]));
  let text = t.text;
  let guard: TemplatedText["guard"] = { status: t.guard_status, attempts: t.guard_attempts ?? 0, rule_ids: t.guard_rule_ids ?? [] };
  if (gs.on) {
    // друга лінія (лексика, бізнес-відсотки, прогнози без чисел): порушні речення видаляються, порожнє → кодовий шаблон
    gs.fields++;
    const g = guardLlmTextSync(t, guardFieldOf(where));
    if (g.status === "sentences_removed") {
      gs.interventions++;
      gs.sentences_removed += g.sentences_removed;
      rej.push({ where, reason: `guard:${g.rule_ids.join(",")}` });
    }
    if (g.text === null) return null;
    text = g.text;
    guard = { status: g.status, attempts: g.attempts, rule_ids: g.rule_ids };
    const ph2 = placeholders(text);
    for (const k of Object.keys(params)) if (!ph2.includes(k)) delete params[k];
  }
  return {
    template: text, params, origin: "llm", source_class: t.source_class, lang, template_id: t.prompt_id, guard,
  };
}

/**
 * Продуктовий шлях ОДНОГО LLM-тексту — для вимірювання на корпусах (scripts/guard-sealed.ts --path product), без зміни логіки:
 * (1) `llmText` як у buildReport: структурне правило чисел (цифра/числівник → поле відхилено цілком), плейсхолдери лише з
 * FINDING_VARS, далі лексичний guard із видаленням порушних речень; (2) сканер звіту на шаблоні результату (`guardText`
 * структурно, як `scanReport` у GET /report): порушення → звіт не віддається (fail-closed, 503).
 * `delivered` — текст, який дійшов би до користувача без змін; інакше `null`/змінений текст і причина.
 */
export function productLlmTextPath(text: string, o: { lang: Lang; field: GuardedField }): { outcome: "delivered" | "rejected_structural" | "rejected_placeholder" | "sentences_removed" | "dropped" | "withheld_by_scan"; delivered: string | null } {
  const rej: StructuralRejection[] = [];
  const gs: GuardState = { on: true, fields: 0, interventions: 0, sentences_removed: 0 };
  const isFinding = o.field !== "lens_description" && o.field !== "site_profile";
  const where = o.field === "lens_description" ? "lens:corpus:description" : o.field === "site_profile" ? "site_understanding:corpus" : "finding:corpus:problem";
  const t: LlmText = { text, source_class: "INFERRED", prompt_id: "corpus", guard_status: "pending" };
  const out = llmText(t, o.lang, isFinding ? "/findings/0" : null, new Set(isFinding ? Object.keys(FINDING_VARS) : []), where, rej, gs);
  if (!out) {
    const r = rej[0]?.reason ?? "";
    return { outcome: r.startsWith("number:") ? "rejected_structural" : r.startsWith("placeholder:") ? "rejected_placeholder" : "dropped", delivered: null };
  }
  if (!guardText(out.template, { field: o.field }).ok) return { outcome: "withheld_by_scan", delivered: null };
  return { outcome: out.template === text ? "delivered" : "sentences_removed", delivered: out.template };
}

const prim = (m: Record<string, unknown> | undefined): Record<string, number | string | boolean | null> =>
  Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v === null || ["number", "string", "boolean"].includes(typeof v)).sort(([a], [b]) => cmp(a, b))) as Record<string, number | string | boolean | null>;

function syntheticCount(r: { n: number; m: number }, unit: SyntheticCount["unit"]): SyntheticCount | null {
  return r.m === 0 ? null : { form: "n_of_m_synthetic", n: r.n, m: r.m, unit, disclaimer: "synthetic_single_model_correlated" };
}

function templatesFor(f: ScoredFinding): FindingTemplates {
  if (f.claim_kind.startsWith("axe:")) return AXE_TEMPLATES;
  return FINDING_TEMPLATES[f.claim_kind] ?? GENERIC_TEMPLATES;
}

export function buildReport(art: AuditArtifacts, llm: LlmResults | null, opts: BuildOptions): { report: ReportT; rejected: StructuralRejection[] } {
  const lang = art.audit.language;
  const rej: StructuralRejection[] = [];
  const mode = llm ? llm.mode : "none";
  const gs: GuardState = { on: !!llm && (opts.provenance?.kind ?? "audit") === "audit", fields: 0, interventions: 0, sentences_removed: 0 };
  const pageByPath = new Map(art.pages.map((p) => [p.path, p]));
  const pageTypes = Object.fromEntries(art.pages.map((p) => [p.path, p.page_type]));

  // ---------------------------------------------------------------- агрегація й скоринг
  const allEv = [...art.evidence, ...(llm?.evidence ?? [])];
  const agg = aggregate({ evidence: allEv, sessions: llm?.sessions ?? [], pageTypes, counter: llm?.counter ?? {} });
  const evById = new Map(allEv.map((e) => [e.id, e]));
  const counterEv = Object.values(llm?.counter ?? {}).flat();

  // ---------------------------------------------------------------- докази
  const evidenceOut: ReportEvidence[] = [];
  const evPtr = (i: number, k: string) => ({ ptr: `/evidence/${i}/measurement/${k}`, format: "int" as const });
  const pushEvidence = (e: Evidence, tier: ReportEvidence["tier"], polarity: ReportEvidence["polarity"]) => {
    const path = e.page_path ?? new URL(e.page_url).pathname;
    const page = pageByPath.get(path);
    const vp = (e.viewport ?? null) as VP | null;
    const m = prim(e.measurement);
    if (vp && page?.viewport[vp]) {
      m["viewport_height"] = page.viewport[vp]?.h ?? null;
      m["viewport_width"] = page.viewport[vp]?.w ?? null;
    }
    if (e.detector_id === "oversized_image") m["threshold_bytes"] = THRESHOLD_BYTES;
    const i = evidenceOut.length;
    let description: TemplatedText;
    const sc = e.source_class;
    if (sc === "SYNTHETIC" || sc === "INFERRED") {
      description = llmText(llm?.evidence_text[e.id], lang, null, new Set(), `evidence:${e.id}`, rej, gs)
        ?? codeText("evidence.llm.fallback", { en: "Model observation recorded for this page (text withheld by the numeric rule or not provided).", uk: "Спостереження моделі для цієї сторінки (текст утримано числовим правилом або не надано)." }, lang, sc);
    } else {
      const det = e.detector_id ?? "";
      const tkey = det.startsWith("axe:") ? "axe" : det === "price_first_viewport" ? `price_first_viewport:${m["reason"] === "none_on_page" ? "none_on_page" : "below"}` : det;
      const t = EVIDENCE_TEMPLATES[tkey];
      const params = t ? Object.fromEntries(t.params.filter((k) => m[k] !== undefined && m[k] !== null).map((k) => [k, typeof m[k] === "string" ? { ptr: `/evidence/${i}/measurement/${k}`, format: "text" as const } : evPtr(i, k)])) : {};
      const complete = t && t.params.every((k) => params[k] !== undefined);
      description = complete
        ? codeText(`evidence.${tkey}`, t.pair, lang, sc, params)
        : codeText("evidence.detector.generic", { en: "Detector {detector} recorded this fact; see the measurement and screenshot.", uk: "Детектор {detector} зафіксував цей факт; див. вимір і скриншот." }, lang, sc, { detector: { ptr: `/evidence/${i}/detector_id`, format: "text" } });
    }
    const sor = e.selector_or_region;
    evidenceOut.push({
      id: e.id, type: e.type, source_class: sc, tier, polarity, page_url: e.page_url, page_path: path, page_type: e.page_type ?? page?.page_type ?? null, viewport: vp,
      detector_id: e.detector_id ?? null, claim_kind: e.claim_kind ?? null, assertion: e.assertion ?? null, description,
      excerpt: e.excerpt ?? null, artifact_reference: e.artifact_reference, screenshot_reference: e.screenshot_reference ?? null,
      selector: sor.selector ?? null, region: sor.region ?? null, capture_complete: e.capture_complete ?? null, incomplete_reasons: e.incomplete_reasons ?? [],
      measurement: m, session_id: e.session_id ?? null, lens_id: e.lens_id ?? null, task_id: e.task_id ?? null, level: e.level ?? null,
    });
  };
  for (const f of agg.findings) for (const id of f.evidence_ids) pushEvidence(evById.get(id) as Evidence, f.tiers[id] ?? null, "problem");
  for (const e of counterEv.slice().sort((a, b) => cmp(a.id, b.id))) if (!evidenceOut.some((x) => x.id === e.id)) pushEvidence(e, "ET-DET", "counter");

  // ---------------------------------------------------------------- знахідки
  const findings: ReportFinding[] = agg.findings.map((f, idx) => {
    const base = `/findings/${idx}`;
    const tpl = templatesFor(f);
    const lensC = syntheticCount(f.coverage.lens, "lenses");
    const sessC = syntheticCount(f.coverage.session, "sessions");
    const taskC = syntheticCount(f.coverage.task, "tasks");
    const available = new Set(["page_count", "instances", "priority", ...(lensC ? ["lens_coverage"] : []), ...(sessC ? ["session_frequency"] : []), ...(taskC ? ["task_coverage"] : [])]);
    const lt = llm?.finding_texts[f.finding_key] ?? {};
    const L = (k: keyof typeof lt) => llmText(lt[k], lang, base, available, `finding:${f.finding_key}:${k}`, rej, gs);
    const recClass = "BENCHMARKED" as const;
    const factClass = evidenceOut.find((e) => e.id === f.evidence_ids.find((id) => f.tiers[id] === "ET-DET"))?.source_class ?? "INFERRED";
    const codeParams = (pair: { en: string; uk: string }) => Object.fromEntries(placeholders(pair[lang]).map((p) => [p, p === "rule" ? { ptr: `${base}/claim_kind`, format: "text" as const } : p === "category" ? { ptr: `${base}/category`, format: "text" as const } : { ptr: `${base}/${p}`, format: "int" as const }]));
    const code = (part: keyof FindingTemplates, sc: TemplatedText["source_class"]) => {
      const pair = tpl[part];
      return pair ? codeText(`finding.${part}.${f.claim_kind.startsWith("axe:") ? "axe" : FINDING_TEMPLATES[f.claim_kind] ? f.claim_kind : "generic"}`, pair, lang, sc, codeParams(pair)) : null;
    };
    const verified = f.confidence.level === "VERIFIED";
    // детермінована знахідка → твердження детектора (OBSERVED/BENCHMARKED); гіпотеза без LLM-тексту → INFERRED-шаблон
    const factSc = verified ? factClass : "INFERRED";
    const title = L("title") ?? (code("title", factSc) as TemplatedText);
    const problem = L("problem") ?? (code("problem", factSc) as TemplatedText);
    const why = L("why_it_matters") ?? code("why", recClass);
    const change = L("recommended_change") ?? code("change", recClass);
    const validate = L("how_to_validate") ?? code("validate", recClass);
    const tasks = new Set(f.evidence_ids.map((id) => evById.get(id)?.task_id).filter((x): x is string => !!x));
    const lenses = new Set(f.evidence_ids.map((id) => evById.get(id)?.lens_id).filter((x): x is string => !!x));
    return {
      id: f.id, finding_key: f.finding_key, category: f.category, page_group: f.page_group, claim_kind: f.claim_kind, component: f.component,
      rank: f.rank, pages: f.pages, page_count: f.pages.length,
      title, problem, why_it_matters: why, recommendation: change && validate ? { recommended_change: change, how_to_validate: validate } : null,
      confidence: f.confidence, severity: f.severity, funnel: f.funnel, evidence_strength: f.strength,
      synthetic: { lens_coverage: lensC, session_frequency: sessC, task_coverage: taskC, in_priority: f.synthetic_in_priority },
      priority: f.priority, evidence_ids: f.evidence_ids, instances: f.instances,
      affected_task_ids: [...new Set([...tasks, ...f.coverage.task_ids])].sort(cmp),
      affected_lens_ids: [...new Set([...lenses, ...f.coverage.lens_ids])].sort(cmp),
      executive_eligible: f.confidence.contradiction === null,
    };
  });

  // ---------------------------------------------------------------- позитиви §29
  const pos = positiveFindings(art.pages, findings.map((f) => f.finding_key));
  const positives: PositiveFinding[] = pos.positives.map((p): PositiveFinding => {
    const t = POSITIVE_TEMPLATES[p.kind] as (typeof POSITIVE_TEMPLATES)[string];
    const ids: string[] = [];
    for (const e of p.evidence) {
      const i = evidenceOut.length;
      const params = Object.fromEntries(t.params.map((k) => [k, { ptr: `/evidence/${i}/measurement/${k}`, format: "int" as const }]));
      evidenceOut.push({
        id: e.id, type: "dom", source_class: "OBSERVED", tier: "ET-DET", polarity: "positive", page_url: e.page.url, page_path: e.page.path, page_type: e.page.page_type, viewport: e.vp,
        detector_id: `positive:${p.kind}`, claim_kind: null, assertion: "presence", description: codeText(`positive.evidence.${p.kind}`, t.evidence, lang, "OBSERVED", params),
        excerpt: e.excerpt, artifact_reference: e.page.screenshot[e.vp] ?? "pages.json", screenshot_reference: e.page.screenshot[e.vp] ?? null, selector: null, region: null,
        capture_complete: e.page.capture[e.vp]?.capture_complete ?? null, incomplete_reasons: [], measurement: { ...e.measurement }, session_id: null, lens_id: null, task_id: null, level: null,
      });
      ids.push(e.id);
    }
    return {
      id: "pos_" + createHash("sha256").update(p.key).digest("hex").slice(0, 12), key: p.key, category: p.category, page_group: p.page_group, basis: "detector", confidence: "VERIFIED",
      title: codeText(`positive.title.${p.kind}`, t.title, lang, "OBSERVED"), detail: null,
      pages: p.pages.map((x) => ({ url: x.url, path: x.path, page_type: x.page_type })), evidence_ids: ids,
    };
  }).sort((a, b) => cmp(a.key, b.key));

  // ---------------------------------------------------------------- воронка, технічне, покриття
  const funnelSteps = FUNNEL_STAGES.map((stage) => ({
    stage,
    finding_ids: findings.filter((f) => f.funnel.stage === stage).map((f) => f.id),
    positive_ids: positives.filter((p) => funnel(p.category, p.pages.map((x) => x.page_type)).stage === stage).map((p) => p.id),
  }));
  const keyToId = new Map(findings.map((f) => [f.finding_key, f.id]));
  const lh = art.lighthouse ?? { status: "not_run" as const, reason: "lighthouse results not provided to the report builder", runs: [] };
  const technical = {
    status: (art.pages.length === 0 ? "failed" : lh.status === "done" && art.pages.every((p) => Object.values(p.capture).every((c) => c?.capture_complete)) ? "ok" : "partial") as "ok" | "partial" | "failed",
    lighthouse: { status: lh.status, reason: lh.reason, runs: lh.runs.map((r) => ({ ...r, evidence_id: null })) },
    accessibility: {
      engine: "axe-core" as const, version: art.axe_version,
      groups: art.axe_groups.map((g) => ({
        rule: g.rule, impact: (["critical", "serious", "moderate", "minor"].includes(g.impact ?? "") ? g.impact : null) as "critical" | "serious" | "moderate" | "minor" | null,
        page_group: g.page_group, component: g.component, instances: g.instances, pages: g.pages, viewports: g.viewports,
        finding_id: keyToId.get(`accessibility|${g.page_group}|axe:${g.rule}|${g.component}`) ?? null,
      })),
      disclaimer: "automated_a11y_not_wcag_audit" as const,
    },
  };
  const coverageOut = {
    pages: art.pages.map((p) => ({
      url: p.url, path: p.path, page_type: p.page_type, page_type_reason: p.page_type_reason,
      capture_complete: { D: p.capture.D?.capture_complete ?? null, M: p.capture.M?.capture_complete ?? null },
      incomplete_reasons: [...new Set([...(p.capture.D?.incomplete_reasons ?? []), ...(p.capture.M?.incomplete_reasons ?? [])])].sort(cmp),
    })),
    detectors: art.coverage.map((c) => ({ detector_id: c.detector_id, page_path: c.page, page_type: c.page_type, status: c.status, reason: c.reason })),
    withheld_findings: [
      ...agg.withheld.map((w) => ({ finding_key: w.finding_key, reason: w.reason, evidence_ids: w.evidence_ids })),
    ],
    withheld_positives: pos.withheld,
    pole_unmet: llm?.pole_unmet ?? [],
  };

  // ---------------------------------------------------------------- мета, банери, застереження
  const stage_status = { ...art.audit.stage_status };
  if (mode === "none") for (const s of LLM_STAGES) stage_status[s] = { status: "skipped", reason: "llm_mode=none (DEV-11)" };
  if (!stage_status.lighthouse) stage_status.lighthouse = lh.status === "not_run" ? { status: "skipped", reason: lh.reason ?? "not run" } : { status: lh.status === "failed" ? "failed" : "done", reason: lh.status === "failed" ? lh.reason ?? "failed" : null };
  stage_status.aggregate = { status: "done", reason: null };
  stage_status.report = { status: "done", reason: null };
  const banners: ReportT["audit"]["banners"] = [];
  if (mode === "none") banners.push({ code: "no_llm", stage: null, text: codeText("banner.no_llm", DISCLAIMER_TEXT.no_llm_mode, lang, "OBSERVED") });
  if (mode === "replay") banners.push({ code: "replay_not_live", stage: null, text: codeText("banner.replay_not_live", BANNER_TEXT.replay_not_live, lang, "OBSERVED") });
  if (opts.provenance?.kind === "example_fixture") banners.push({ code: "example_fixture", stage: null, text: codeText("banner.example_fixture", BANNER_TEXT.example_fixture, lang, "OBSERVED") });
  for (const st of Object.keys(stage_status).sort(cmp) as Array<keyof typeof stage_status>) {
    const s = stage_status[st];
    if (!s) continue;
    if (s.status === "budget_limited") banners.push({ code: "budget_limited", stage: st, text: codeText("banner.budget_limited", BANNER_TEXT.budget_limited, lang, "OBSERVED") });
    if (s.status === "failed") banners.push({ code: "stage_failed", stage: st, text: codeText("banner.stage_failed", BANNER_TEXT.stage_failed, lang, "OBSERVED") });
    if (s.status === "skipped" && !(LLM_STAGES as readonly string[]).includes(st)) banners.push({ code: "stage_skipped", stage: st, text: codeText("banner.stage_skipped", BANNER_TEXT.stage_skipped, lang, "OBSERVED") });
  }

  const lensesOut = llm && llm.lenses.length
    ? {
        disclaimer: "lenses_not_population_shares" as const,
        items: llm.lenses.map((l) => ({
          id: l.id,
          name: llmText(l.name, lang, null, new Set(), `lens:${l.id}:name`, rej, gs) ?? codeText("lens.name.fallback", { en: "Synthetic lens {id}", uk: "Синтетична лінза {id}" }, lang, "SYNTHETIC", { id: { ptr: `/lenses/items/${llm.lenses.indexOf(l)}/id`, format: "text" } }),
          description: llmText(l.description, lang, null, new Set(), `lens:${l.id}:description`, rej, gs) ?? codeText("lens.description.fallback", { en: "Description withheld by the numeric rule.", uk: "Опис утримано числовим правилом." }, lang, "SYNTHETIC"),
          poles: l.poles,
        })),
      }
    : null;
  const su = llm?.site_understanding;
  const SU = (t: LlmText, k: string) => llmText(t, lang, null, new Set(), `site_understanding:${k}`, rej, gs) ?? codeText("site_understanding.unknown", { en: "UNKNOWN", uk: "НЕВІДОМО" }, lang, "INFERRED");
  const siteUnderstanding = su
    ? {
        what_it_sells: SU(su.what_it_sells, "what_it_sells"), positioning: SU(su.positioning, "positioning"), price_positioning: SU(su.price_positioning, "price_positioning"),
        core_value_proposition: SU(su.core_value_proposition, "core_value_proposition"), primary_customer_journey: SU(su.primary_customer_journey, "primary_customer_journey"),
        likely_objections: su.likely_objections.map((o, i) => llmText(o, lang, null, new Set(), `site_understanding:objection:${i}`, rej, gs)).filter((x): x is TemplatedText => x !== null),
      }
    : null;

  const syntheticSessions = llm?.sessions ?? [];
  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    scoring_version: SCORING_VERSION,
    generated_at: opts.generated_at,
    provenance: opts.provenance ?? { kind: "audit" as const, note: null },
    audit: {
      id: art.audit.id, input_url: art.audit.input_url, normalized_url: art.audit.normalized_url, domain: art.audit.domain, language: lang,
      llm_mode: mode, llm_provider: llm?.provider ?? null, llm_model: llm?.model ?? null, prompt_versions: llm?.prompt_versions ?? [],
      status: art.audit.status, stage_status, created_at: art.audit.created_at, completed_at: art.audit.completed_at, snapshot_at: art.audit.snapshot_at, banners,
    },
    executive_summary: {
      primary_conversion_goal: llmText(llm?.primary_conversion_goal ?? undefined, lang, null, new Set(), "executive:primary_conversion_goal", rej, gs),
      top_problem_ids: findings.filter((f) => f.executive_eligible).slice(0, 5).map((f) => f.id),
      top_strength_ids: positives.slice(0, 5).map((p) => p.id),
      pages_inspected: art.pages.length,
      synthetic_snapshot_sessions: syntheticSessions.filter((s) => s.level === "snapshot").length,
      synthetic_journeys: syntheticSessions.filter((s) => s.level === "journey").length,
      technical_status: technical.status,
      summary: llmText(llm?.summary ?? undefined, lang, null, new Set(), "executive:summary", rej, gs),
    },
    site_understanding: siteUnderstanding,
    lenses: lensesOut,
    funnel: funnelSteps,
    findings,
    positive_findings: positives,
    technical,
    coverage: coverageOut,
    budget: {
      source_class: "OBSERVED" as const,
      max_audit_tokens: llm?.budget.max_audit_tokens ?? opts.max_audit_tokens ?? DEFAULT_MAX_AUDIT_TOKENS,
      used_tokens: llm?.budget.used_tokens ?? 0, billed_tokens: llm?.budget.billed_tokens ?? 0, cache_read_tokens: llm?.budget.cache_read_tokens ?? 0,
      llm_calls: llm?.budget.llm_calls ?? 0, cost: llm?.budget.cost ?? null,
    },
    evidence: evidenceOut,
    disclaimers: [] as ReportT["disclaimers"],
    guard: { applied: false, version: null as string | null, fields_checked: 0, events: rej.length, sentences_removed: 0 },
  };
  const d = new Set<ReportT["disclaimers"][number]>(["no_conversion_prediction"]);
  if (findings.length) d.add("priority_is_ranking_index");
  if (JSON.stringify(report).includes('"form":"n_of_m_synthetic"')) d.add("synthetic_single_model_correlated");
  if (lensesOut) d.add("lenses_not_population_shares");
  if (technical.accessibility.groups.length || findings.some((f) => f.category === "accessibility") || positives.some((p) => p.category === "accessibility")) d.add("automated_a11y_not_wcag_audit");
  if (mode === "none") d.add("no_llm_mode");
  report.disclaimers = [...d].sort(cmp);
  report.guard.events = rej.length;
  // guard звіту (SPEC §33, кр. 7): застосовано, якщо є LLM-тексти й це реальний аудит; сканер по всьому JSON — fail-closed
  if (gs.on) report.guard = { applied: true, version: GUARD_VERSION, fields_checked: gs.fields, events: rej.length, sentences_removed: gs.sentences_removed };

  const parsed = Report.safeParse(report);
  if (!parsed.success) throw new Error("buildReport: звіт не пройшов контракт:\n" + parsed.error.issues.slice(0, 20).map((i) => `${i.path.join("/")}: ${i.message}`).join("\n"));
  const scan = scanReport(parsed.data);
  if (!scan.clean) throw new Error("buildReport: сканер guard знайшов заборонені твердження у звіті:\n" + scan.violations.slice(0, 10).map((v) => `${v.ptr} [${v.kind}] ${v.rule_ids.join(",")}: ${v.sample}`).join("\n"));
  return { report: parsed.data, rejected: rej };
}
