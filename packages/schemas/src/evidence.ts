/**
 * Evidence — JSON-контракт доказів (SPEC §23 + SCORING_SPEC §1 + DEV-17/19).
 * Форма збігається з фактичним виходом S1a (`EvidenceRow`, packages/browser/src/audit/types.ts).
 * S3 (LLM) додає SYNTHETIC/INFERRED-докази з `session_id/lens_id/task_id/level`; `self_confirming` у LLM-схемах немає
 * і ніколи не парситься з виводу моделі.
 */
import { z } from "zod";
import {
  Assertion, Category, ClaimKind, EvidenceTier, EvidenceType, Level, PageType, SourceClass, UnknownReason, VpCode,
  ABSENCE_CLAIM_KINDS, BROWSER_FAILURE_KINDS, POSITIONAL_CLAIM_KINDS, isClaimKindFor,
} from "./enums.js";

/** прямокутник у CSS px (S1a: x,y,w,h) */
export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() }).strict();

export const SelectorOrRegion = z
  .object({
    selector: z.string().min(1).optional(),
    region: Rect.nullable().optional(),
    dpr: z.number().positive().optional(),
    coord: z.enum(["css_px_document", "css_px_viewport"]).optional(),
  })
  .strict()
  .refine((v) => v.selector !== undefined || (v.region !== undefined && v.region !== null), {
    message: "selector_or_region: потрібен selector або region",
  });

export const BannerAction = z
  .object({
    step: z.enum(["reject", "close", "accept"]),
    label: z.string(),
    clicked: z.boolean(),
    method: z.enum(["click", "dispatch", "none"]),
    hidden_after: z.boolean(),
  })
  .strict();

/** контекст повноти захоплення (G0-10, DEV-5, DEV-17) */
export const CaptureContext = z
  .object({
    banner_state: z.enum(["none", "closed", "open"]),
    banner_actions: z.array(BannerAction),
    blocked_requests_count: z.number().int().nonnegative(),
    js_error_count: z.number().int().nonnegative(),
    scroll_completed: z.boolean(),
    layout_stable: z.boolean(),
    http_status: z.number().int().nullable(),
  })
  .strict();

export const BrowserFailure = z
  .object({
    kind: z.enum(BROWSER_FAILURE_KINDS),
    selector: z.string().optional(),
    reproduced_by_replay: z.boolean(),
  })
  .strict();

const EvidenceObject = z
  .object({
    id: z.string().regex(/^ev_[0-9a-f]{12}$/),
    type: EvidenceType,
    source_class: SourceClass,
    page_url: z.string().url(),
    description: z.string().min(1),
    /** шлях відносно каталогу прогону; існування файлу перевіряє не схема, а тест артефактів */
    artifact_reference: z.string().min(1),
    selector_or_region: SelectorOrRegion,
    /** ставить ЛИШЕ код детектора (SCORING_SPEC §1.1) */
    self_confirming: z.boolean(),

    // ---- детермінований шлях (OBSERVED / BENCHMARKED)
    page_path: z.string().optional(),
    page_id: z.string().optional(),
    page_type: PageType.optional(),
    page_type_reason: UnknownReason.nullable().optional(),
    page_group: z.string().min(1).optional(),
    category: Category.optional(),
    screenshot_reference: z.string().optional(),
    excerpt: z.string().optional(),
    detector_id: z.string().min(1).optional(),
    claim_kind: ClaimKind.optional(),
    assertion: Assertion.optional(),
    viewport: VpCode.optional(),
    measurement: z.record(z.unknown()).optional(),
    capture_complete: z.boolean().optional(),
    incomplete_reasons: z.array(z.string().min(1)).optional(),
    capture_context: CaptureContext.optional(),
    /** необов'язково: похідний рівень сили (SCORING_SPEC §1.2); рахує scoring, не детектор */
    evidence_tier: EvidenceTier.optional(),

    // ---- SYNTHETIC / браузерні збої (S3/S5)
    session_id: z.string().min(1).optional(),
    lens_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    level: Level.optional(),
    browser_failure: BrowserFailure.optional(),
  })
  .strict();

