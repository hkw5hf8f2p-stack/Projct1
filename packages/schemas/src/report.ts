/**
 * Контракт звіту SiteLens — SPEC §28 (+ §24–§27, §29, §33), рецензія C1–C4, G0-24, G0-25, DEV-11, DEV-49, DEV-58.
 * Власник контракту — sl-eval-science (S4, «день 1»); на ньому стартує UI S5.
 *
 * Zod v4 (`zod/v4` з того самого пакета zod 3.25.76) — щоб JSON Schema генерувалась штатно (`z.toJSONSchema`) і
 * збігалася з Zod за побудовою (`packages/schemas/report.schema.json`, тест дрейфу). Константи enum-ів — спільні з
 * v3-схемами (`enums.ts`), тож набори значень не розходяться (DEV-58).
 *
 * Що JSON Schema НЕ виражає і перевіряє лише Zod (`Report.superRefine`): посилання на докази, узгодженість пріоритету з
 * компонентами (перерахунок), ранги, структурне правило чисел у текстах (`report-text.ts`), обмеження режиму без LLM.
 *
 * Головні правила контракту:
 * - **Числа ставить код.** Кожен показаний текст — `TemplatedText`: шаблон без цифр (LLM-текст — ще й без числівників),
 *   числа — лише плейсхолдери на типізовані поля звіту. Жодного вільного числа в тексті моделі.
 * - **Клас доказу — на кожному твердженні й доказі** (C4): `TemplatedText.source_class`, `Evidence.source_class`.
 *   Знахідка має рівень впевненості (C3), а не клас.
 * - **Priority — індекс ранжування**, 0..100, з розкладом компонентів і перерозподілом ваг (DEV-4). Не uplift.
 * - **Синтетичні підрахунки** лише як `SyntheticCount` («N of M synthetic …») і завжди з застереженням G0-25.
 * - **Жодних «% confidence»**, жодної заяви про відповідність WCAG.
 */
import { z } from "zod/v4";
import {
  AUDIT_STAGES, AUDIT_STATUSES, ASSERTIONS, CATEGORIES, CONFIDENCES, EVIDENCE_FAMILIES, EVIDENCE_TIERS, EVIDENCE_TYPES,
  FUNNEL_STAGES, LEVELS, LLM_MODES, LLM_PROVIDERS, PAGE_TYPES, SOURCE_CLASSES, STAGE_STATUSES, UNKNOWN_REASONS, VP_CODES,
  isClaimKind,
} from "./enums.js";
import { collectTexts, numberViolations, placeholders, strayBraces, templatedTextProblems, type Lang } from "./report-text.js";

export const REPORT_SCHEMA_VERSION = "sitelens-report/v1" as const;

// ---------------------------------------------------------------- базові
const Unit = z.number().min(0).max(1);
const Ts = z.iso.datetime({ offset: true });
const EvidenceId = z.string().regex(/^ev_[0-9a-f]{12}$/);
const FindingId = z.string().regex(/^fnd_[0-9a-f]{12}$/);
const PositiveId = z.string().regex(/^pos_[0-9a-f]{12}$/);
export const ReportLang = z.enum(["uk", "en"]);
export const SourceClassR = z.enum(SOURCE_CLASSES);
export const CategoryR = z.enum(CATEGORIES);
export const FunnelStageR = z.enum(FUNNEL_STAGES);
export const ConfidenceR = z.enum(CONFIDENCES);

// ---------------------------------------------------------------- тексти (структурне правило чисел)
export const ParamFormat = z.enum(["int", "decimal", "text", "n_of_m", "priority"]);
export const TemplateParam = z
  .object({
    /** JSON Pointer (RFC 6901) від кореня звіту на типізоване поле; не всередину іншого тексту */
    ptr: z.string().regex(/^(\/[^/]*)+$/),
    format: ParamFormat,
  })
  .strict();

/** `pending` — guard звіту ще не запускався (лише provenance=example_fixture, див. reportProblems) */
export const GuardStatus = z.enum(["passed", "regenerated", "sentences_removed", "not_applicable", "pending"]);

/**
 * Текст звіту. `template` — без жодної цифри; `{name}` — плейсхолдер на `params.name`.
 * `origin: "llm"` — додатково без числівників словами й обов'язково з результатом guard.
 * `origin: "code"` — шаблон з каталогу коду (`template_id`), guard `not_applicable` допустимий.
 */
