import { canonicalJson, sha256 } from "../src/canonical.js";
import { lensGeneratorV1 } from "./lens-generator-v1.js";
import { siteProfileV1 } from "./site-profile-v1.js";
import { taskGeneratorV1 } from "./task-generator-v1.js";
import { snapshotEvaluatorV1 } from "./snapshot-evaluator-v1.js";
import { browserAgentV1 } from "./browser-agent-v1.js";
import { findingAggregatorV1 } from "./finding-aggregator-v1.js";
import { recommendationV1 } from "./recommendation-v1.js";
import { REPAIR_TEMPLATE } from "./common.js";
import type { PromptDef } from "./types.js";

export type { PromptDef };
export { lensGeneratorV1, siteProfileV1, taskGeneratorV1, snapshotEvaluatorV1, browserAgentV1, findingAggregatorV1, recommendationV1 };
export const PROMPTS: readonly PromptDef[] = [siteProfileV1, taskGeneratorV1, lensGeneratorV1, snapshotEvaluatorV1, browserAgentV1, findingAggregatorV1, recommendationV1];

/** хеш усього, що впливає на поведінку промпту: system, шаблон користувача, fragments, repair-текст, ім'я й JSON-схема виходу */
export const promptHash = (p: PromptDef): string =>
  sha256(canonicalJson({ id: p.id, system: p.system, user_template: p.user_template, output_name: p.output_name, fragments: p.fragments ?? null, repair: REPAIR_TEMPLATE, json_schema: p.json_schema }));

export interface LockFile { note: string; prompts: Record<string, string> }

/**
 * Порушення lock (SPEC §52): (1) той самий id має інший хеш — текст змінено без нової версії;
 * (2) промпт відсутній у lock (новий id треба додати `pnpm llm:prompts:lock`); (3) id у lock без промпту (видалено).
 */
export function checkPromptLock(prompts: readonly PromptDef[], lock: LockFile): string[] {
  const out: string[] = [];
  for (const p of prompts) {
    const want = lock.prompts[p.id];
    const got = promptHash(p);
    if (!want) out.push(`${p.id}: немає в prompts.lock.json (додай через llm:prompts:lock)`);
    else if (want !== got) out.push(`${p.id}: текст змінено без зміни версії (lock ${want.slice(0, 12)}… ≠ ${got.slice(0, 12)}…) — підніми версію (…-v2)`);
  }
  for (const id of Object.keys(lock.prompts)) if (!prompts.some((p) => p.id === id)) out.push(`${id}: є в lock, але промпту немає`);
  return out;
}

export function getPrompt(id: string): PromptDef {
  const p = PROMPTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown prompt ${id}`);
  return p;
}
