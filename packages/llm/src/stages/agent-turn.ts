import { CATEGORIES, isClaimKindFor, type BehavioralLens } from "@sitelens/schemas";
import { browserAgentV1 } from "../../prompts/browser-agent-v1.js";
import { validateAgentDecision } from "../guards/agent-decision.js";
import { guardText } from "../guards/report-guard.js";
import { findInjectionEcho, type Issue } from "../guards/text.js";
import { pageCorpus, wrapDerivedData, wrapPageData, type PageInput } from "../page-input.js";
import { AgentTurnLlm, CLAIM_KIND_LIST, SCROLL_TARGETS, parseSemanticTarget, type SemanticTarget } from "../sim-schemas.js";
import type { ImagePart } from "../types.js";
import { buildRequest, LANG_NAME } from "./prompt-util.js";
import type { TaskBrief } from "./snapshot-eval.js";
import { done, guardStage, type StageContext, type StageResult } from "./types.js";

export interface AgentTurnInput {
  page: PageInput; lens: BehavioralLens; task: TaskBrief; a11y_outline: string;
  history: ReadonlyArray<{ action: string; target: string; reason_summary: string }>;
  remaining: number; step: number; image?: ImagePart | null;
}

export function validateAgentTurn(v: AgentTurnLlm, page: PageInput, remaining: number): Issue[] {
  const out: Issue[] = [];
  const s = v.step;
  const dec = validateAgentDecision(s);
  if (!dec.ok) out.push(...dec.issues);
  const stop = s.action === "stop_success" || s.action === "stop_failure";
  if (stop && v.result === null) out.push("missing_result: stop_* потребує result");
  if (!stop && v.result !== null) out.push("unexpected_result: result дозволено лише зі stop_*");
  if (s.action === "click" || s.action === "navigate_internal_link") { if (!parseSemanticTarget(s.target)) out.push(`bad_target: «${s.target.slice(0, 40)}» — потрібен семантичний локатор role:"name", без координат/CSS/URL (§11)`); }
  else if (s.action === "scroll") { if (!(SCROLL_TARGETS as readonly string[]).includes(s.target)) out.push("bad_target: для scroll лише down|up|top"); }
  else if (s.target !== "") out.push("bad_target: для back і stop_* target порожній");
  if (remaining <= 0 && !stop) out.push("no_actions_left: дій не лишилось, потрібен stop_*");
  const texts = [s.reason_summary, s.task_progress, ...(v.result ? [v.result.final_summary, ...v.result.positive_signals, ...v.result.uncertainties] : [])];
  const corpus = pageCorpus(page);
  for (const t of texts) { const g = guardText(t, { field: "reason_summary", structural: false, evidence_corpus: corpus }); if (!g.ok) out.push(...g.issues.slice(0, 2)); }
  out.push(...findInjectionEcho(texts));
  for (const f of v.result?.frictions ?? []) {
    if (!(CATEGORIES as readonly string[]).includes(f.category) || !CLAIM_KIND_LIST[f.category]) out.push(`bad_category: «${f.category}»`);
    else if (!isClaimKindFor(f.category, f.claim_kind)) out.push(`bad_claim_kind: «${f.claim_kind}» не з закритого списку категорії ${f.category}`);
  }
  return [...new Set(out)];
}

/** Один крок агента (цикл, локатори й кодовий фільтр дій G0-11 — sl-core-engineer; тут лише промпт, схема, семантична перевірка). */
export async function agentTurn(ctx: StageContext, input: AgentTurnInput): Promise<StageResult<{ turn: AgentTurnLlm; target: SemanticTarget | null; prompt_id: string }>> {
  return guardStage("browser_sessions", browserAgentV1.id, ctx, async () => {
    const req = buildRequest({
      stage: "browser_sessions", prompt: browserAgentV1, max_tokens: 1500, images: input.image ? [input.image] : [],
      vars: {
        LANGUAGE: ctx.language, LANGUAGE_NAME: LANG_NAME[ctx.language], CATEGORIES: CATEGORIES.join(", "), CLAIM_KINDS: JSON.stringify(CLAIM_KIND_LIST),
        LENS_DATA: wrapDerivedData(JSON.stringify(input.lens, null, 1)), TASK_DATA: wrapDerivedData(JSON.stringify(input.task, null, 1)),
        REMAINING: String(input.remaining), CURRENT_URL: input.page.url, HISTORY_DATA: wrapDerivedData(JSON.stringify(input.history, null, 1)),
        A11Y_DATA: wrapDerivedData(input.a11y_outline), PAGE_DATA: wrapPageData([input.page]),
      },
      logical: { page_url: input.page.url, lens_id: input.lens.id, task_id: input.task.id, step: input.step },
    });
    const r = await ctx.client.call(req, AgentTurnLlm, (v) => validateAgentTurn(v, input.page, input.remaining));
    return done("browser_sessions", browserAgentV1.id, { turn: r.value, target: parseSemanticTarget(r.value.step.target), prompt_id: browserAgentV1.id }, r.calls);
  });
}