export const TemplatedText = z
  .object({
    template: z.string().min(1),
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), TemplateParam),
    origin: z.enum(["code", "llm"]),
    /** C4: клас твердження */
    source_class: SourceClassR,
    lang: ReportLang,
    /** id шаблону коду (`finding.title.cta.below_fold`) або промпту (`report-writer-v1`) */
    template_id: z.string().regex(/^[a-z0-9][a-z0-9_.:-]*$/),
    guard: z.object({ status: GuardStatus, attempts: z.number().int().min(0).max(2), rule_ids: z.array(z.string()) }).strict(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const bad = (message: string, path: string[]) => ctx.addIssue({ code: "custom", message, path });
    for (const v of numberViolations(t.template, t.origin === "llm")) bad(`структурне правило чисел: ${v.kind} «${v.span}» у шаблоні`, ["template"]);
    const ph = placeholders(t.template);
    const keys = Object.keys(t.params);
    for (const n of ph) if (!keys.includes(n)) bad(`плейсхолдер {${n}} без params`, ["params"]);
    for (const k of keys) if (!ph.includes(k)) bad(`params.${k} не використано`, ["params", k]);
    if (strayBraces(t.template)) bad("фігурні дужки поза плейсхолдером", ["template"]);
    if (t.origin === "llm" && t.guard.status === "not_applicable") bad("LLM-текст мусить пройти guard", ["guard", "status"]);
    if (t.origin === "code" && t.guard.status !== "not_applicable") bad("шаблон коду guard не проходить (not_applicable)", ["guard", "status"]);
    if (t.origin === "llm" && t.source_class !== "INFERRED" && t.source_class !== "SYNTHETIC") bad("LLM-текст — лише INFERRED або SYNTHETIC (C4)", ["source_class"]);
  })
  .meta({ id: "TemplatedText" });
export type TemplatedText = z.infer<typeof TemplatedText>;

/** «N of M synthetic …» (FEASIBILITY §4, G0-25): завжди з кодом застереження про одну модель і корельовані лінзи */
export const SyntheticCount = z
  .object({
    form: z.literal("n_of_m_synthetic"),
    n: z.number().int().min(0),
    m: z.number().int().min(1),
    unit: z.enum(["lenses", "sessions", "journeys", "tasks", "evaluations"]),
    disclaimer: z.literal("synthetic_single_model_correlated"),
  })
  .strict()
  .refine((c) => c.n <= c.m, { message: "n > m" })
  .meta({ id: "SyntheticCount" });
export type SyntheticCount = z.infer<typeof SyntheticCount>;

// ---------------------------------------------------------------- AuditRun-мета (DEV-11)
export const BannerCode = z.enum(["no_llm", "replay_not_live", "budget_limited", "stage_failed", "stage_skipped", "example_fixture", "quick_audit"]);
export const Banner = z
  .object({ code: BannerCode, stage: z.enum(AUDIT_STAGES).nullable(), text: TemplatedText })
  .strict();

export const StageStateR = z.object({ status: z.enum(STAGE_STATUSES), reason: z.string().min(1).nullable() }).strict();

export const AuditMeta = z
  .object({
    id: z.string().min(1),
    input_url: z.url(),
    normalized_url: z.url(),
    domain: z.string().min(1),
    /** мова звіту = мова сайту (DEV-6) */
    language: ReportLang,
    llm_mode: z.enum(LLM_MODES),
    llm_provider: z.enum(LLM_PROVIDERS).nullable(),
    llm_model: z.string().min(1).nullable(),
    prompt_versions: z.array(z.string().regex(/^[a-z][a-z0-9-]*-v\d+$/)),
    status: z.enum(AUDIT_STATUSES),
    stage_status: z.partialRecord(z.enum(AUDIT_STAGES), StageStateR),
    created_at: Ts.nullable(),
    completed_at: Ts.nullable(),
    snapshot_at: Ts.nullable(),
    /** DEV-93: лише для швидкого аудиту (повний — поле відсутнє, звіти не змінюються); потребує банера quick_audit */
    mode: z.literal("quick").optional(),
    banners: z.array(Banner),
  })
  .strict();

