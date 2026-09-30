import { createHash } from "node:crypto";
import type { BehavioralLens } from "@sitelens/schemas";
import { snapshotEvaluatorV1 } from "../../prompts/snapshot-evaluator-v1.js";
import { guardText } from "../guards/report-guard.js";
import { findInjectionEcho, findWrongLanguage, type Issue } from "../guards/text.js";
import { pageCorpus, wrapDerivedData, wrapPageData, type PageInput } from "../page-input.js";
import { CLAIM_KIND_LIST, SnapshotEvalLlm } from "../sim-schemas.js";
import { CATEGORIES, isClaimKindFor } from "@sitelens/schemas";
import type { ImagePart } from "../types.js";
import { a11yOutlineText, buildRequest, LANG_NAME } from "./prompt-util.js";
import { done, guardStage, type StageContext, type StageResult } from "./types.js";

/** Тайл D4: t0 = перше вікно; далі тайли висотою вікна з перекриттям (`tiles/manifest.json` S1a). Full-page скриншот моделі не віддається. */
export interface TileIn { id: string; y_css: number; height_css: number; image: ImagePart }
export const MAX_TILES_PER_CALL = 5;

export interface TaskBrief { id: string; name: string; goal: string; task_type: string }
export interface SnapshotInput { page: PageInput; lens: BehavioralLens; task: TaskBrief; tiles: readonly TileIn[]; tiles_total: number; a11y_outline: string }

/** Вихід у формі, яку приймає `integrateSessions` (packages/reporting); severity/free-text у скоринг не йдуть (C2) */
export interface SnapshotSessionOut {
  session_id: string; lens_id: string; task_id: string; level: "snapshot";
  success: "true" | "false" | "partial";
  frictions: Array<{ category: (typeof CATEGORIES)[number]; claim_kind: string; severity: "low" | "medium" | "high"; evidence: string; page_url: string }>;
  positive_signals: string[]; uncertainties: string[]; final_summary: string;
  pages_seen: string[];
}

export const sessionId = (...parts: string[]): string => "ses_" + createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
const prose = (v: SnapshotEvalLlm): string[] => [...v.noticed, ...v.understood, ...v.unclear, v.likely_next_action, ...v.positive_signals, ...v.uncertainties, v.final_summary];

/** семантичні правила відповіді (код, а не модель, вирішує, що допустимо; цитати звіряє integrateSessions, §23) */
export function validateSnapshotEval(v: SnapshotEvalLlm, tileIds: readonly string[], page: PageInput, lang: "uk" | "en"): Issue[] {
  const out: Issue[] = [];
  if (v.verdict === "no_issue" && v.frictions.length > 0) out.push("verdict_inconsistent: no_issue, але frictions не порожні");
  if (v.verdict === "issues_found" && v.frictions.length === 0) out.push("verdict_inconsistent: issues_found без жодної friction");
  if (v.verdict === "cannot_judge" && v.frictions.length > 0) out.push("verdict_inconsistent: cannot_judge не поєднується з friction");
  for (const f of v.frictions) {
    if (!tileIds.includes(f.tile_id)) out.push(`dangling_reference: tile_id «${f.tile_id}» не серед наданих тайлів`);
    if (!(CATEGORIES as readonly string[]).includes(f.category) || !CLAIM_KIND_LIST[f.category]) out.push(`bad_category: «${f.category}» немає в списку для LLM`);
    else if (!isClaimKindFor(f.category, f.claim_kind)) out.push(`bad_claim_kind: «${f.claim_kind}» не з закритого списку категорії ${f.category}`);
  }
  const p = prose(v);
  const corpus = pageCorpus(page);
  for (const s of p) { const g = guardText(s, { field: "reason_summary", structural: false, evidence_corpus: corpus }); if (!g.ok) out.push(...g.issues.slice(0, 2)); }
  out.push(...findInjectionEcho(p));
  out.push(...findWrongLanguage([v.final_summary, ...v.noticed], lang));
  return [...new Set(out)];
}

export async function evaluateSnapshot(ctx: StageContext, input: SnapshotInput): Promise<StageResult<{ session: SnapshotSessionOut; verdict: SnapshotEvalLlm["verdict"]; prompt_id: string; /** для перевірок ін'єкції (S7-B): у звіт не йде */ likely_next_action: string }>> {
  return guardStage("snapshot_sessions", snapshotEvaluatorV1.id, ctx, async () => {
    const tiles = input.tiles.slice(0, MAX_TILES_PER_CALL);
    const truncated = input.tiles_total > tiles.length;
    const tileList = tiles.map((t) => `${t.id}\ty=${t.y_css}\theight=${t.height_css}`).join("\n");
    const lensData = wrapDerivedData(JSON.stringify(input.lens, null, 1));
    const req = buildRequest({
      stage: "snapshot_sessions", prompt: snapshotEvaluatorV1, max_tokens: 1800,
      images: tiles.map((t) => t.image),
      vars: {
        LANGUAGE: ctx.language, LANGUAGE_NAME: LANG_NAME[ctx.language], CATEGORIES: CATEGORIES.join(", "), CLAIM_KINDS: JSON.stringify(CLAIM_KIND_LIST),
        LENS_DATA: lensData, TASK_DATA: wrapDerivedData(JSON.stringify(input.task, null, 1)), TILE_LIST: tileList,
        A11Y_DATA: wrapDerivedData(a11yOutlineText(input.a11y_outline)), PAGE_DATA: wrapPageData([input.page]),
      },
      logical: { page_url: input.page.url, lens_id: input.lens.id, task_id: input.task.id, step: 0 },
    });
    if (truncated) req.content.splice(1, 0, { type: "text", text: (snapshotEvaluatorV1.fragments as Record<string, string>)["tiles_truncated"] as string });
    const r = await ctx.client.call(req, SnapshotEvalLlm, (v) => validateSnapshotEval(v, tiles.map((t) => t.id), input.page, ctx.language));
    const v = r.value;
    const path = new URL(input.page.url).pathname;
    const session: SnapshotSessionOut = {
      session_id: sessionId("snapshot", input.lens.id, input.task.id, input.page.url), lens_id: input.lens.id, task_id: input.task.id, level: "snapshot", success: v.success,
      frictions: v.frictions.map((f) => ({ category: f.category, claim_kind: f.claim_kind, severity: f.severity, evidence: f.evidence, page_url: input.page.url })),
      positive_signals: v.positive_signals, uncertainties: [...v.uncertainties, ...(truncated ? ["tiles_truncated"] : [])], final_summary: v.final_summary, pages_seen: [path],
    };
    return done("snapshot_sessions", snapshotEvaluatorV1.id, { session, verdict: v.verdict, prompt_id: snapshotEvaluatorV1.id, likely_next_action: v.likely_next_action }, r.calls, truncated ? ["tiles_truncated"] : []);
  });
}
