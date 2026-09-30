/**
 * Кроки прогресу для UI (SPEC §43): 8 підписів у фіксованому порядку. Стан кроку виводиться з `stage_status` і статусу аудиту (без внутрішніх міркувань моделі).
 * active — лише поточний крок нетермінального аудиту; відсутній етап термінального аудиту = skipped.
 */
import { QUEUE_SPECS } from "./queue.js";
import type { AuditRow, Db } from "./repo.js";

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

// ---------------------------------------------------------------- DEV-92: детальні лічильники й ETA
export type CounterUnit = "pages" | "lighthouse" | "accessibility" | "llm_calls" | "lenses" | "snapshot_sessions" | "journals";
export interface StepCounterView { unit: CounterUnit; done: number; total: number | null; approx?: boolean; eta_seconds?: number | null }
export interface StepDetailView { id: ProgressStepId; counters: StepCounterView[]; eta_seconds: number | null; started_at: string | null }

/** сирі числа з БД (один аудит); усе, що можна порахувати без вигадування */
export interface ProgressFacts {
  status: string;
  started_at: string | null;
  stage_status: Record<string, { status: string; updated_at?: string } | undefined>;
  max_pages: number;
  llm_concurrency: number;
  lens_target: number;
  expected_jobs: string[] | null;
  expected_scenarios: string[] | null;
  /** завершені задачі audit_jobs за видом: кількість (будь-який статус) і тривалості (мс), де відомі */
  jobs: Record<"capture" | "lighthouse" | "accessibility" | "snapshot" | "browser", { finished: number; failed: number; durations_ms: number[] }>;
  lenses_count: number;
  /** тривалості LLM-етапів (сума latency_ms викликів етапу) для етапів, що вже записані */
  llm_stage_ms: Record<string, number>;
  llm_calls_testing: number;
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** ETA = середня тривалість завершених задач × (лишилось / паралельність). Немає завершених → null (не вигадуємо). */
export function etaSeconds(durationsMs: number[], remaining: number, concurrency: number): number | null {
  if (remaining <= 0) return 0;
  const a = avg(durationsMs);
  return a === null ? null : Math.round((a * Math.ceil(remaining / Math.max(1, concurrency))) / 1000);
}
/** ETA кроку: максимум ETA лічильників (вони йдуть паралельно); якщо в лічильника з залишком ETA невідомий — null */
const stepEta = (cs: StepCounterView[]): number | null => {
  const open = cs.filter((c) => c.total === null || c.done < c.total);
  const withEta = open.filter((c) => c.eta_seconds !== undefined && c.eta_seconds !== null);
  if (open.length === 0 || withEta.length !== open.filter((c) => c.eta_seconds !== undefined).length || withEta.length === 0) return null;
  return Math.max(...withEta.map((c) => c.eta_seconds as number));
};

export function computeStepDetails(f: ProgressFacts, steps: Array<{ id: ProgressStepId; state: StepState }>): StepDetailView[] {
  const J = f.jobs;
  const keys = (list: string[] | null, prefix: string) => (list ? list.filter((k) => k.startsWith(prefix)).length : null);
  const crawlDone = f.stage_status["crawl"]?.status === "done" || f.stage_status["crawl"]?.status === "failed";
  const pagesDone = J.capture.finished;
  const pagesTotal = crawlDone ? pagesDone : f.max_pages;
  const pages: StepCounterView = { unit: "pages", done: pagesDone, total: pagesTotal, ...(crawlDone ? {} : { approx: true }), ...(crawlDone ? {} : { eta_seconds: etaSeconds(J.capture.durations_ms, pagesTotal - pagesDone, 1) }) };
  const lhTotal = keys(f.expected_jobs, "lighthouse:");
  const lh: StepCounterView = { unit: "lighthouse", done: J.lighthouse.finished, total: lhTotal, eta_seconds: lhTotal === null ? null : etaSeconds(J.lighthouse.durations_ms, lhTotal - J.lighthouse.finished, QUEUE_SPECS.run_lighthouse.concurrency) };
  const a11yTotal = keys(f.expected_jobs, "accessibility:");
  const a11y: StepCounterView = { unit: "accessibility", done: J.accessibility.finished, total: a11yTotal };
  const stagesDone = (list: string[]) => list.filter((s) => f.stage_status[s]).length;
  const prof: StepCounterView = { unit: "llm_calls", done: stagesDone(["site_profile", "tasks"]), total: 2, eta_seconds: etaSeconds(["site_profile", "tasks"].filter((s) => f.llm_stage_ms[s] !== undefined).map((s) => f.llm_stage_ms[s] as number), 2 - stagesDone(["site_profile", "tasks"]), 1) };
  const lenses: StepCounterView = { unit: "lenses", done: f.lenses_count, total: f.lens_target, approx: true };
  const lensCalls: StepCounterView = { unit: "llm_calls", done: stagesDone(["lenses", "scenario_matrix"]), total: 2 };
  const snapTotal = keys(f.expected_scenarios, "snapshot:");
  const brTotal = keys(f.expected_scenarios, "browser:");
  const snap: StepCounterView = { unit: "snapshot_sessions", done: J.snapshot.finished, total: snapTotal, eta_seconds: snapTotal === null ? null : etaSeconds(J.snapshot.durations_ms, snapTotal - J.snapshot.finished, f.llm_concurrency) };
  const br: StepCounterView = { unit: "journals", done: J.browser.finished, total: brTotal, eta_seconds: brTotal === null ? null : etaSeconds(J.browser.durations_ms, brTotal - J.browser.finished, QUEUE_SPECS.run_browser_scenario.concurrency) };
  const calls: StepCounterView = { unit: "llm_calls", done: f.llm_calls_testing, total: null };
  const counters: Partial<Record<ProgressStepId, StepCounterView[]>> = {
    discovering_pages: [pages], capturing: [pages], technical_checks: [lh, a11y], understanding_offering: [prof], building_lenses: [lenses, lensCalls],
    testing_journeys: [snap, ...(brTotal ? [br] : []), calls],
  };
  // початок кроку = найпізніше завершення етапів попередніх кроків (для першого — старт аудиту)
  const stamp = (stages: string[]) => stages.map((s) => f.stage_status[s]?.updated_at).filter((x): x is string => !!x).sort().pop() ?? null;
  return steps.map((s, i) => {
    const cs = counters[s.id] ?? [];
    let started: string | null = null;
    if (s.state === "active" || s.state === "done") {
      started = i === 0 ? f.started_at : stamp(PROGRESS_STEP_IDS.slice(0, i).flatMap((id) => STAGES_OF[id])) ?? f.started_at;
    }
    return { id: s.id, counters: cs, eta_seconds: s.state === "active" ? stepEta(cs) : null, started_at: started };
  });
}

/** Один опитувальний запит на аудит: лічильники з audit_jobs / llm_calls / behavioral_lenses. Лише читання. */
export async function loadProgressFacts(db: Db, a: AuditRow): Promise<ProgressFacts> {
  const cfg = a.config_json as Record<string, unknown>;
  const jobs = (await db.query("SELECT kind, status, (result_json->>'duration_ms')::float8 AS ms FROM audit_jobs WHERE audit_run_id = $1", [a.id])).rows as Array<{ kind: string; status: string; ms: number | null }>;
  const bucket = () => ({ finished: 0, failed: 0, durations_ms: [] as number[] });
  const J: ProgressFacts["jobs"] = { capture: bucket(), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(), browser: bucket() };
  for (const r of jobs) {
    const b = J[r.kind as keyof typeof J];
    if (!b) continue;
    b.finished++;
    if (r.status === "failed") b.failed++;
    if (r.ms !== null && Number.isFinite(r.ms) && r.ms >= 0) b.durations_ms.push(r.ms);
  }
  const lc = (await db.query("SELECT stage, sum(latency_ms)::float8 AS ms, count(*)::int AS n FROM llm_calls WHERE audit_run_id = $1 GROUP BY stage", [a.id])).rows as Array<{ stage: string; ms: number | null; n: number }>;
  const ln = Number((await db.query("SELECT count(*) AS n FROM behavioral_lenses WHERE audit_run_id = $1", [a.id])).rows[0]?.n ?? 0);
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    status: a.status, started_at: a.started_at?.toISOString() ?? null, stage_status: a.stage_status,
    max_pages: num(cfg["max_pages"], 12), llm_concurrency: num(cfg["llm_concurrency"], 1), lens_target: num(cfg["lens_target"], 12),
    expected_jobs: Array.isArray(cfg["expected_jobs"]) ? (cfg["expected_jobs"] as string[]) : null,
    expected_scenarios: Array.isArray(cfg["expected_scenarios"]) ? (cfg["expected_scenarios"] as string[]) : null,
    jobs: J, lenses_count: ln,
    llm_stage_ms: Object.fromEntries(lc.filter((r) => r.ms !== null).map((r) => [r.stage, r.ms as number])),
    llm_calls_testing: lc.filter((r) => r.stage === "snapshot_sessions" || r.stage === "browser_sessions").reduce((x, r) => x + r.n, 0),
  };
}