// ---------------------------------------------------------------- докази (§23, C4)
export const ReportEvidence = z
  .object({
    id: EvidenceId,
    type: z.enum(EVIDENCE_TYPES),
    source_class: SourceClassR,
    /** SCORING_SPEC §1.2; null = ET-SUP (опорний факт, не рівень сили) */
    tier: z.enum(EVIDENCE_TIERS).nullable(),
    /** проблема / позитив §29 / контрдоказ детектора (правило суперечності SCORING_SPEC §2) */
    polarity: z.enum(["problem", "positive", "counter"]),
    page_url: z.url(),
    page_path: z.string().min(1),
    page_type: z.enum(PAGE_TYPES).nullable(),
    viewport: z.enum(VP_CODES).nullable(),
    detector_id: z.string().min(1).nullable(),
    claim_kind: z.string().refine(isClaimKind, "unknown claim_kind").nullable(),
    assertion: z.enum(ASSERTIONS).nullable(),
    /** опис: текст детектора (код) або LLM-спостереження (тоді — структурне правило чисел) */
    description: TemplatedText,
    /** дослівний фрагмент сайту/інструмента; показується як цитата з міткою класу, guard не проходить (SCORING_SPEC §7.5) */
    excerpt: z.string().nullable(),
    artifact_reference: z.string().min(1),
    screenshot_reference: z.string().nullable(),
    selector: z.string().nullable(),
    region: z.object({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() }).strict().nullable(),
    capture_complete: z.boolean().nullable(),
    incomplete_reasons: z.array(z.string()),
    /** типізовані виміри детектора (px, байти, …) — джерело чисел для шаблонів */
    measurement: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
    // SYNTHETIC
    session_id: z.string().min(1).nullable(),
    lens_id: z.string().min(1).nullable(),
    task_id: z.string().min(1).nullable(),
    level: z.enum(LEVELS).nullable(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const bad = (message: string, path: string[]) => ctx.addIssue({ code: "custom", message, path });
    if (e.source_class === "SYNTHETIC" && (!e.session_id || !e.lens_id || !e.task_id || !e.level)) bad("SYNTHETIC потребує session/lens/task/level", ["session_id"]);
    if (e.description.source_class !== e.source_class) bad("клас опису ≠ клас доказу (C4)", ["description", "source_class"]);
    if ((e.source_class === "SYNTHETIC" || e.source_class === "INFERRED") && (e.tier === "ET-DET" || e.tier === "ET-INC")) bad("LLM-доказ не може мати ET-DET/ET-INC", ["tier"]);
    if (e.tier === "ET-DET" && e.capture_complete === false) bad("ET-DET при неповному захопленні (DEV-17)", ["tier"]);
    if (e.tier === "ET-INC" && e.capture_complete !== false) bad("ET-INC лише при capture_complete=false (DEV-19)", ["tier"]);
  })
  .meta({ id: "Evidence" });
export type ReportEvidence = z.infer<typeof ReportEvidence>;

// ---------------------------------------------------------------- пріоритет (§25, C1, DEV-4)
export const PRIORITY_COMPONENTS = ["severity", "funnel_proximity", "lens_coverage", "session_frequency", "evidence_strength"] as const;
/** SCORING_SPEC §6.1 — базові ваги (єдине джерело; packages/scoring реекспортує) */
export const PRIORITY_BASE_WEIGHTS = { severity: 0.3, funnel_proximity: 0.2, lens_coverage: 0.2, session_frequency: 0.15, evidence_strength: 0.15 } as const;
export const ALWAYS_APPLICABLE = ["severity", "funnel_proximity", "evidence_strength"] as const;
export const PRIORITY_EPS = 1e-9;
/** SCORING_SPEC §6.3 */
export const roundHalfUp = (x: number): number => Math.floor(x + 0.5 + PRIORITY_EPS);
/**
 * SCORING_SPEC §6.5, DEV-76 (scoring-v2): смуга ранжування — перший ключ порядку звіту. VERIFIED (перевірений кодом факт) = 1,
 * STRONG_HYPOTHESIS і HYPOTHESIS = 0. Priority порівнюється лише всередині смуги.
 */
export const RANK_BAND = { VERIFIED: 1, STRONG_HYPOTHESIS: 0, HYPOTHESIS: 0 } as const;
/** з якої версії скорингу порядок звіту — «смуга, потім priority» (раніше — лише priority desc) */
export const scoringMajor = (v: string): number => Number(/^scoring-v(\d+)$/.exec(v)?.[1] ?? 0);

export const PriorityComponent = z
  .object({
    name: z.enum(PRIORITY_COMPONENTS),
    base_weight: z.number().positive(),
    applicable: z.boolean(),
    value: Unit.nullable(),
    effective_weight: z.number().min(0).max(1),
    /** чому N/A: VERIFIED — синтетичне покриття не входить в оцінку (SCORING_SPEC §4.3) */
    na_reason: z.enum(["verified_synthetic_not_scored"]).nullable(),
  })
  .strict();

export const Priority = z
  .object({
    /** «Priority NN/100» — індекс ранжування, не прогноз ефекту */
    value: z.number().int().min(0).max(100),
    /** індекс до кепу асиметрії (DEV-60); value = min(uncapped, cap.value) */
    uncapped: z.number().int().min(0).max(100),
    cap: z.object({ rule: z.literal("CAP-HYP-VERIFIED-EQUIV"), value: z.number().int().min(0).max(100) }).strict().nullable(),
    formula: z.literal("scoring-v1/redistributed"),
    components: z.array(PriorityComponent).length(5),
  })
  .strict()
  .superRefine((p, ctx) => {
    const bad = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: "custom", message, path });
    const names = p.components.map((c) => c.name);
    if (names.join() !== PRIORITY_COMPONENTS.join()) bad("компоненти не в каноні", ["components"]);
    let sw = 0;
    p.components.forEach((c, i) => {
      if (Math.abs(c.base_weight - PRIORITY_BASE_WEIGHTS[c.name]) > PRIORITY_EPS) bad(`base_weight ${c.name} ≠ SCORING_SPEC`, ["components", i, "base_weight"]);
      if ((ALWAYS_APPLICABLE as readonly string[]).includes(c.name) && !c.applicable) bad(`${c.name} завжди застосовний`, ["components", i]);
      if (c.applicable !== (c.value !== null)) bad("value null ⇔ N/A", ["components", i, "value"]);
      if (c.applicable && c.na_reason !== null) bad("na_reason лише для N/A", ["components", i]);
      if (!c.applicable && c.effective_weight !== 0) bad("N/A ⇒ effective_weight 0", ["components", i]);
      if (c.applicable) sw += c.base_weight;
    });
    if (sw < 0.65 - PRIORITY_EPS) bad("Σ застосовних ваг < 0.65 (інваріант 6.2.1)");
    let score = 0;
    p.components.forEach((c, i) => {
      if (!c.applicable) return;
      if (Math.abs(c.effective_weight - c.base_weight / sw) > 1e-6) bad(`effective_weight ${c.name} ≠ перерозподіл`, ["components", i]);
      score += (c.base_weight / sw) * (c.value as number);
    });
    if (roundHalfUp(100 * score) !== p.uncapped) bad(`uncapped ${p.uncapped} ≠ перерахунок ${roundHalfUp(100 * score)}`, ["uncapped"]);
    if (p.cap) {
      const sev = p.components[0]?.value ?? 0, fun = p.components[1]?.value ?? 0;
      const W = PRIORITY_BASE_WEIGHTS;
      const want = roundHalfUp((100 * (W.severity * sev + W.funnel_proximity * fun + W.evidence_strength)) / (W.severity + W.funnel_proximity + W.evidence_strength));
      if (p.cap.value !== want) bad(`cap ${p.cap.value} ≠ перерахунок ${want}`, ["cap"]);
    }
    const final = p.cap ? Math.min(p.uncapped, p.cap.value) : p.uncapped;
    if (final !== p.value) bad(`priority ${p.value} ≠ ${final}`, ["value"]);
  });
