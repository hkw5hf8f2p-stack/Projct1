import { describe, expect, it } from "vitest";
import * as S from "../src/index.js";

const ts = "2026-09-29T10:00:00Z";
const run = (o: Record<string, unknown> = {}) => ({
  id: "run1", input_url: "https://example.com", normalized_url: "https://example.com/", domain: "example.com",
  status: "completed", created_at: ts, started_at: ts, completed_at: ts, error: null, prompt_version: null,
  llm_mode: "none", stage_status: { crawl: { status: "done" }, site_profile: { status: "skipped", reason: "no LLM provider" } }, ...o,
});

describe("AuditRun (DEV-11)", () => {
  it("режим без LLM: completed, LLM-етапи skipped", () => expect(S.AuditRun.safeParse(run()).success).toBe(true));
  it("llm_mode=none, але LLM-етап done — відхиляється", () =>
    expect(S.AuditRun.safeParse(run({ stage_status: { lenses: { status: "done" } } })).success).toBe(false));
  it("skipped без reason — відхиляється", () => expect(S.AuditRun.safeParse(run({ stage_status: { tasks: { status: "skipped" } } })).success).toBe(false));
  it("невідомий llm_mode / status / етап", () => {
    expect(S.AuditRun.safeParse(run({ llm_mode: "maybe" })).success).toBe(false);
    expect(S.AuditRun.safeParse(run({ status: "done" })).success).toBe(false);
    expect(S.AuditRun.safeParse(run({ stage_status: { crawlz: { status: "done" } } })).success).toBe(false);
  });
  it("failed без error", () => expect(S.AuditRun.safeParse(run({ status: "failed", completed_at: null })).success).toBe(false));
});

describe("BehavioralLens / Session / LlmCall", () => {
  const lens = { id: "l1", audit_run_id: "run1", name: "Newcomer", description: "d", category_knowledge: 0.1, price_sensitivity: 0.5, trust_requirement: 0.7,
    decision_speed: 0.3, detail_preference: 0.8, visual_sensitivity: 0.4, comparison_tendency: 0.6, risk_aversion: 0.9, convenience_priority: 0.2,
    social_proof_need: 0.5, primary_goal: "g", likely_questions: [], likely_objections: [] };
  it("змінні лише 0..1 і без market share", () => {
    expect(S.BehavioralLens.safeParse(lens).success).toBe(true);
    expect(S.BehavioralLens.safeParse({ ...lens, risk_aversion: 1.2 }).success).toBe(false);
    expect(S.BehavioralLens.safeParse({ ...lens, market_share: 0.2 }).success).toBe(false);
  });
  it("agent step: reason_summary ≤ 200", () => {
    const st = { action: "click", target: "a", reason_summary: "x".repeat(200), task_progress: "p", friction_detected: [] };
    expect(S.AgentStep.safeParse(st).success).toBe(true);
    expect(S.AgentStep.safeParse({ ...st, reason_summary: "x".repeat(201) }).success).toBe(false);
  });
  it("session: success лише true|false|partial, категорія з §22", () => {
    const s = { session_id: "s1", audit_run_id: "run1", lens_id: "l1", task_id: "t1", level: "snapshot", status: "done", success: "partial", actions_used: 3,
      frictions: [{ category: "shipping", severity: "high", evidence: "no delivery info", page_url: "https://example.com/p" }], positive_signals: [], uncertainties: [], final_summary: "x" };
    expect(S.SyntheticSession.safeParse(s).success).toBe(true);
    expect(S.SyntheticSession.safeParse({ ...s, success: "yes" }).success).toBe(false);
    expect(S.SyntheticSession.safeParse({ ...s, frictions: [{ ...s.frictions[0], category: "vibes" }] }).success).toBe(false);
  });
  it("llm_call: request_hash — sha256 hex", () => {
    const c = { id: "c1", audit_run_id: "run1", stage: "site_profile", prompt_version: "site-profile-v1", provider: "replay", model: "m", request_hash: "a".repeat(64),
      response_json: {}, status: "cached", error: null, input_tokens: 1, output_tokens: 1, latency_ms: 0, created_at: ts };
    expect(S.LlmCall.safeParse(c).success).toBe(true);
    expect(S.LlmCall.safeParse({ ...c, request_hash: "abc" }).success).toBe(false);
    expect(S.LlmCall.safeParse({ ...c, prompt_version: "siteprofile" }).success).toBe(false);
  });
  it("Task: max_actions за замовчуванням 8, task_type закритий", () => {
    const t = { task_id: "t1", name: "n", goal: "g", success_conditions: ["a"], failure_conditions: [], recommended_start_page: "/", task_type: "delivery" };
    expect(S.Task.parse(t).max_actions).toBe(8);
    expect(S.Task.safeParse({ ...t, task_type: "x" }).success).toBe(false);
  });
});

