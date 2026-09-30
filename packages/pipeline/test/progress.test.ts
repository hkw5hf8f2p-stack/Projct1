/** Кроки прогресу §43: стани з stage_status і статусу аудиту; контролі — active лише в нетермінального, відсутній етап термінального = skipped, збій не ховається. */
import { describe, expect, it } from "vitest";
import { PROGRESS_STEP_IDS, computeStepDetails, etaSeconds, progressSteps, type ProgressFacts } from "../src/index.js";

const st = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { status: v }]));
const states = (a: Parameters<typeof progressSteps>[0]) => progressSteps(a).map((x) => x.state);

describe("progressSteps (SPEC §43)", () => {
  it("8 кроків у фіксованому порядку", () => expect(progressSteps({ status: "queued", stage_status: {} }).map((x) => x.id)).toEqual([...PROGRESS_STEP_IDS]));
  it("queued: перший крок active, решта pending", () => expect(states({ status: "queued", stage_status: {} })).toEqual(["active", "pending", "pending", "pending", "pending", "pending", "pending", "pending"]));
  it("crawling: crawl done → active = capture", () => expect(states({ status: "crawling", stage_status: st({ crawl: "done" }) })).toEqual(["done", "active", "pending", "pending", "pending", "pending", "pending", "pending"]));
  it("running_scenarios: лише journeys active; попередні done", () =>
    expect(states({ status: "running_scenarios", stage_status: st({ crawl: "done", capture: "done", lighthouse: "done", accessibility: "done", site_profile: "done", tasks: "done", lenses: "done", scenario_matrix: "done" }) })).toEqual(["done", "done", "done", "done", "done", "active", "pending", "pending"]));
  it("термінальний completed: відсутній етап = skipped; жодного active", () => {
    const s = states({ status: "completed", stage_status: st({ crawl: "done", capture: "done", accessibility: "done", aggregate: "done", report: "done" }) });
    expect(s).toEqual(["done", "done", "done", "skipped", "skipped", "skipped", "done", "done"]);
    expect(s).not.toContain("active");
  });
  it("збій і бюджет не ховаються: failed > budget_limited > done", () => {
    expect(states({ status: "completed", stage_status: st({ crawl: "done", capture: "done", lighthouse: "failed", accessibility: "done", report: "failed" }) })[2]).toBe("failed");
    expect(progressSteps({ status: "completed", stage_status: st({ snapshot_sessions: "budget_limited", browser_sessions: "done" }) })[5]!.state).toBe("budget_limited");
    expect(progressSteps({ status: "completed", stage_status: st({ report: "failed" }) })[7]!.state).toBe("failed");
  });
});

// ---------------------------------------------------------------- DEV-92: лічильники й ETA
const bucket = (finished = 0, durations_ms: number[] = [], failed = 0) => ({ finished, failed, durations_ms });
const facts = (o: Partial<ProgressFacts> = {}): ProgressFacts => ({
  status: "running_scenarios", started_at: "2026-09-30T10:00:00.000Z", stage_status: {}, max_pages: 12, llm_concurrency: 2, lens_target: 12, expected_jobs: null, expected_scenarios: null,
  jobs: { capture: bucket(), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(), browser: bucket() }, lenses_count: 0, llm_stage_ms: {}, llm_calls_testing: 0, ...o,
});
const details = (f: ProgressFacts, status = f.status) => computeStepDetails(f, progressSteps({ status, stage_status: f.stage_status }));
const by = (d: ReturnType<typeof details>, id: string) => d.find((x) => x.id === id)!;

describe("etaSeconds (DEV-92)", () => {
  it("середня тривалість × ceil(лишилось / паралельність)", () => {
    expect(etaSeconds([10_000, 20_000], 6, 2)).toBe(45); // 15 c × 3
    expect(etaSeconds([10_000], 5, 3)).toBe(20); // 10 c × 2
  });
  it("даних немає → null (не вигадуємо); лишилось 0 → 0", () => {
    expect(etaSeconds([], 5, 2)).toBeNull();
    expect(etaSeconds([], 0, 2)).toBe(0);
  });
});