export type Priority = z.infer<typeof Priority>;

// ---------------------------------------------------------------- знахідка (§24, §25, §27, §28)
export const ReportPage = z.object({ url: z.url(), path: z.string().min(1), page_type: z.enum(PAGE_TYPES) }).strict().meta({ id: "ReportPage" });

export const ConfidenceRuleId = z.enum([
  "C3-VERIFIED-DET", "C3-VERIFIED-BRW-REPLAY", "C3-HYP-INC-CAP", "C3-STRONG-A", "C3-STRONG-B", "C3-HYP-CONTRADICTION", "C3-HYP-DEFAULT",
]);
export const FindingConfidence = z
  .object({
    level: ConfidenceR,
    rule: ConfidenceRuleId,
    families: z.array(z.enum(EVIDENCE_FAMILIES)).min(1),
    contradiction: z.object({ detector_id: z.string().min(1), counter_evidence_ids: z.array(EvidenceId).min(1) }).strict().nullable(),
  })
  .strict();

export const SeverityBreakdown = z
  .object({
    value: Unit,
    base: Unit,
    base_source: z.enum(["category", "axe_impact", "lighthouse", "network"]),
    modifiers: z.array(z.object({ id: z.enum(["MOD-PAGE-PRIMARY", "MOD-PAGE-SECONDARY", "MOD-PAGE-PERIPHERAL", "MOD-BLOCKER"]), delta: z.number() }).strict()),
  })
  .strict();

export const ReportFinding = z
  .object({
    id: FindingId,
    /** DEV-38: category|page_group|claim_kind[|component] */
    finding_key: z.string().min(1),
    category: CategoryR,
    page_group: z.string().min(1),
    claim_kind: z.string().refine(isClaimKind, "unknown claim_kind"),
    component: z.string().min(1).nullable(),
    rank: z.number().int().min(1),
    pages: z.array(ReportPage).min(1),
    /** = pages.length; типізоване поле для шаблонів («Сторінок: {page_count}») */
    page_count: z.number().int().min(1),
    // ---- тексти картки (§28): кожен — твердження з класом
    title: TemplatedText,
    problem: TemplatedText,
    why_it_matters: TemplatedText.nullable(),
    /** §25/§30: рекомендація існує лише всередині знахідки з доказом */
    recommendation: z.object({ recommended_change: TemplatedText, how_to_validate: TemplatedText }).strict().nullable(),
    // ---- числа (ставить код)
    confidence: FindingConfidence,
    severity: SeverityBreakdown,
    funnel: z.object({ stage: FunnelStageR, value: Unit, stage_source: z.enum(["category", "page_type"]) }).strict(),
    evidence_strength: z.object({ value: z.union([z.literal(1), z.literal(0.9), z.literal(0.7), z.literal(0.4), z.literal(0.3)]), tier: z.enum(EVIDENCE_TIERS) }).strict(),
    synthetic: z
      .object({
        lens_coverage: SyntheticCount.nullable(),
        session_frequency: SyntheticCount.nullable(),
        /** лише показ і фільтри; у priority не входить (SCORING_SPEC §4.3) */
        task_coverage: SyntheticCount.nullable(),
        /** false для VERIFIED (N/A) */
        in_priority: z.boolean(),
      })
      .strict(),
    priority: Priority,
    evidence_ids: z.array(EvidenceId).min(1),
    instances: z.number().int().positive(),
    affected_task_ids: z.array(z.string().min(1)),
    affected_lens_ids: z.array(z.string().min(1)),
    /** false → не в топ-5 executive summary (правило суперечності) */
    executive_eligible: z.boolean(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const bad = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const comp = Object.fromEntries(f.priority.components.map((c) => [c.name, c]));
    const eq = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) < 1e-9;
    if (!eq(comp["severity"]?.value, f.severity.value)) bad("priority.severity ≠ severity.value", ["priority"]);
    if (!eq(comp["funnel_proximity"]?.value, f.funnel.value)) bad("priority.funnel ≠ funnel.value", ["priority"]);
    if (!eq(comp["evidence_strength"]?.value, f.evidence_strength.value)) bad("priority.evidence ≠ evidence_strength", ["priority"]);
    const verified = f.confidence.level === "VERIFIED";
    if (verified === f.synthetic.in_priority) bad("VERIFIED ⇔ синтетичне покриття не в priority (SCORING_SPEC §4.3)", ["synthetic", "in_priority"]);
    for (const n of ["lens_coverage", "session_frequency"] as const) {
      const c = comp[n];
      if (!c) continue;
      if (verified && c.applicable) bad(`${n} має бути N/A для VERIFIED`, ["priority"]);
      if (!verified) {
        const sc = f.synthetic[n];
        const want = sc ? sc.n / sc.m : 0; // S_exp = ∅ → 0 (SCORING_SPEC §4.3)
        if (!eq(c.value, want)) bad(`${n}: priority ≠ N/M`, ["priority"]);
      }
    }
    if ((f.confidence.level === "HYPOTHESIS") !== (f.priority.cap !== null)) bad("кеп асиметрії ⇔ HYPOTHESIS (DEV-60)", ["priority", "cap"]);
    if (f.confidence.contradiction && f.executive_eligible) bad("знахідка із суперечністю не йде в executive summary", ["executive_eligible"]);
    if (f.confidence.contradiction && f.confidence.level !== "HYPOTHESIS") bad("суперечність ⇒ HYPOTHESIS", ["confidence"]);
    if (new Set(f.evidence_ids).size !== f.evidence_ids.length) bad("дублікати evidence_ids", ["evidence_ids"]);
    if (f.page_count !== f.pages.length) bad("page_count ≠ pages.length", ["page_count"]);
  })
  .meta({ id: "Finding" });
