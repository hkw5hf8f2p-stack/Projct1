/**
 * Кроки прогресу для UI (SPEC §43): 8 підписів у фіксованому порядку. Стан кроку виводиться з `stage_status` і статусу аудиту (без внутрішніх міркувань моделі).
 * active — лише поточний крок нетермінального аудиту; відсутній етап термінального аудиту = skipped.
 */
export const PROGRESS_STEP_IDS = ["discovering_pages", "capturing", "technical_checks", "understanding_offering", "building_lenses", "testing_journeys", "aggregating_evidence", "preparing_report"] as const;
export type ProgressStepId = (typeof PROGRESS_STEP_IDS)[number];
export type StepState = "pending" | "active" | "done" | "skipped" | "budget_limited" | "failed";

const STAGES_OF: Record<ProgressStepId, string[]> = {
  discovering_pages: ["crawl"], capturing: ["capture"], technical_checks: ["lighthouse", "accessibility"], understanding_offering: ["site_profile", "tasks"],
  building_lenses: ["lenses", "scenario_matrix"], testing_journeys: ["snapshot_sessions", "browser_sessions"], aggregating_evidence: ["aggregate"], preparing_report: ["report"],
};
/** який крок «поточний», якщо аудит у цьому статусі (перший ще не завершений із кроків групи) */
const STATUS_STEPS: Record<string, ProgressStepId[]> = {
  queued: ["discovering_pages"], crawling: ["discovering_pages", "capturing", "technical_checks"], profiling: ["understanding_offering"], generating_lenses: ["building_lenses"],
  running_scenarios: ["testing_journeys"], aggregating: ["aggregating_evidence", "preparing_report"],
};
/** стан групи: failed > budget_limited > done (хоч один етап виконано) > skipped (жоден не виконано) */
const groupState = (known: StepState[]): StepState => (known.includes("failed") ? "failed" : known.includes("budget_limited") ? "budget_limited" : known.includes("done") ? "done" : "skipped");

export function progressSteps(a: { status: string; stage_status: Record<string, { status: string } | undefined> }): Array<{ id: ProgressStepId; state: StepState }> {
  const terminal = a.status === "completed" || a.status === "failed";
  const raw = PROGRESS_STEP_IDS.map((id) => {
    const sts = STAGES_OF[id].map((s) => a.stage_status[s]?.status as StepState | undefined);
    const known = sts.filter((x): x is StepState => !!x);
    let state: StepState;
    if (known.length === STAGES_OF[id].length) state = groupState(known);
    else if (known.length > 0 && !terminal) state = "pending";
    else state = terminal ? (known.length > 0 ? groupState(known) : "skipped") : "pending";
    return { id, state };
  });
  if (!terminal) {
    const cur = (STATUS_STEPS[a.status] ?? []).find((id) => raw.find((r) => r.id === id)?.state === "pending");
    if (cur) (raw.find((r) => r.id === cur) as { state: StepState }).state = "active";
  }
  return raw;
}
