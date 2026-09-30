/**
 * Агрегація за finding_key (DEV-7/38) на артефактах S1a + детермінізм (критерій S4 п.6) + C2 («плаваюча» мітка LLM
 * не змінює чисел). Вхідні артефакти читаються з репо (закомічені докази sprint-1a-fix).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Evidence, SyntheticSession } from "@sitelens/schemas";
import { aggregate, sessionObs } from "../src/index.js";
import { permutations, syn } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const A = (site: string, f: string) => JSON.parse(readFileSync(path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix", site, f), "utf8"));
const shopEv = (A("shop", "evidence.json") as unknown[]).map((e) => Evidence.parse(e));
const cleanEv = (A("shop-clean", "evidence.json") as unknown[]).map((e) => Evidence.parse(e));

describe("агрегація відтворює знахідки S1a (sprint-1a-fix/shop)", () => {
  const s1a = A("shop", "findings.json") as Array<{ finding_key: string; evidence_ids: string[]; confidence: string; evidence_strength: number; instances: number; evidence_families: string[] }>;
  const r = aggregate({ evidence: shopEv, pageTypes: {} });
  it("ті самі 8 ключів, ті самі докази, впевненість, сила, instances", () => {
    const got = r.findings.map((f) => ({ k: f.finding_key, ev: f.evidence_ids, c: f.confidence.level, s: f.strength.value, n: f.instances, fam: f.confidence.families })).sort((a, b) => (a.k < b.k ? -1 : 1));
    const want = s1a.map((f) => ({ k: f.finding_key, ev: [...f.evidence_ids].sort(), c: f.confidence, s: f.evidence_strength, n: f.instances, fam: f.evidence_families })).sort((a, b) => (a.k < b.k ? -1 : 1));
    expect(got).toEqual(want);
    expect(r.withheld).toEqual([]);
    expect(r.unkeyed_evidence_ids).toEqual([]);
  });
  it("усі 8 — VERIFIED і в топ-10", () => {
    expect(r.findings).toHaveLength(8);
    expect(r.findings.every((f) => f.confidence.level === "VERIFIED" && f.rank <= 10)).toBe(true);
  });
  it("shop-clean: 0 доказів → 0 знахідок (негатив)", () => {
    expect(cleanEv).toHaveLength(0);
    expect(aggregate({ evidence: cleanEv, pageTypes: {} }).findings).toHaveLength(0);
  });
});

describe("детермінізм: однаковий вхід → ідентичні числа й порядок", () => {
  const key = "shipping|product|deep_link_only";
  const extra = [
    syn({ category: "shipping", claim_kind: "deep_link_only", path: "/product/aquapro-x200", page_type: "product", session: "s1", lens: "L1", task: "t1" }),
    syn({ category: "terminology", claim_kind: "general", path: "/catalog", page_type: "category", page_group: "category", session: "s2", lens: "L2", task: "t2" }),
    syn({ category: "terminology", claim_kind: "general", path: "/catalog", page_type: "category", page_group: "category", session: "s3", lens: "L3", task: "t1", level: "journey" }),
  ];
  const sessions = [
    { session_id: "s1", lens_id: "L1", task_id: "t1", level: "snapshot" as const, success: "false" as const, pages_seen: ["/product/aquapro-x200", "/catalog"], reported_keys: [key], last_friction_key: key },
    { session_id: "s2", lens_id: "L2", task_id: "t2", level: "snapshot" as const, success: "true" as const, pages_seen: ["/catalog"], reported_keys: ["terminology|category|general"], last_friction_key: "terminology|category|general" },
    { session_id: "s3", lens_id: "L3", task_id: "t1", level: "journey" as const, success: "partial" as const, pages_seen: ["/catalog", "/"], reported_keys: ["terminology|category|general"], last_friction_key: null },
    { session_id: "s4", lens_id: "L4", task_id: "t2", level: "snapshot" as const, success: "true" as const, pages_seen: ["/"], reported_keys: [], last_friction_key: null },
  ];
  const all = [...shopEv, ...extra];
  const ref = JSON.stringify(aggregate({ evidence: all, sessions, pageTypes: {} }));
  it.each(permutations(all).map((p, i) => [i, p] as const))("перестановка доказів #%i", (_i, p) => {
    expect(JSON.stringify(aggregate({ evidence: p, sessions, pageTypes: {} }))).toBe(ref);
  });
  it.each(permutations(sessions).map((p, i) => [i, p] as const))("перестановка сесій #%i", (_i, p) => {
    expect(JSON.stringify(aggregate({ evidence: all, sessions: p, pageTypes: {} }))).toBe(ref);
  });
  it("3 прогони поспіль — ідентичні (критерій 6: 3/3)", () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(aggregate({ evidence: all, sessions, pageTypes: {} }).findings.map((f) => [f.finding_key, f.priority.value, f.rank])));
    expect(new Set(runs).size).toBe(1);
  });
  it("контроль: зміна одного вхідного факту змінює вихід (порівняння не тавтологічне)", () => {
    const changed = sessions.map((s) => (s.session_id === "s4" ? { ...s, reported_keys: ["terminology|category|general"], pages_seen: ["/catalog"] } : s));
    expect(JSON.stringify(aggregate({ evidence: all, sessions: changed, pageTypes: {} }))).not.toBe(ref);
  });
});

describe("C2: числа ставить код — «плаваюча» мітка й формулювання LLM не змінюють пріоритети", () => {
  const LABELS = [["low", "slightly unclear wording"], ["high", "CRITICAL: users will be totally lost!!!"], ["medium", "термін не пояснено"]] as const;
  const run = (label: "low" | "medium" | "high", text: string, category: "terminology" | "product_selection" = "terminology") => {
    const ss = [1, 2, 3].map((i) =>
      SyntheticSession.parse({
        session_id: `s${i}`, audit_run_id: "aud", lens_id: `L${i}`, task_id: i === 2 ? "t2" : "t1", level: "snapshot", status: "done", success: "partial", actions_used: 3,
        frictions: [{ category, severity: label, evidence: text, page_url: "http://shop.test/catalog" }], positive_signals: [], uncertainties: [], final_summary: text,
      }),
    );
    const obs = ss.map((s) => sessionObs(s, { pagesSeen: ["/catalog"], pageGroupOf: () => "category" }));
    const evs = ss.map((s) => syn({ category, claim_kind: "general", path: "/catalog", page_type: "category", page_group: "category", session: s.session_id, lens: s.lens_id, task: s.task_id }));
    return aggregate({ evidence: evs, sessions: obs, pageTypes: {} }).findings.map((f) => [f.finding_key, f.priority.value, f.severity.value, f.confidence.level]);
  };
  it("3 replay-прогони з різною силою формулювань → однакові пріоритети", () => {
    const outs = LABELS.map(([l, t]) => JSON.stringify(run(l, t)));
    expect(new Set(outs).size).toBe(1);
  });
  it("контроль: зміна закритої КЛАСИФІКАЦІЇ (категорії) змінює число — перевірка вміє впасти", () => {
    expect(JSON.stringify(run("low", "x", "product_selection"))).not.toBe(JSON.stringify(run("low", "x", "terminology")));
  });
});
