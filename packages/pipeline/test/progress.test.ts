/** Кроки прогресу §43: стани з stage_status і статусу аудиту; контролі — active лише в нетермінального, відсутній етап термінального = skipped, збій не ховається. */
import { describe, expect, it } from "vitest";
import { PROGRESS_STEP_IDS, progressSteps } from "../src/index.js";

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
