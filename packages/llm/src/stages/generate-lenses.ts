import type { BehavioralLens } from "@sitelens/schemas";
import { lensGeneratorV1 } from "../../prompts/lens-generator-v1.js";
import { findDemographics, findInjectionEcho, findWrongLanguage, ruleOf, type Issue } from "../guards/text.js";
import { wrapDerivedData } from "../page-input.js";
import { candidateToLens, LENS_CANDIDATES, LENS_MIN, LensCandidate, LensCandidatesLenient, type SiteProfileCore } from "../schemas.js";
import { poleById, selectLenses, clampK, type PoleId, type SelectionResult } from "../lenses/select.js";
import { BudgetExceededError, OutputInvalidError } from "../errors.js";
import { buildRequest, LANG_NAME } from "./prompt-util.js";
import { done, guardStage, type Rejection, type StageContext, type StageResult } from "./types.js";

const lensStrings = (c: LensCandidate) => [c.description, c.primary_goal, ...c.likely_questions, ...c.likely_objections];

/** Один кандидат: Zod + демографія/«% ринку» + ін'єкція + мова. Порожній список = придатний. */
export function validateCandidate(raw: unknown, lang: "uk" | "en"): { ok: true; value: LensCandidate } | { ok: false; issues: Issue[] } {
  const p = LensCandidate.safeParse(raw);
  if (!p.success) {
    return { ok: false, issues: p.error.issues.map((i) => (i.code === "unrecognized_keys" ? `extra_field: ${i.path.join(".")}` : i.code === "invalid_type" && (i as { received?: string }).received === "undefined" ? `missing_field: ${i.path.join(".")}` : `schema: ${i.path.join(".")}: ${i.message}`)) };
  }
  const c = p.data;
  const issues = [...findDemographics([c.name, ...lensStrings(c)]), ...findInjectionEcho(lensStrings(c)), ...findWrongLanguage(lensStrings(c), lang)];
  return issues.length ? { ok: false, issues } : { ok: true, value: c };
}

export interface CandidateSplit { valid: LensCandidate[]; dropped: Rejection[] }
export function splitCandidates(items: readonly unknown[], lang: "uk" | "en"): CandidateSplit {
  const valid: LensCandidate[] = []; const dropped: Rejection[] = []; const ids = new Set<string>();
  items.forEach((it, i) => {
    const r = validateCandidate(it, lang);
    const id = (it as { id?: string } | null)?.id ?? `#${i}`;
    if (!r.ok) { for (const is of r.issues) dropped.push({ rule: ruleOf(is), detail: `${id}: ${is}` }); return; }
    if (ids.has(r.value.id)) { dropped.push({ rule: "duplicate_id", detail: `${id}: id повторюється` }); return; }
    ids.add(r.value.id); valid.push(r.value);
  });
  return { valid, dropped };
}

export interface LensesOutput {
  lenses: BehavioralLens[];
  candidates_total: number;
  candidates_valid: number;
  selection: Pick<SelectionResult, "unmet_poles" | "dropped_duplicates">;
  prompt_id: string;
}

export async function generateLenses(ctx: StageContext, input: { profile: SiteProfileCore; k?: number }): Promise<StageResult<LensesOutput>> {
  return guardStage("lenses", lensGeneratorV1.id, ctx, async () => {
    const k = clampK(input.k);
    const profileData = wrapDerivedData(JSON.stringify(input.profile, null, 1));
    const ask = (extra: string, step: number) => buildRequest({
      stage: "lenses", prompt: lensGeneratorV1, max_tokens: 8000,
      vars: { LANGUAGE: ctx.language, LANGUAGE_NAME: LANG_NAME[ctx.language], PROFILE_DATA: profileData, COUNT: String(LENS_CANDIDATES), EXTRA_POLES: extra },
      logical: { step },
    });
    const call = async (extra: string, step: number) => ctx.client.call(ask(extra, step), LensCandidatesLenient, (v) => {
      const s = splitCandidates(v.lenses, ctx.language);
      return s.valid.length >= LENS_MIN ? [] : [`too_few_valid_candidates: ${s.valid.length} < ${LENS_MIN}`, ...s.dropped.slice(0, 8).map((d) => d.detail)];
    });
    const first = await call("", 0);
    const s1 = splitCandidates(first.value.lenses, ctx.language);
    let rejected = [...s1.dropped];
    let valid = s1.valid;
    const calls = [...first.calls];
    const build = (cs: LensCandidate[]) => {
      const fl: string[] = [];
      const lenses = cs.map((c) => { const r = candidateToLens(c, ctx.audit_run_id); fl.push(...r.flags); return r.lens; });
      return { lenses, fl };
    };
    let pool = build(valid);
    let sel = selectLenses(pool.lenses, k);
    const extra: string[] = [];
    if (sel.unmet_poles.length > 0) {
      // §9.4: один раз попросити генератор про відсутні полюси; знову ні — найближчий кандидат + прапорець
      const want = sel.unmet_poles.map((id) => poleById(id as PoleId).name).join(", ");
      try {
        const second = await call(`The previous set lacked these behavioral poles: ${want}. Generate 6 additional candidate lenses (ids l19, l20, ...) covering ONLY these poles.`, 1);
        calls.push(...second.calls);
        const s2 = splitCandidates(second.value.lenses, ctx.language);
        rejected = [...rejected, ...s2.dropped];
        const have = new Set(valid.map((c) => c.id));
        valid = [...valid, ...s2.valid.filter((c) => !have.has(c.id))];
        pool = build(valid);
        sel = selectLenses(pool.lenses, k);
        extra.push("poles_requested_again");
      } catch (e) {
        if (e instanceof BudgetExceededError) extra.push("poles_request_skipped_budget");
        else if (e instanceof OutputInvalidError) extra.push("poles_request_invalid");
        else throw e;
      }
    }
    const dedupUnique = [...new Set([...pool.fl, ...extra, ...sel.flags])];
    return done("lenses", lensGeneratorV1.id, {
      lenses: sel.selected, candidates_total: first.value.lenses.length, candidates_valid: valid.length,
      selection: { unmet_poles: sel.unmet_poles, dropped_duplicates: sel.dropped_duplicates }, prompt_id: lensGeneratorV1.id,
    }, calls, dedupUnique, rejected);
  });
}