export type ReportFinding = z.infer<typeof ReportFinding>;

// ---------------------------------------------------------------- позитивні знахідки (§29)
export const PositiveFinding = z
  .object({
    id: PositiveId,
    /** напр. `price_in_first_viewport|product` */
    key: z.string().min(1),
    category: CategoryR,
    page_group: z.string().min(1),
    basis: z.enum(["detector", "llm"]),
    confidence: ConfidenceR,
    title: TemplatedText,
    detail: TemplatedText.nullable(),
    pages: z.array(ReportPage).min(1),
    evidence_ids: z.array(EvidenceId).min(1),
  })
  .strict();
export type PositiveFinding = z.infer<typeof PositiveFinding>;

// ---------------------------------------------------------------- решта розділів §28
export const Lens = z
  .object({
    id: z.string().min(1),
    name: TemplatedText,
    description: TemplatedText,
    /** полюси SCORING_SPEC §9.3, які лінза закриває */
    poles: z.array(z.enum(["P1", "P2", "P3", "P4", "P5", "P6", "P7"])),
  })
  .strict();

export const SiteUnderstanding = z
  .object({
    what_it_sells: TemplatedText,
    positioning: TemplatedText,
    price_positioning: TemplatedText,
    core_value_proposition: TemplatedText,
    primary_customer_journey: TemplatedText,
    likely_objections: z.array(TemplatedText),
  })
  .strict();

export const FunnelStep = z.object({ stage: FunnelStageR, finding_ids: z.array(FindingId), positive_ids: z.array(PositiveId) }).strict();

export const TechnicalStatus = z.enum(["ok", "partial", "failed"]);
export const LighthouseRun = z
  .object({
    page_url: z.url(),
    form_factor: z.enum(["mobile", "desktop"]),
    status: z.enum(["done", "failed"]),
    /** категорії Lighthouse 0..100 (A2: «score NN/100» — оцінка інструмента, не популяція) */
    scores: z.object({ performance: z.number().int().min(0).max(100).nullable(), accessibility: z.number().int().min(0).max(100).nullable(), best_practices: z.number().int().min(0).max(100).nullable(), seo: z.number().int().min(0).max(100).nullable() }).strict(),
    metrics: z.object({ lcp_ms: z.number().nonnegative().nullable(), tbt_ms: z.number().nonnegative().nullable(), cls: z.number().nonnegative().nullable(), fcp_ms: z.number().nonnegative().nullable() }).strict(),
    evidence_id: EvidenceId.nullable(),
  })
  .strict();
export const AxeGroup = z
  .object({
    rule: z.string().min(1),
    impact: z.enum(["critical", "serious", "moderate", "minor"]).nullable(),
    page_group: z.string().min(1),
    component: z.string().min(1).nullable(),
    instances: z.number().int().positive(),
    pages: z.array(z.string().min(1)).min(1),
    viewports: z.array(z.enum(VP_CODES)),
    finding_id: FindingId.nullable(),
  })
  .strict();

export const Technical = z
  .object({
    status: TechnicalStatus,
    lighthouse: z.object({ status: z.enum(["done", "partial", "not_run", "failed"]), reason: z.string().nullable(), runs: z.array(LighthouseRun) }).strict(),
    accessibility: z.object({ engine: z.literal("axe-core"), version: z.string().nullable(), groups: z.array(AxeGroup), disclaimer: z.literal("automated_a11y_not_wcag_audit") }).strict(),
  })
  .strict();

export const CoverageDetectorRow = z
  .object({ detector_id: z.string().min(1), page_path: z.string().min(1), page_type: z.enum(PAGE_TYPES), status: z.enum(["not_applicable", "withheld", "capped"]), reason: z.string().min(1) })
  .strict();