describe("AuditRun під колонки 002 (DEV-55/DEV-68)", () => {
  it("language/токени/error_class/warnings: валідні значення проходять, значення за замовчуванням є", () => {
    const p = S.AuditRun.parse(run({ language: "en", tokens_input: 10, tokens_output: 5, warnings: [{ stage: "capture", message: "m", class: "timeout" }] }));
    expect(p.language).toBe("en");
    expect(S.AuditRun.parse(run()).language).toBe("uk");
    expect(S.AuditRun.parse(run()).tokens_input).toBe(0);
  });
  it("контролі: мова xx, від'ємні токени, клас поза §48, failed без error_class — відхиляються", () => {
    expect(S.AuditRun.safeParse(run({ language: "xx" })).success).toBe(false);
    expect(S.AuditRun.safeParse(run({ tokens_input: -1 })).success).toBe(false);
    expect(S.AuditRun.safeParse(run({ error_class: "boom" })).success).toBe(false);
    expect(S.AuditRun.safeParse(run({ status: "failed", error: "x", completed_at: null })).success).toBe(false);
    expect(S.AuditRun.safeParse(run({ status: "failed", error: "x", error_class: "timeout", completed_at: null })).success).toBe(true);
  });
});

describe("Evidence Lighthouse (DEV-68)", () => {
  const lh = (o: Record<string, unknown> = {}) => ({
    id: "ev_0123456789ab", type: "lighthouse", source_class: "BENCHMARKED", page_url: "https://example.com/", description: "Lighthouse 13 performance (desktop): 98/100", artifact_reference: "pages/index/lighthouse-desktop.json",
    selector_or_region: { selector: "lhr.categories.performance" }, self_confirming: false, category: "performance", detector_id: "lighthouse:performance", claim_kind: "lighthouse_category_score", assertion: "presence", viewport: "D",
    measurement: { score_100: 98 }, capture_complete: true, capture_context: { banner_state: "none", banner_actions: [], blocked_requests_count: 0, js_error_count: 0, scroll_completed: true, layout_stable: true, http_status: null }, ...o,
  });
  it("performance і accessibility з claim_kind lighthouse_category_score — валідний доказ", () => {
    expect(S.Evidence.safeParse(lh()).success).toBe(true);
    expect(S.Evidence.safeParse(lh({ category: "accessibility", detector_id: "lighthouse:accessibility" })).success).toBe(true);
  });
  it("контроль: та сама вимірювальна назва в чужій категорії (cta) — відхиляється; LLM-список claim_kind її не містить", () => {
    expect(S.Evidence.safeParse(lh({ category: "cta" })).success).toBe(false);
    expect(S.CLAIM_KINDS_BY_CATEGORY.performance).not.toContain("lighthouse_category_score");
    expect(S.isClaimKindFor("performance", "lighthouse_category_score")).toBe(true);
    expect(S.isClaimKindFor("shipping", "lighthouse_category_score")).toBe(false);
  });
});
