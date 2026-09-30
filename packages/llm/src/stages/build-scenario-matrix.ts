import type { BehavioralLens, Scenario, Task } from "@sitelens/schemas";
import { buildMatrix, selectFixedJournals, toScenarios, type JournalPick, type MatrixEntry } from "../matrix/build.js";
import { done, notRun, type StageContext, type StageResult } from "./types.js";

export interface MatrixOutput {
  snapshot_entries: MatrixEntry[];
  scenarios: Scenario[];
  fixed_journals: JournalPick[];
  journal_scenarios: Scenario[];
  violations: string[];
}

/** Без LLM-виклику: детермінований код (SCORING_SPEC §10). Порушення покриття повертаються, не ховаються. */
export async function buildScenarioMatrix(ctx: StageContext, input: { lenses: readonly BehavioralLens[]; tasks: readonly Task[] }): Promise<StageResult<MatrixOutput>> {
  if (ctx.client.mode === "none") return notRun("scenario_matrix", null, "skipped", "no LLM provider");
  const m = buildMatrix(input.lenses, input.tasks);
  const j = selectFixedJournals(input.lenses, input.tasks);
  const out: MatrixOutput = {
    snapshot_entries: m.entries,
    scenarios: toScenarios(ctx.audit_run_id, m.entries, "snapshot"),
    fixed_journals: j.journals,
    journal_scenarios: toScenarios(ctx.audit_run_id, j.journals, "journey"),
    violations: m.violations,
  };
  const res = done("scenario_matrix", null, out, [], [...m.flags, ...j.flags]);
  if (m.violations.length > 0) res.flags.push(...m.violations.map((v) => `violation:${v}`));
  return res;
}
