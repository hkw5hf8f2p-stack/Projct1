/**
 * 8 кроків прогресу SPEC §43 ← етапи `stage_status` (SPEC §47/§8). Це відображення структури, а не обчислення.
 * Крок = набір етапів; стан кроку береться з їхніх статусів (правило нижче), поточним є перший незавершений.
 */
import type { Key } from "./messages";

export const STEPS: ReadonlyArray<{ id: string; label: Key; stages: readonly string[]; llm: boolean }> = [
  { id: "crawl", label: "progress.step.crawl", stages: ["crawl"], llm: false },
  { id: "capture", label: "progress.step.capture", stages: ["capture"], llm: false },
  { id: "technical", label: "progress.step.technical", stages: ["lighthouse", "accessibility"], llm: false },
  { id: "profile", label: "progress.step.profile", stages: ["site_profile", "tasks"], llm: true },
  { id: "lenses", label: "progress.step.lenses", stages: ["lenses", "scenario_matrix"], llm: true },
  { id: "journeys", label: "progress.step.journeys", stages: ["snapshot_sessions", "browser_sessions"], llm: true },
  { id: "aggregate", label: "progress.step.aggregate", stages: ["aggregate"], llm: false },
  { id: "report", label: "progress.step.report", stages: ["report"], llm: false },
];

export type StepState = "pending" | "running" | "done" | "skipped" | "failed" | "budget_limited";
interface StageState { status?: string; reason?: string | null }

export interface StepView { id: string; label: Key; state: StepState; reason: string | null; llm: boolean }

export function stepViews(stageStatus: Record<string, unknown>, terminal: boolean, started: boolean): StepView[] {
  const views: StepView[] = STEPS.map((s) => {
    const st = s.stages.map((k) => (stageStatus[k] ?? null) as StageState | null);
    const known = st.filter((x): x is StageState => x !== null);
    let state: StepState = "pending";
    let reason: string | null = null;
    if (known.length > 0) {
      const failed = known.find((x) => x.status === "failed");
      const limited = known.find((x) => x.status === "budget_limited");
      const allSkipped = known.every((x) => x.status === "skipped");
      if (failed) [state, reason] = ["failed", failed.reason ?? null];
      else if (limited) [state, reason] = ["budget_limited", limited.reason ?? null];
      else if (known.length === st.length) [state, reason] = allSkipped ? ["skipped", known[0]?.reason ?? null] : ["done", null];
      else state = "running"; // частина етапів кроку вже є, решти ще ні
    }
    return { id: s.id, label: s.label, state, reason, llm: s.llm };
  });
  if (!terminal && started && !views.some((v) => v.state === "running")) {
    const firstOpen = views.findIndex((v) => v.state === "pending");
    if (firstOpen >= 0) (views[firstOpen] as StepView).state = "running";
  }
  return views;
}
