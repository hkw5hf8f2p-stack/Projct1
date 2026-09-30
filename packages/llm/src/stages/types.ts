import type { AuditStage, StageStatus } from "../types.js";
import type { CallRecord, LlmClient } from "../client.js";
import { BudgetExceededError, LlmDisabledError, OutputInvalidError, SessionAwaitingError } from "../errors.js";

export interface StageContext { audit_run_id: string; client: LlmClient; language: "uk" | "en" }

export interface Rejection { rule: string; detail: string }
export interface StageResult<T> {
  stage: AuditStage;
  status: StageStatus;
  reason?: string;
  output: T | null;
  /** прапорці якості (pole_unmet:P3, unknown_var:…, matrix_overflow …) */
  flags: string[];
  /** що відхилено кодом і чому (нічого з цього не потрапляє в output) */
  rejected: Rejection[];
  calls: CallRecord[];
  prompt_id: string | null;
}

export const done = <T>(stage: AuditStage, prompt_id: string | null, output: T, calls: CallRecord[], flags: string[] = [], rejected: Rejection[] = []): StageResult<T> =>
  ({ stage, status: "done", output, flags, rejected, calls, prompt_id });
export const notRun = <T>(stage: AuditStage, prompt_id: string | null, status: StageStatus, reason: string, calls: CallRecord[] = [], rejected: Rejection[] = []): StageResult<T> =>
  ({ stage, status, reason, output: null, flags: [], rejected, calls, prompt_id });

const ruleOfIssue = (s: string) => s.split(":", 1)[0] ?? s;

/**
 * Єдина обгортка помилок етапу: без LLM → skipped; бюджет → budget_limited; невалідний вихід після repair → failed (нічого не збережено).
 * ReplayMissError НЕ ловиться: гучна помилка проходить до worker (G0-16).
 */
export async function guardStage<T>(stage: AuditStage, prompt_id: string, ctx: StageContext, body: () => Promise<StageResult<T>>): Promise<StageResult<T>> {
  const before = ctx.client.records.length;
  try {
    return await body();
  } catch (e) {
    const calls = ctx.client.records.slice(before);
    if (e instanceof SessionAwaitingError) return notRun(stage, prompt_id, "awaiting_session_model", `awaiting_session_model: ${e.request_id} (attempt=${e.attempt})`, calls);
    if (e instanceof LlmDisabledError) return notRun(stage, prompt_id, "skipped", "no LLM provider");
    if (e instanceof BudgetExceededError) return notRun(stage, prompt_id, "budget_limited", `обмежено бюджетом: MAX_AUDIT_TOKENS ${e.used}/${e.max} токенів, етап зупинено`, calls);
    if (e instanceof OutputInvalidError) {
      return notRun(stage, prompt_id, "failed", `invalid output after repair retry: ${[...new Set(e.issues.map(ruleOfIssue))].join(", ")}`, calls, e.issues.map((i) => ({ rule: ruleOfIssue(i), detail: i })));
    }
    throw e;
  }
}
