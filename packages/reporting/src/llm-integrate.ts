/**
 * Інтеграція результатів LLM-сесій (SPEC §22–§24; SYNTHETIC) у вхід buildReport. Числа тут не ставляться (C2): лише
 * докази й `SessionObs`. Правило §23: friction без ДОКАЗУ відкидається, і його ключ не потрапляє у покриття.
 * Доказ friction (формат задає промпт): дослівна цитата в лапках ("…" / «…») — код звіряє її з видимим текстом
 * сторінки цієї friction; або `NOT_FOUND: <чого бракує>` (твердження відсутності; лише для сторінки, яку захоплено);
 * усе інше — «немає перевірюваного доказу». Невідома сторінка → відкидається.
 */
import { createHash } from "node:crypto";
import { CATEGORIES, Evidence, buildFindingKey, isClaimKindFor, type SyntheticSession } from "@sitelens/schemas";
import { norm } from "@sitelens/llm";
import type { SessionObs } from "@sitelens/scoring";
import type { LlmResults, PageIn, VP } from "./types.js";

type Friction = SyntheticSession["frictions"][number];
export interface FrictionIn extends Friction { /** закритий список на категорію (SCORING_SPEC §5); інакше `general` */ claim_kind?: string }
export interface SessionResultIn {
  session_id: string; lens_id: string; task_id: string; level: "snapshot" | "journey";
  success: "true" | "false" | "partial";
  frictions: FrictionIn[];
  /** шляхи сторінок, які сесія бачила (журнал / тайли) */
  pages_seen: string[];
}
export type FrictionRejectReason = "unknown_page" | "no_verifiable_evidence" | "quote_not_on_page" | "page_not_captured";
export interface IntegrationRejection { session_id: string; index: number; reason: FrictionRejectReason }
export interface Integration { evidence: Evidence[]; sessions: SessionObs[]; rejected: IntegrationRejection[] }

export const pageGroupOf = (type: string, p: string): string => (type === "product" || type === "category" ? type : p.replace(/(.)\/$/, "$1"));
const QUOTE_RE = /"([^"]{3,300})"|«([^»]{3,300})»|“([^”]{3,300})”/gu;
const NOT_FOUND_RE = /^\s*NOT_FOUND\s*:\s*\S/u;

export function extractQuotes(evidence: string): string[] {
  return [...evidence.matchAll(QUOTE_RE)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

const pageCorpusOf = (p: PageIn): string => norm(Object.values(p.captures).map((c) => c?.visible_text ?? "").join("\n"));

export function integrateSessions(input: { sessions: readonly SessionResultIn[]; pages: readonly PageIn[] }): Integration {
  const byPath = new Map(input.pages.map((p) => [p.path, p]));
  const evidence = new Map<string, Evidence>();
  const rejected: IntegrationRejection[] = [];
  const obs: SessionObs[] = [];
  for (const s of input.sessions) {
    const keys: string[] = [];
    s.frictions.forEach((f, index) => {
      const path = (() => { try { return new URL(f.page_url, "http://x.invalid").pathname; } catch { return null; } })();
      const page = path === null ? undefined : byPath.get(path);
      if (!page) return void rejected.push({ session_id: s.session_id, index, reason: "unknown_page" });
      const captured = (["D", "M"] as const).some((vp) => page.capture[vp]?.capture_complete !== undefined);
      const quotes = extractQuotes(f.evidence);
      let excerpt: string | undefined;
      if (quotes.length > 0) {
        const corpus = pageCorpusOf(page);
        if (!quotes.every((q) => corpus.includes(norm(q)))) return void rejected.push({ session_id: s.session_id, index, reason: "quote_not_on_page" });
        excerpt = quotes[0];
      } else if (NOT_FOUND_RE.test(f.evidence)) {
        if (!captured) return void rejected.push({ session_id: s.session_id, index, reason: "page_not_captured" });
      } else return void rejected.push({ session_id: s.session_id, index, reason: "no_verifiable_evidence" });
      const category = f.category as (typeof CATEGORIES)[number];
      const claim = f.claim_kind && isClaimKindFor(category, f.claim_kind) ? f.claim_kind : "general";
      const group = pageGroupOf(page.page_type, page.path);
      const vp: VP = page.screenshot.D ? "D" : "M";
      const ref = page.screenshot[vp] ?? "pages.json";
      const id = "ev_" + createHash("sha256").update([s.session_id, category, page.path, f.evidence].join("\u0000")).digest("hex").slice(0, 12);
      const vpSize = page.viewport[vp];
      evidence.set(id, Evidence.parse({
        id, type: s.level === "journey" ? "browser_session" : "repeated_agent_observation", source_class: "SYNTHETIC",
        page_url: page.url, page_path: page.path, page_type: page.page_type, page_group: group, category, claim_kind: claim,
        description: "agent observation", artifact_reference: ref, screenshot_reference: ref,
        selector_or_region: vpSize ? { region: { x: 0, y: 0, w: vpSize.w, h: vpSize.h }, coord: "css_px_viewport" } : { selector: "body" },
        self_confirming: false, session_id: s.session_id, lens_id: s.lens_id, task_id: s.task_id, level: s.level,
        ...(excerpt ? { excerpt } : {}),
      }));
      keys.push(buildFindingKey({ category, page_group: group, claim_kind: claim }));
    });
    const uniq = [...new Set(keys)].sort();
    obs.push({ session_id: s.session_id, lens_id: s.lens_id, task_id: s.task_id, level: s.level, success: s.success, pages_seen: [...new Set(s.pages_seen)].sort(), reported_keys: uniq, last_friction_key: keys.length ? (keys[keys.length - 1] as string) : null });
  }
  return { evidence: [...evidence.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), sessions: obs, rejected };
}

/** мінімальний LlmResults для звіту з результатів сесій (решту етапів — профіль, лінзи — додає викликач) */
export function llmResultsFromSessions(i: Integration, o: { mode: LlmResults["mode"]; provider: LlmResults["provider"]; model: string; prompt_versions: string[]; llm_calls: number; used_tokens: number }): LlmResults {
  return {
    mode: o.mode, provider: o.provider, model: o.model, prompt_versions: o.prompt_versions,
    evidence: i.evidence, evidence_text: {}, sessions: i.sessions, finding_texts: {}, site_understanding: null, primary_conversion_goal: null, summary: null,
    lenses: [], pole_unmet: [],
    budget: { max_audit_tokens: 1_650_000, used_tokens: o.used_tokens, billed_tokens: 0, cache_read_tokens: 0, llm_calls: o.llm_calls, cost: null },
  };
}
