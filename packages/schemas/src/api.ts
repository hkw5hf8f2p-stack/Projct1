/** Форми API S2 (SPEC §42): вхід і вихід. Жодного LLM-тексту в S2-відповідях (guard звіту — S4). */
import { z } from "zod";
import { AuditStatus, LlmMode } from "./enums.js";
import { ERROR_CLASSES } from "./errors.js";

export const ErrorClassEnum = z.enum(ERROR_CLASSES);
export const CreateAuditRequest = z.object({ url: z.string().min(1).max(2048), language: z.enum(["uk", "en"]).optional() }).strict();
export const CreateAuditResponse = z.object({ auditId: z.string().regex(/^aud_[0-9a-f]{16}$/) });
export const ApiError = z.object({ error: z.object({ class: ErrorClassEnum.or(z.enum(["unauthorized", "rate_limited", "not_found", "bad_request", "internal"])), message: z.string().min(1) }) });

export const AuditWarning = z.object({ stage: z.string(), page_url: z.string().optional(), class: ErrorClassEnum.optional(), message: z.string() });
export const AuditStatusResponse = z.object({
  id: z.string(),
  status: AuditStatus,
  input_url: z.string(),
  normalized_url: z.string(),
  language: z.enum(["uk", "en"]),
  llm_mode: LlmMode,
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  stage_status: z.record(z.unknown()),
  progress: z.object({ pages_captured: z.number().int(), pages_failed: z.number().int(), lighthouse_done: z.number().int(), lighthouse_failed: z.number().int() }),
  warnings: z.array(AuditWarning),
  error: z.object({ class: ErrorClassEnum, message: z.string() }).nullable(),
  artifacts_deleted: z.boolean(),
  artifact_expires_at: z.string().nullable(),
});