describe("computeStepDetails (DEV-92)", () => {
  const scen = (n: number, m = 0) => [...Array.from({ length: n }, (_, i) => `snapshot:s${i}`), ...Array.from({ length: m }, (_, i) => `browser:j${i}`)];
  const done = { crawl: { status: "done", updated_at: "2026-09-30T10:05:00.000Z" }, capture: { status: "done", updated_at: "2026-09-30T10:05:00.000Z" }, lighthouse: { status: "done", updated_at: "2026-09-30T10:07:00.000Z" }, accessibility: { status: "done", updated_at: "2026-09-30T10:07:00.000Z" },
    site_profile: { status: "done", updated_at: "2026-09-30T10:08:00.000Z" }, tasks: { status: "done", updated_at: "2026-09-30T10:09:00.000Z" }, lenses: { status: "done", updated_at: "2026-09-30T10:12:00.000Z" }, scenario_matrix: { status: "done", updated_at: "2026-09-30T10:12:01.000Z" } };

  it("testing_journeys: сесії N/M, журнали N/M, ETA = max(сесії/паралельність, журнали); початок кроку = кінець матриці", () => {
    const d = details(facts({ stage_status: done, expected_scenarios: scen(12, 2), jobs: { capture: bucket(), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(4, [30_000, 50_000, 40_000, 40_000]), browser: bucket(0) }, llm_calls_testing: 4 }));
    const t = by(d, "testing_journeys");
    expect(t.counters.find((c) => c.unit === "snapshot_sessions")).toMatchObject({ done: 4, total: 12, eta_seconds: 160 }); // 40 c × ceil(8/2)
    expect(t.counters.find((c) => c.unit === "journals")).toMatchObject({ done: 0, total: 2, eta_seconds: null }); // журналів ще не було → невідомо
    expect(t.eta_seconds).toBeNull(); // один лічильник без даних → крок без ETA, а не вигадане число
    expect(t.started_at).toBe("2026-09-30T10:12:01.000Z");
    expect(by(d, "aggregating_evidence").started_at).toBeNull();
  });

  it("ETA кроку з'являється, коли є дані для всіх відкритих лічильників; після завершення — 0 відкритих → null", () => {
    const f = facts({ stage_status: done, expected_scenarios: scen(6, 1), jobs: { capture: bucket(), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(2, [20_000, 20_000]), browser: bucket(0) } });
    expect(by(details(f), "testing_journeys").eta_seconds).toBeNull();
    const g = facts({ ...f, jobs: { ...f.jobs, browser: bucket(0), snapshot: bucket(6, Array(6).fill(20_000)) }, expected_scenarios: scen(6, 0) });
    expect(by(details(g, "aggregating"), "testing_journeys").eta_seconds).toBeNull(); // крок не active
  });

  it("сторінки: до кінця crawl total = MAX_PAGES (approx), після — фактична кількість", () => {
    const early = by(details(facts({ status: "crawling", jobs: { capture: bucket(3, [4000, 6000, 5000]), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(), browser: bucket() } })), "capturing").counters[0]!;
    expect(early).toMatchObject({ unit: "pages", done: 3, total: 12, approx: true, eta_seconds: 45 });
    const late = by(details(facts({ status: "profiling", stage_status: { crawl: { status: "done" } }, jobs: { capture: bucket(7), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(), browser: bucket() } })), "capturing").counters[0]!;
    expect(late).toMatchObject({ done: 7, total: 7 });
    expect(late.approx).toBeUndefined();
  });

  it("Lighthouse N/M з expected_jobs; total = null, поки задачі не заплановано", () => {
    const f = facts({ status: "crawling", stage_status: { crawl: { status: "done" }, capture: { status: "done" } }, expected_jobs: ["lighthouse:a:desktop", "lighthouse:b:desktop", "accessibility:a", "accessibility:b", "accessibility:c"], jobs: { capture: bucket(3), lighthouse: bucket(1, [60_000]), accessibility: bucket(2), snapshot: bucket(), browser: bucket() } });
    const t = by(details(f), "technical_checks");
    expect(t.counters.map((c) => [c.unit, c.done, c.total])).toEqual([["lighthouse", 1, 2], ["accessibility", 2, 3]]);
    expect(t.eta_seconds).toBe(60);
    expect(by(details(facts({ status: "crawling", stage_status: { crawl: { status: "done" } } })), "technical_checks").counters[0]).toMatchObject({ done: 0, total: null });
  });

  it("лінзи N/ціль (approx) і LLM-етапи виконано/заплановано; ETA профілю з тривалості вже виконаного етапу", () => {
    const prof = by(details(facts({ status: "profiling", stage_status: { crawl: { status: "done" }, site_profile: { status: "done" } }, llm_stage_ms: { site_profile: 90_000 } })), "understanding_offering");
    expect(prof.counters[0]).toMatchObject({ unit: "llm_calls", done: 1, total: 2, eta_seconds: 90 });
    expect(prof.eta_seconds).toBe(90);
    const noData = by(details(facts({ status: "profiling", stage_status: { crawl: { status: "done" } } })), "understanding_offering");
    expect(noData.eta_seconds).toBeNull();
    const len = by(details(facts({ status: "generating_lenses", stage_status: { crawl: { status: "done" }, site_profile: { status: "done" }, tasks: { status: "done" } }, lens_target: 6, lenses_count: 0 })), "building_lenses");
    expect(len.counters[0]).toMatchObject({ unit: "lenses", done: 0, total: 6, approx: true });
  });

  it("монотонність: зі зростанням завершених задач done не спадає, а ETA не з'являється без даних", () => {
    let prev = -1;
    for (let n = 0; n <= 12; n++) {
      const f = facts({ stage_status: done, expected_scenarios: scen(12), jobs: { capture: bucket(), lighthouse: bucket(), accessibility: bucket(), snapshot: bucket(n, Array(n).fill(10_000)), browser: bucket() } });
      const c = by(details(f), "testing_journeys").counters[0]!;
      expect(c.done).toBeGreaterThanOrEqual(prev);
      prev = c.done;
      if (n === 0) expect(c.eta_seconds).toBeNull();
    }
  });
});
