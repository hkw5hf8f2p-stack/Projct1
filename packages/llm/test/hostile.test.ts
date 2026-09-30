import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LlmClient, ScriptedFakeProvider, TokenBudget, buildSiteProfile, generateLenses, generateTasks, loadPagesFromArtifacts, validateAgentDecision,
  selectPagesForProfile, type PageInput, type StageResult, type StageContext, type LogicalKey, type ScriptEntry,
} from "../src/index.js";
import type { HostileCase } from "../src/testing/hostile-cases.js";
import { hostileCases } from "../src/testing/hostile-cases.js";
import { shopLensesResponse, shopProfileResponse, shopTasksResponse } from "../src/testing/synthetic-shop.js";
import { siteProfileV1 } from "../prompts/site-profile-v1.js";
import { taskGeneratorV1 } from "../prompts/task-generator-v1.js";
import { lensGeneratorV1 } from "../prompts/lens-generator-v1.js";
import { ARTIFACT_DIR, REPLAY_DIR, SHOP_ARTIFACTS } from "./helpers.js";

const cases = JSON.parse(readFileSync(path.join(REPLAY_DIR, "hostile/cases.json"), "utf8")) as HostileCase[];
let pages: PageInput[];
beforeAll(() => { pages = loadPagesFromArtifacts(SHOP_ARTIFACTS); });

const PROMPT_OF = { site_profile: siteProfileV1.id, tasks: taskGeneratorV1.id, lenses: lensGeneratorV1.id } as const;
const goodProfile = () => { const { evidence: _e, ...core } = shopProfileResponse(); void _e; return core as never; };

async function run(c: HostileCase, repair?: unknown): Promise<{ res: StageResult<unknown>; provider: ScriptedFakeProvider }> {
  const stage = c.stage as "site_profile" | "tasks" | "lenses";
  const pid = PROMPT_OF[stage];
  const first = selectPagesForProfile(pages)[0]!;
  // логічний ключ site_profile містить page_url першої сторінки вибірки
  const lk = (attempt: number, step = 0): LogicalKey => ({ prompt_id: pid, ...(stage === "site_profile" ? { page_url: first.url } : {}), step, ...(attempt ? { attempt } : {}) });
  const bad: ScriptEntry = c.raw_text !== undefined ? { response: null, raw_text: c.raw_text } : { response: c.response };
  const entries: Array<[LogicalKey, ScriptEntry]> = [[lk(0), bad], [lk(1), repair !== undefined ? { response: repair } : bad]];
  // друга (полюсна) хвиля запитів генератора лінз: та сама ворожа відповідь
  if (stage === "lenses") entries.push([lk(0, 1), bad], [lk(1, 1), bad]);
  const provider = ScriptedFakeProvider.from(entries);
  const client = new LlmClient({ mode: "fake", provider, budget: new TokenBudget(5_000_000) });
  const ctx: StageContext = { audit_run_id: "run_h", client, language: "uk" };
  const res: StageResult<unknown> =
    stage === "site_profile" ? await buildSiteProfile(ctx, { pages })
    : stage === "tasks" ? await generateTasks(ctx, { pages, profile: goodProfile() })
    : await generateLenses(ctx, { profile: goodProfile() });
  return { res, provider };
}