export const Evidence = EvidenceObject.superRefine((e, ctx) => {
  const bad = (message: string, path: string[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const det = e.source_class === "OBSERVED" || e.source_class === "BENCHMARKED";

  if (det && !e.browser_failure) {
    for (const k of ["detector_id", "claim_kind", "assertion", "viewport", "capture_complete", "capture_context", "category"] as const) {
      if (e[k] === undefined) bad(`${e.source_class} доказ без browser_failure потребує поля ${k}`, [k]);
    }
  }
  if (e.source_class === "SYNTHETIC") {
    for (const k of ["session_id", "lens_id", "task_id", "level"] as const) {
      if (e[k] === undefined) bad(`SYNTHETIC доказ потребує ${k}`, [k]);
    }
    if (e.self_confirming) bad("SYNTHETIC не може бути self_confirming (SCORING_SPEC §1.1)", ["self_confirming"]);
  }
  if (e.source_class === "INFERRED" && e.self_confirming) bad("INFERRED не може бути self_confirming", ["self_confirming"]);

  // capture_complete=false ⇒ причини; і доказ не може бути self_confirming (DEV-17/19 → ET-INC)
  if (e.capture_complete === false) {
    if (!e.incomplete_reasons || e.incomplete_reasons.length === 0) bad("capture_complete=false потребує incomplete_reasons[]", ["incomplete_reasons"]);
    if (e.assertion === "absence" && e.self_confirming) {
      bad("твердження відсутності при capture_complete=false не може бути self_confirming (DEV-17/DEV-19: ET-INC, не VERIFIED)", ["self_confirming"]);
    }
    if (e.evidence_tier === "ET-DET" && e.assertion !== "presence") bad("ET-DET несумісний з capture_complete=false для твердження відсутності (DEV-96 лише для presence)", ["evidence_tier"]);
  }
  if (e.assertion === "absence" && e.claim_kind !== undefined && !ABSENCE_CLAIM_KINDS.has(e.claim_kind)) {
    bad(`assertion=absence, але claim_kind ${e.claim_kind} не є твердженням відсутності`, ["claim_kind"]);
  }
  // позиційне твердження при відкритому банері — теж не self_confirming (DEV-19)
  if (e.claim_kind !== undefined && POSITIONAL_CLAIM_KINDS.has(e.claim_kind) && e.capture_context?.banner_state === "open" && e.self_confirming) {
    bad("позиційне твердження при banner_state=open не може бути self_confirming (DEV-19)", ["self_confirming"]);
  }
  // capture_complete узгоджений із capture_context (єдине джерело істини — контекст)
  if (e.capture_complete === true && e.capture_context) {
    const c = e.capture_context;
    if (c.blocked_requests_count > 0 || c.js_error_count > 0 || c.banner_state === "open" || !c.scroll_completed) {
      bad("capture_complete=true суперечить capture_context (заблоковані запити / JS-помилки / банер open / прокрутка не завершена)", ["capture_complete"]);
    }
  }
  if (e.category !== undefined && e.claim_kind !== undefined && !isClaimKindFor(e.category, e.claim_kind)) {
    bad(`claim_kind ${e.claim_kind} не належить категорії ${e.category}`, ["claim_kind"]);
  }
});
export type Evidence = z.infer<typeof Evidence>;

/** рядок БД: Evidence + прив'язка до аудиту (S2 записує при імпорті/обході) */
export const EvidenceRecord = EvidenceObject.extend({
  audit_run_id: z.string().min(1),
  created_at: z.string().datetime({ offset: true }).optional(),
}).superRefine((e, ctx) => {
  const r = Evidence.safeParse(Object.fromEntries(Object.entries(e).filter(([k]) => k !== "audit_run_id" && k !== "created_at")));
  if (!r.success) r.error.issues.forEach((i) => ctx.addIssue(i));
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

/**
 * Рівень сили доказу (SCORING_SPEC §1.2) — чиста функція для тестів і для S3/S4.
 * `null` = ET-SUP (опорний факт). Перевірка за порядком таблиці.
 */
export function tierOf(e: Evidence, ctx: { distinctSessionsForKey?: number; distinctLogsForBrowserFailure?: number } = {}): z.infer<typeof EvidenceTier> {
  const det = e.source_class === "OBSERVED" || e.source_class === "BENCHMARKED";
  // DEV-96: неповне захоплення (заблоковані сторонні запити, нестабільний layout) знецінює лише доказ ВІДСУТНОСТІ;
  // знайдене присутнє порушення (axe, overflow, важке зображення, поріг метрики Lighthouse) лишається фактом → ET-DET
  if (det && e.self_confirming && (e.capture_complete !== false || e.assertion === "presence")) return "ET-DET";
  if (e.browser_failure && (e.browser_failure.reproduced_by_replay || (ctx.distinctLogsForBrowserFailure ?? 0) >= 2)) return "ET-BRW";
  if (e.source_class === "SYNTHETIC") return (ctx.distinctSessionsForKey ?? 1) >= 2 ? "ET-SYN-M" : "ET-SYN-1";
  if (e.source_class === "INFERRED") return "ET-INF";
  if (e.source_class === "OBSERVED" && !e.self_confirming && e.capture_complete === false) return "ET-INC";
  return "ET-SUP";
}
