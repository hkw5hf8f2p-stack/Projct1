/** Finding (SPEC §24, §25, §28; SCORING_SPEC §1–§6). Рядок S1a — підмножина; решта заповнюється S3/S4. */
import { z } from "zod";
import { Category, ClaimKind, Confidence, EvidenceFamily, EvidenceStrength, FunnelStage } from "./enums.js";
import { parseFindingKey } from "./finding-key.js";

const Unit = z.number().min(0).max(1);

export const Finding = z
  .object({
    /** у БД — PK разом з audit_run_id; в артефактах S1a його немає, ключ — finding_key */
    id: z.string().min(1).optional(),
    finding_key: z.string(),
    category: Category,
    page_group: z.string().min(1),
    claim_kind: ClaimKind,
    /** етап воронки (SCORING_SPEC §4.2); S1a не пише */
    stage: FunnelStage.optional(),
    detector_ids: z.array(z.string().min(1)),
    /** §23: знахідка без доказу не існує → ≥ 1 */
    evidence_ids: z.array(z.string().regex(/^ev_[0-9a-f]{12}$/)).min(1),
    evidence_families: z.array(EvidenceFamily).min(1),
    confidence: Confidence,
    evidence_strength: EvidenceStrength,
    /** кількість Evidence у групі (axe: вузлів × viewport) */
    instances: z.number().int().positive(),
    component: z.string().min(1).optional(),

    // ---- §24 метрики й §25 картка: S3/S4 (null/відсутні, доки не пораховані)
    lens_coverage: Unit.nullable().optional(),
    task_coverage: Unit.nullable().optional(),
    session_frequency: Unit.nullable().optional(),
    funnel_proximity: Unit.nullable().optional(),
    severity: Unit.nullable().optional(),
    /** «Priority NN/100»; ніколи не відсоток конверсії й не uplift */
    priority: z.number().int().min(0).max(100).nullable().optional(),
    title: z.string().min(1).optional(),
    problem: z.string().min(1).optional(),
    why_it_matters: z.string().min(1).optional(),
    /** контрдоказ детектора (правило суперечності, SCORING_SPEC §2): id Evidence */
    counter_evidence_ids: z.array(z.string().regex(/^ev_[0-9a-f]{12}$/)).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const bad = (message: string, path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const kp = parseFindingKey(f.finding_key);
    if (!kp) bad("finding_key не канонічний (category|page_group|claim_kind[|component])", ["finding_key"]);
    else {
      if (kp.category !== f.category) bad("finding_key.category ≠ category", ["category"]);
      if (kp.page_group !== f.page_group) bad("finding_key.page_group ≠ page_group", ["page_group"]);
      if (kp.claim_kind !== f.claim_kind) bad("finding_key.claim_kind ≠ claim_kind", ["claim_kind"]);
      if (kp.component !== f.component) bad("finding_key.component ≠ component", ["component"]);
    }
    if (new Set(f.evidence_ids).size !== f.evidence_ids.length) bad("evidence_ids містить дублікати", ["evidence_ids"]);
    if (f.instances < f.evidence_ids.length) bad("instances < кількості evidence_ids", ["instances"]);

    const fam = new Set(f.evidence_families);
    // SCORING_SPEC §2 (DEV-17/19): F-INC без F-DET ⇒ не вище HYPOTHESIS
    if (fam.has("F-INC") && !fam.has("F-DET") && f.confidence !== "HYPOTHESIS") {
      bad("родина F-INC без F-DET дає щонайбільше HYPOTHESIS (DEV-17/DEV-19)", ["confidence"]);
    }
    // VERIFIED потребує F-DET або відтвореного ET-BRW (у рядку — родина F-BRW)
    if (f.confidence === "VERIFIED" && !fam.has("F-DET") && !fam.has("F-BRW")) bad("VERIFIED без F-DET/F-BRW", ["confidence"]);
    if (f.confidence === "STRONG_HYPOTHESIS" && fam.size === 1 && fam.has("F-INC")) bad("STRONG без незалежних родин", ["confidence"]);
    // strength ↔ родини (SCORING_SPEC §1.2)
    if (fam.has("F-DET") && f.evidence_strength !== 1) bad("F-DET ⇒ evidence_strength = 1", ["evidence_strength"]);
    if (!fam.has("F-DET") && !fam.has("F-BRW") && !fam.has("F-SYN") && (fam.has("F-INF") || fam.has("F-INC")) && f.evidence_strength !== 0.3) {
      bad("лише F-INF/F-INC ⇒ evidence_strength = 0.3", ["evidence_strength"]);
    }
    if (fam.size === 1 && fam.has("F-SUP")) bad("знахідка лише з ET-SUP не існує (SCORING_SPEC §1.2)", ["evidence_families"]);
  });
export type Finding = z.infer<typeof Finding>;

/** SPEC §30, §25: рекомендація без знахідки й без доказу відкидається → finding_id обов'язковий */
export const Recommendation = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().min(1),
    finding_id: z.string().min(1),
    /** «recommended change» */
    recommended_change: z.string().min(1),
    /** «how to validate»: A/B тест тощо; без прогнозу конверсії */
    how_to_validate: z.string().min(1),
    prompt_version: z.string().regex(/^[a-z][a-z0-9-]*-v\d+$/).nullable().optional(),
    llm_call_id: z.string().nullable().optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type Recommendation = z.infer<typeof Recommendation>;
