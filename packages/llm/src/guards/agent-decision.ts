import { AgentStep } from "@sitelens/schemas";
import { ALLOWED_ACTIONS, FORBIDDEN_ACTIONS, type Issue } from "./text.js";

/** Валідатор рішення агента (SPEC §20–§21): S3 віддає перевірену частину, яку S4 підключає до журналів. */
export function validateAgentDecision(x: unknown): { ok: true; value: AgentStep } | { ok: false; issues: Issue[] } {
  const p = AgentStep.safeParse(x);
  const issues: Issue[] = [];
  if (!p.success) {
    for (const i of p.error.issues) {
      const path = i.path.join(".");
      issues.push(path === "reason_summary" ? `reason_too_long: reason_summary > 200 символів (§21)` : `schema: ${path || "(root)"}: ${i.message}`);
    }
  }
  const action = (x as { action?: unknown } | null)?.action;
  if (typeof action === "string") {
    if ((FORBIDDEN_ACTIONS as readonly string[]).includes(action)) issues.push(`forbidden_action: «${action}» заборонено (§20)`);
    else if (!(ALLOWED_ACTIONS as readonly string[]).includes(action)) issues.push(`unknown_action: «${action}» поза списком дозволених (§20)`);
  }
  return issues.length === 0 && p.success ? { ok: true, value: p.data } : { ok: false, issues };
}
