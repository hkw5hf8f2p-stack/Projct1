/**
 * Адаптер виконавця браузерних журналів: `runJourney` (packages/browser, sl-core-engineer) + `agentTurn` (packages/llm) → `JournalRunner` worker-а (DEV-70).
 * Код лише «склеює»: рішення про дозволені дії, deny-list, same-origin, блок не-GET і звірка цитат — у runJourney; LLM-крок і його валідація — в agentTurn.
 * Збій драйвера (LLM не відповів валідно / бюджет) → сесія `failed`, аудит не падає (§47). Докази `browser_failure` (ET-BRW) із журналу поки НЕ інтегровано у звіт:
 * у звіт іде лише SYNTHETIC-доказ friction (integrateSessions, §23) — ⏭️ разом із живим пасом.
 */
import { existsSync, readFileSync } from "node:fs";
import { runJourney, type AgentDriver } from "@sitelens/browser";
import { agentTurn, sha256, type PageInput } from "@sitelens/llm";
import { auditDir } from "@sitelens/pipeline";
import type { JournalRunner } from "./runtime.js";

export const browserJournalRunner: JournalRunner = async (i) => {
  const before = i.client.records.length;
  const ctx = { audit_run_id: i.auditRunId, client: i.client, language: i.language };
  let stop: { status: "budget_limited" | "failed"; reason: string } | null = null;
  const driver: AgentDriver = async (obs) => {
    const image = obs.screenshot_path && existsSync(obs.screenshot_path)
      ? { type: "image" as const, media_type: "image/png" as const, sha256: sha256(readFileSync(obs.screenshot_path)), path: obs.screenshot_path, label: `journey step ${obs.step}` }
      : null;
    const page: PageInput = { id: `step${obs.step}`, url: obs.url, page_type: "other", title: obs.title, meta_description: "", headings: [], visible_text: obs.visible_text, link_texts: obs.link_texts, image };
    const r = await agentTurn(ctx, {
      page, lens: i.lens, task: { id: i.task.task_id, name: i.task.name, goal: i.task.goal, task_type: i.task.task_type }, a11y_outline: obs.a11y_outline,
      history: obs.history, remaining: obs.remaining, step: obs.step, image,
    });
    if (r.status !== "done" || !r.output) {
      stop = { status: r.status === "budget_limited" ? "budget_limited" : "failed", reason: r.reason ?? `agent_turn ${r.status}` };
      throw new Error(`agent_turn ${r.status}: ${r.reason ?? ""}`.slice(0, 300));
    }
    const t = r.output.turn;
    return { step: { ...t.step }, result: t.result ? { ...t.result, frictions: t.result.frictions.map((f) => ({ ...f })) } : null };
  };
  const res = await runJourney({
    secure: await i.browser(), startUrl: i.startUrl, runDir: auditDir(i.artifactDir, i.auditRunId), audit_run_id: i.auditRunId, lens_id: i.lens.id,
    task: { id: i.task.task_id, name: i.task.name, goal: i.task.goal, task_type: i.task.task_type, max_actions: i.task.max_actions }, driver,
    throttle: i.gate, userAgent: i.userAgent, writeShots: true,
  });
  const calls = i.client.records.slice(before);
  const non_get_blocked = res.method_blocks;
  const s = res.session;
  if (s.status === "failed") {
    const st = stop as { status: "budget_limited" | "failed"; reason: string } | null;
    return { status: st?.status ?? "failed", reason: st?.reason ?? `журнал завершився помилкою (${res.end_reason})`, calls, non_get_blocked };
  }
  const paths = new Set<string>();
  for (const l of res.steps) for (const u of [l.url_before, l.url_after]) { try { paths.add(new URL(u).pathname); } catch { /* пропускаємо */ } }
  return {
    status: "done", calls, non_get_blocked,
    session: {
      session_id: s.session_id, success: s.success, actions_used: s.actions_used, frictions: s.frictions, positive_signals: s.positive_signals, uncertainties: s.uncertainties, final_summary: s.final_summary,
      pages_seen: [...paths].sort(), steps: s.steps.map((x) => ({ action: x.action, target: x.target, reason_summary: x.reason_summary, task_progress: x.task_progress, friction_detected: x.friction_detected })),
    },
  };
};
