/**
 * LATER (S6, після S8 за DEV-14): Variant і Comparison (SPEC §30–§31). Схеми є для узгодженості назв;
 * таблиць у міграції 001 немає (додаються міграцією S6). Калібрування §59 — лише документ (DEV-15).
 */
import { z } from "zod";

export const Variant = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().min(1),
    finding_id: z.string().min(1),
    /** одна головна змінна на варіант (§30) */
    variable: z.string().min(1),
    text: z.string().min(1),
    prompt_version: z.string().optional(),
  })
  .strict();

export const Comparison = z
  .object({
    id: z.string().min(1),
    audit_run_id: z.string().min(1),
    finding_id: z.string().min(1),
    variant_id: z.string().min(1),
    a_preferred: z.number().int().nonnegative(),
    b_preferred: z.number().int().nonnegative(),
    no_difference: z.number().int().nonnegative(),
    /** «Synthetic preference result. This is not a measured conversion uplift.» */
    disclaimer: z.literal("synthetic_preference_not_measured_uplift"),
  })
  .strict();