describe("ворожий набір S3: 0 протекло", () => {
  it("набір збігається з генератором у коді (fixtures/replay/hostile/cases.json не застарів) і має ≥ 10 ВИДІВ", () => {
    expect(cases).toEqual(JSON.parse(JSON.stringify(hostileCases())));
    const kinds = new Set(cases.filter((c) => c.expect.status !== "done" || c.expect.rules.length > 0).map((c) => c.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(10);
  });

  const results: Array<Record<string, unknown>> = [];
  const llmCases = cases.filter((c) => c.stage !== "agent");
  it.each(llmCases.map((c) => [`${c.id} ${c.kind}: ${c.description}`, c] as const))("%s", async (_n, c) => {
    const { res } = await run(c);
    const stored = JSON.stringify(res.output ?? null);
    const rules = new Set([...res.rejected.map((r) => r.rule), ...((res.reason ?? "").match(/[a-z_]+/g) ?? [])]);
    if (c.expect.status === "failed") {
      expect(res.status).toBe("failed");
      expect(res.output).toBeNull();
    } else {
      expect(res.status).toBe("done");
      expect(res.output).not.toBeNull();
    }
    for (const r of c.expect.rules) expect(rules, `правило ${r} у ${[...rules].join(",")}`).toContain(r);
    for (const p of c.expect.poison) expect(stored, `протекло «${p}»`).not.toContain(p);
    for (const id of c.expect.dropped_ids ?? []) {
      const lensIds = ((res.output as { lenses: Array<{ id: string }> }).lenses).map((l) => l.id);
      expect(lensIds).not.toContain(id);
    }
    if (c.expect.rules.length === 0 && c.expect.status === "done") expect(res.rejected).toEqual([]);
    results.push({ id: c.id, kind: c.kind, stage: c.stage, status: res.status, rules: c.expect.rules, leaked: c.expect.poison.filter((p) => stored.includes(p)).length, calls: res.calls.length });
  });

  const agentCases = cases.filter((c) => c.stage === "agent");
  it.each(agentCases.map((c) => [`${c.id} ${c.kind}: ${c.description}`, c] as const))("%s", (_n, c) => {
    const v = validateAgentDecision(c.response);
    if (c.expect.status === "done") { expect(v.ok).toBe(true); results.push({ id: c.id, kind: c.kind, stage: c.stage, status: "accepted", rules: [], leaked: 0, calls: 0 }); return; }
    expect(v.ok).toBe(false);
    const issues = v.ok ? [] : v.issues.join("\n");
    for (const r of c.expect.rules) expect(issues).toContain(r);
    const stored = v.ok ? JSON.stringify(v.value) : ""; // відхилене рішення нічого не зберігає
    expect(stored).toBe("");
    results.push({ id: c.id, kind: c.kind, stage: c.stage, status: "rejected", rules: c.expect.rules, leaked: 0, calls: 0 });
  });

  it("repair-повтор: перша відповідь ворожа, друга валідна → етап done, ворожого в збереженому немає, викликів 2", async () => {
    const c = cases.find((x) => x.id === "H04")!;
    const { res } = await run(c, shopProfileResponse());
    expect(res.status).toBe("done");
    expect(res.calls.map((x) => x.status)).toEqual(["invalid", "ok"]);
    expect(JSON.stringify(res.output)).not.toContain("72%");
    const t = await run(cases.find((x) => x.id === "H13")!, shopTasksResponse());
    expect(t.res.status).toBe("done");
    expect(JSON.stringify(t.res.output)).not.toContain("Оплатити");
  });

  it("контроль (guard уміє пропустити добре): валідні відповіді shop проходять усі три етапи без відхилень", async () => {
    const ok = { id: "OK", kind: "ok", stage: "lenses", description: "", response: shopLensesResponse(), expect: { status: "done", rules: [], poison: [] } } as HostileCase;
    const r = await run(ok);
    expect(r.res.status).toBe("done");
    expect(r.res.rejected).toEqual([]);
    expect(await run({ ...ok, stage: "site_profile", response: shopProfileResponse() } as HostileCase).then((x) => x.res.status)).toBe("done");
    expect(await run({ ...ok, stage: "tasks", response: shopTasksResponse() } as HostileCase).then((x) => x.res.status)).toBe("done");
  });

  it("підсумок пишеться в артефакт (усі випадки: відхилено/оброблено, протекло = 0)", () => {
    const total = results.length;
    const leaked = results.reduce((a, r) => a + (r.leaked as number), 0);
    expect(total).toBe(cases.length);
    expect(leaked).toBe(0);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(path.join(ARTIFACT_DIR, "hostile-results.json"), JSON.stringify({ cases_total: cases.length, evaluated: total, kinds: [...new Set(cases.map((c) => c.kind))].length, leaked_into_stored_objects: leaked, results, note: "SYNTHETIC ворожі відповіді; guard-и перевірено на позитивних і негативних (контрольних) випадках" }, null, 2) + "\n");
  });
});