export const WithheldReason = z.enum(["sup_only", "no_strength_evidence", "guard_dropped", "no_evidence"]);
export const Coverage = z
  .object({
    pages: z.array(
      z
        .object({
          url: z.url(), path: z.string().min(1), page_type: z.enum(PAGE_TYPES), page_type_reason: z.enum(UNKNOWN_REASONS).nullable(),
          capture_complete: z.object({ D: z.boolean().nullable(), M: z.boolean().nullable() }).strict(),
          incomplete_reasons: z.array(z.string()),
        })
        .strict(),
    ),
    detectors: z.array(CoverageDetectorRow),
    /** кандидати, що не стали знахідками (§23: без доказу сили) — видно, а не мовчки */
    withheld_findings: z.array(z.object({ finding_key: z.string().min(1), reason: WithheldReason, evidence_ids: z.array(EvidenceId) }).strict()),
    withheld_positives: z.array(z.object({ key: z.string().min(1), reason: z.string().min(1) }).strict()),
    /** DEV-49: полюс без кандидата — прапорець, видимий у звіті */
    pole_unmet: z.array(z.object({ pole: z.enum(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]), nearest_lens_id: z.string().min(1).nullable() }).strict()),
  })
  .strict();

/** E4/G0-24: токени — OBSERVED; $ лише з датою прайсу */
export const Budget = z
  .object({
    source_class: z.literal("OBSERVED"),
    max_audit_tokens: z.number().int().positive(),
    used_tokens: z.number().int().nonnegative(),
    billed_tokens: z.number().int().nonnegative(),
    cache_read_tokens: z.number().int().nonnegative(),
    llm_calls: z.number().int().nonnegative(),
    cost: z.object({ amount: z.number().nonnegative(), currency: z.literal("USD"), price_date: z.iso.date(), price_source: z.string().min(1) }).strict().nullable(),
  })
  .strict();

export const DisclaimerCode = z.enum([
  "priority_is_ranking_index", "synthetic_single_model_correlated", "lenses_not_population_shares", "automated_a11y_not_wcag_audit",
  "no_conversion_prediction", "no_llm_mode",
]);

export const ExecutiveSummary = z
  .object({
    primary_conversion_goal: TemplatedText.nullable(),
    top_problem_ids: z.array(FindingId).max(5),
    top_strength_ids: z.array(PositiveId).max(5),
    pages_inspected: z.number().int().nonnegative(),
    synthetic_snapshot_sessions: z.number().int().nonnegative(),
    synthetic_journeys: z.number().int().nonnegative(),
    technical_status: TechnicalStatus,
    summary: TemplatedText.nullable(),
  })
  .strict();

// ---------------------------------------------------------------- корінь
export const ReportObject = z
  .object({
    schema_version: z.literal(REPORT_SCHEMA_VERSION),
    scoring_version: z.string().regex(/^scoring-v\d+$/),
    generated_at: Ts,
    /** `example_fixture` — приклад для UI (S5), не результат аудиту */
    provenance: z.object({ kind: z.enum(["audit", "example_fixture"]), note: z.string().nullable() }).strict(),
    audit: AuditMeta,
    executive_summary: ExecutiveSummary,
    site_understanding: SiteUnderstanding.nullable(),
    lenses: z.object({ disclaimer: z.literal("lenses_not_population_shares"), items: z.array(Lens) }).strict().nullable(),
    funnel: z.array(FunnelStep).length(FUNNEL_STAGES.length),
    findings: z.array(ReportFinding),
    positive_findings: z.array(PositiveFinding),
    technical: Technical,
    coverage: Coverage,
    budget: Budget,
    evidence: z.array(ReportEvidence),
    disclaimers: z.array(DisclaimerCode),
    guard: z.object({ applied: z.boolean(), version: z.string().nullable(), fields_checked: z.number().int().nonnegative(), events: z.number().int().nonnegative(), sentences_removed: z.number().int().nonnegative() }).strict(),
  })
  .strict()
  .meta({ title: "SiteLens report (SPEC §28)", description: "Cross-field invariants (evidence refs, priority recomputation, numeric-text rule, no-LLM mode) are enforced by the Zod schema in packages/schemas/src/report.ts, not by this JSON Schema." });

