import { CATEGORIES, numberViolations, placeholders } from "@sitelens/schemas";
import { findingAggregatorV1 } from "../../prompts/finding-aggregator-v1.js";
import { recommendationV1 } from "../../prompts/recommendation-v1.js";
import { guardText } from "../guards/report-guard.js";
import { findInjectionEcho, type Issue } from "../guards/text.js";
import { wrapDerivedData } from "../page-input.js";
import { FINDING_PLACEHOLDERS, FindingTextLlm, RecommendationLlm } from "../sim-schemas.js";
import { buildRequest, LANG_NAME } from "./prompt-util.js";
import { done, guardStage, type StageContext, type StageResult } from "./types.js";

/** Група, згрупована КОДОМ за finding_key (SCORING_SPEC §5); модель лише формулює текст */
export interface FindingGroupIn {
  finding_key: string; category: (typeof CATEGORIES)[number]; page_group: string; claim_kind: string; pages: string[];
  /** сухі факти від коду (без чисел, які модель мала б повторити) */
  facts: string[];
  /** дослівні цитати доказів */
  quotes: string[];
}
export interface FindingTexts { title: string; problem: string; why_it_matters: string; recommended_change: string; how_to_validate: string; prompt_ids: string[] }

/** структурне правило (без цифр і числівників, лише дозволені плейсхолдери) + лексичний guard: порушення → repair-повтор клієнта */
export function validateTextFields(fields: Record<string, string>): Issue[] {
  const out: Issue[] = [];
  const allowed = new Set<string>(FINDING_PLACEHOLDERS);
  for (const [k, t] of Object.entries(fields)) {
    for (const v of numberViolations(t, true)) out.push(`structural_number: ${k}: ${v.kind} «${v.span}» — числа лише плейсхолдерами`);
    for (const p of placeholders(t)) if (!allowed.has(p)) out.push(`bad_placeholder: ${k}: {${p}} не дозволено`);
    if (/[{}]/.test(t.replace(/\{[a-z][a-z0-9_]*\}/g, ""))) out.push(`bad_placeholder: ${k}: зайві фігурні дужки`);
    const g = guardText(t.replace(/\{[a-z][a-z0-9_]*\}/g, " "), { field: "finding_text", structural: false });
    if (!g.ok) out.push(...g.issues.slice(0, 2).map((i) => `${k}: ${i}`));
    out.push(...findInjectionEcho([t]));
  }
  return [...new Set(out)];
}

/**
 * Тексти знахідок: finding-aggregator-v1 (заголовок, проблема, чому важливо) → recommendation-v1 (зміна, перевірка) — лише для `supported`.
 * Без звіту знахідка не існує: викликач передає лише групи, що вже мають докази; рекомендацію без групи створити неможливо.
 * Групи з `not_supported` лишаються без LLM-тексту (buildReport підставить шаблон коду).
 */
export async function writeFindingTexts(ctx: StageContext, groups: readonly FindingGroupIn[]): Promise<StageResult<{ texts: Record<string, FindingTexts>; not_supported: string[] }>> {
  return guardStage("aggregate", findingAggregatorV1.id, ctx, async () => {
    const texts: Record<string, FindingTexts> = {};
    const notSupported: string[] = [];
    const calls: StageResult<unknown>["calls"] = [];
    const ph = FINDING_PLACEHOLDERS.map((p) => `{${p}}`).join(", ");
    for (const g of [...groups].sort((a, b) => (a.finding_key < b.finding_key ? -1 : 1))) {
      const base = { LANGUAGE: ctx.language, LANGUAGE_NAME: LANG_NAME[ctx.language], PLACEHOLDERS: ph };
      const r1 = await ctx.client.call(
        buildRequest({ stage: "aggregate", prompt: findingAggregatorV1, max_tokens: 900, vars: { ...base, GROUP_DATA: wrapDerivedData(JSON.stringify(g, null, 1)) }, logical: { task_id: `finding:${g.finding_key}`, step: 0 } }),
        FindingTextLlm,
        (v) => (v.verdict === "supported" ? [...(v.title && v.problem ? [] : ["missing_text: supported потребує title і problem"]), ...validateTextFields({ title: v.title, problem: v.problem, why_it_matters: v.why_it_matters })] : []),
      );
      calls.push(...r1.calls);
      if (r1.value.verdict === "not_supported") { notSupported.push(g.finding_key); continue; }
      const r2 = await ctx.client.call(
        buildRequest({ stage: "aggregate", prompt: recommendationV1, max_tokens: 900, vars: { ...base, FINDING_DATA: wrapDerivedData(JSON.stringify({ ...g, problem: r1.value.problem }, null, 1)) }, logical: { task_id: `finding:${g.finding_key}`, step: 1 } }),
        RecommendationLlm,
        (v) => (v.verdict === "supported" ? [...(v.recommended_change && v.how_to_validate ? [] : ["missing_text: supported потребує обох полів"]), ...validateTextFields({ recommended_change: v.recommended_change, how_to_validate: v.how_to_validate })] : []),
      );
      calls.push(...r2.calls);
      texts[g.finding_key] = {
        title: r1.value.title, problem: r1.value.problem, why_it_matters: r1.value.why_it_matters,
        recommended_change: r2.value.verdict === "supported" ? r2.value.recommended_change : "", how_to_validate: r2.value.verdict === "supported" ? r2.value.how_to_validate : "",
        prompt_ids: [findingAggregatorV1.id, recommendationV1.id],
      };
    }
    return done("aggregate", findingAggregatorV1.id, { texts, not_supported: notSupported }, calls);
  });
}