/** крос-польові інваріанти (Zod-лише) */
export function reportProblems(r: z.infer<typeof ReportObject>): Array<{ path: (string | number)[]; message: string }> {
  const out: Array<{ path: (string | number)[]; message: string }> = [];
  const bad = (message: string, path: (string | number)[] = []) => out.push({ message, path });
  const ev = new Map(r.evidence.map((e) => [e.id, e]));
  if (ev.size !== r.evidence.length) bad("дублікати id доказів", ["evidence"]);
  const lang = r.audit.language as Lang;

  // 1. докази: кожне посилання існує; знахідка має ≥ 1 доказ із рівнем сили (§23)
  r.findings.forEach((f, i) => {
    for (const id of f.evidence_ids) if (!ev.has(id)) bad(`evidence ${id} не існує`, ["findings", i, "evidence_ids"]);
    const tiers = f.evidence_ids.map((id) => ev.get(id)?.tier).filter((t) => t !== undefined && t !== null);
    if (tiers.length === 0) bad("знахідка без доказу з рівнем сили (§23)", ["findings", i]);
    if (f.evidence_ids.some((id) => ev.get(id)?.polarity === "positive")) bad("позитивний доказ у проблемній знахідці", ["findings", i]);
    for (const id of f.confidence.contradiction?.counter_evidence_ids ?? []) if (ev.get(id)?.polarity !== "counter") bad(`контрдоказ ${id} не counter`, ["findings", i]);
  });
  r.positive_findings.forEach((p, i) => {
    for (const id of p.evidence_ids) if (ev.get(id)?.polarity !== "positive") bad(`позитив ${p.key}: доказ ${id} відсутній або не positive`, ["positive_findings", i]);
  });
  // 2. ранги 1..n; scoring-v2+ (DEV-76): смуга VERIFIED перед гіпотезами, у смузі priority не зростає; scoring-v1: лише priority desc
  const banded = scoringMajor(r.scoring_version) >= 2;
  r.findings.forEach((f, i) => {
    if (f.rank !== i + 1) bad("rank ≠ позиція", ["findings", i, "rank"]);
    if (i === 0) return;
    const prev = r.findings[i - 1] as { priority: { value: number }; confidence: { level: keyof typeof RANK_BAND } };
    const bPrev = banded ? RANK_BAND[prev.confidence.level] : 0, bCur = banded ? RANK_BAND[f.confidence.level] : 0;
    if (bPrev < bCur) bad("порядок: гіпотеза вище перевіреного факту (смуга VERIFIED перша, DEV-76)", ["findings", i]);
    else if (bPrev === bCur && prev.priority.value < f.priority.value) bad("порядок не за priority desc у межах смуги", ["findings", i]);
  });
  const ids = new Set(r.findings.map((f) => f.id));
  const keys = new Set(r.findings.map((f) => f.finding_key));
  if (ids.size !== r.findings.length || keys.size !== r.findings.length) bad("дублікати finding id/key", ["findings"]);
  const pos = new Set(r.positive_findings.map((p) => p.id));
  // 3. executive summary = перші ≤ 5 eligible
  const top = r.findings.filter((f) => f.executive_eligible).slice(0, 5).map((f) => f.id);
  if (top.join() !== r.executive_summary.top_problem_ids.join()) bad("top_problem_ids ≠ перші 5 eligible за рангом", ["executive_summary", "top_problem_ids"]);
  for (const id of r.executive_summary.top_strength_ids) if (!pos.has(id)) bad(`strength ${id} не існує`, ["executive_summary"]);
  // 4. воронка: канонічний порядок, посилання існують, кожна знахідка на своєму етапі
  r.funnel.forEach((s, i) => {
    if (s.stage !== FUNNEL_STAGES[i]) bad("етапи воронки не в каноні", ["funnel", i]);
    for (const id of s.finding_ids) if (!ids.has(id)) bad(`funnel: ${id} не існує`, ["funnel", i]);
    for (const id of s.positive_ids) if (!pos.has(id)) bad(`funnel: ${id} не існує`, ["funnel", i]);
  });
  for (const f of r.findings) {
    const st = r.funnel.find((s) => s.stage === f.funnel.stage);
    if (!st?.finding_ids.includes(f.id)) bad(`знахідка ${f.id} не на етапі ${f.funnel.stage}`, ["funnel"]);
  }
  // 5. тексти: структурне правило чисел + вказівники резолвляться + мова
  for (const { ptr, text } of collectTexts(r)) {
    for (const p of templatedTextProblems(text, r, lang)) bad(`${ptr}: ${p}`, ["text", ptr]);
    if ((text as unknown as { lang: string }).lang !== lang) bad(`${ptr}: мова тексту ≠ мова звіту`, ["text", ptr]);
  }
  // 6. застереження
  const d = new Set(r.disclaimers);
  const hasSyn = JSON.stringify(r).includes('"form":"n_of_m_synthetic"');
  if (hasSyn && !d.has("synthetic_single_model_correlated")) bad("є «N of M synthetic», але немає застереження G0-25", ["disclaimers"]);
  if (r.findings.length > 0 && !d.has("priority_is_ranking_index")) bad("є пріоритети, але немає застереження «індекс ранжування»", ["disclaimers"]);
  if (!d.has("no_conversion_prediction")) bad("немає застереження «без прогнозу конверсії»", ["disclaimers"]);
  const a11y = r.technical.accessibility.groups.length > 0 || r.findings.some((f) => f.category === "accessibility");
  if (a11y && !d.has("automated_a11y_not_wcag_audit")) bad("є a11y-результати, але немає застереження «не аудит WCAG»", ["disclaimers"]);
  if (r.lenses && !d.has("lenses_not_population_shares")) bad("лінзи без застереження", ["disclaimers"]);
  // 7. режим LLM (DEV-11)
  const banners = new Set(r.audit.banners.map((b) => b.code));
  if (r.audit.llm_mode === "none") {
    if (!banners.has("no_llm") || !d.has("no_llm_mode")) bad("llm_mode=none потребує банера no_llm і застереження", ["audit", "banners"]);
    if (r.site_understanding !== null || r.lenses !== null) bad("llm_mode=none: LLM-розділи мають бути null", ["site_understanding"]);
    if (r.evidence.some((e) => e.source_class === "SYNTHETIC" || e.source_class === "INFERRED")) bad("llm_mode=none: SYNTHETIC/INFERRED доказів бути не може", ["evidence"]);
    if (collectTexts(r).some((t) => t.text.origin === "llm")) bad("llm_mode=none: LLM-текстів бути не може", ["findings"]);
    if (r.budget.used_tokens !== 0 || r.budget.llm_calls !== 0) bad("llm_mode=none: токенів/викликів бути не може", ["budget"]);
    if (r.executive_summary.synthetic_journeys !== 0 || r.executive_summary.synthetic_snapshot_sessions !== 0) bad("llm_mode=none: синтетичних сесій бути не може", ["executive_summary"]);
  }
  if (r.audit.mode === "quick" && !banners.has("quick_audit")) bad("mode=quick потребує банера quick_audit", ["audit", "banners"]);
  if (r.audit.llm_mode === "replay" && !banners.has("replay_not_live")) bad("llm_mode=replay потребує банера replay_not_live", ["audit", "banners"]);
  if (r.provenance.kind === "example_fixture" && !banners.has("example_fixture")) bad("приклад потребує банера example_fixture", ["audit", "banners"]);
  for (const [st, s] of Object.entries(r.audit.stage_status)) {
    if (s?.status === "budget_limited" && !r.audit.banners.some((b) => b.code === "budget_limited" && b.stage === st)) bad(`етап ${st} budget_limited без банера`, ["audit", "banners"]);
    if (s?.status === "failed" && !r.audit.banners.some((b) => b.code === "stage_failed" && b.stage === st)) bad(`етап ${st} failed без банера`, ["audit", "banners"]);
  }
  // guard: LLM-тексти в реальному аудиті мусять пройти guard; `pending` — лише в прикладі
  const llmTexts = collectTexts(r).filter((t) => t.text.origin === "llm").map((t) => (t.text as unknown as { guard: { status: string } }).guard.status);
  if (r.provenance.kind === "audit" && llmTexts.length > 0 && !r.guard.applied) bad("аудит із LLM-текстами без guard", ["guard"]);
  if (r.guard.applied && llmTexts.includes("pending")) bad("guard.applied, але є тексти pending", ["guard"]);
  if (!r.guard.applied && llmTexts.some((s) => s !== "pending")) bad("guard не запускався, а тексти мають його статус", ["guard"]);
  if (r.budget.cost && r.budget.cost.price_date.length === 0) bad("$ без дати прайсу (G0-24)", ["budget", "cost"]);
  return out;
}

export const Report = ReportObject.superRefine((r, ctx) => {
  for (const p of reportProblems(r)) ctx.addIssue({ code: "custom", message: p.message, path: p.path.map(String) });
});
export type Report = z.infer<typeof ReportObject>;

/** JSON Schema контракту (draft 2020-12); лише структура — інваріанти див. `reportProblems` */
export function reportJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(ReportObject, { target: "draft-2020-12", unrepresentable: "any", io: "output" }) as Record<string, unknown>;
  // `.meta({ id })` лишає ключ `id` у $defs — у draft 2020-12 це не ключове слово (ajv strict відхиляє); ім'я вже є ключем $defs
  for (const d of Object.values((s["$defs"] ?? {}) as Record<string, Record<string, unknown>>)) delete d["id"];
  return s;
}

// ---------------------------------------------------------------- тексти застережень (код, не LLM)
export const DISCLAIMER_TEXT: Record<z.infer<typeof DisclaimerCode>, Record<Lang, string>> = {
  priority_is_ranking_index: {
    en: "Priority is a ranking index for ordering fixes. It is not a predicted effect on conversion or revenue.",
    uk: "Пріоритет — індекс для впорядкування виправлень. Це не прогноз впливу на конверсію чи виручку.",
  },
  synthetic_single_model_correlated: {
    en: "Synthetic counts come from one AI model viewed through different lenses. The lenses are correlated, so agreement between them is one signal, not independent votes, and not a share of real people.",
    uk: "Синтетичні підрахунки походять від однієї AI-моделі з різними лінзами. Лінзи корельовані, тож їхня згода — один сигнал, а не незалежні голоси й не частка реальних людей.",
  },
  lenses_not_population_shares: {
    en: "These lenses are synthetic testing perspectives, not measured population shares.",
    uk: "Лінзи — синтетичні перспективи для тестування, а не виміряні частки аудиторії.",
  },
  automated_a11y_not_wcag_audit: {
    en: "Automated accessibility testing is not a complete WCAG compliance audit.",
    uk: "Автоматична перевірка доступності не є повним аудитом відповідності WCAG.",
  },
  no_conversion_prediction: {
    en: "The report does not predict conversion changes. Validate each change with an experiment.",
    uk: "Звіт не прогнозує зміну конверсії. Перевіряйте кожну зміну експериментом.",
  },
  no_llm_mode: {
    en: "Synthetic analysis was not run: no LLM provider is configured. Only deterministic findings are shown.",
    uk: "Синтетичний аналіз не виконувався: LLM-провайдер не налаштовано. Нижче лише детерміновані знахідки.",
  },
};
