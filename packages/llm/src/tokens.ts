import type { LlmRequest } from "./types.js";

/** Детермінована груба оцінка токенів (лише для передперевірки бюджету й scripted fake; живі токени — з usage провайдера) */
export const estimateTextTokens = (s: string): number => Math.ceil(s.length / 3.5);
/** зображення = сталий внесок, не залежить від пікселів (тайл D4 ≈ 1 тис. токенів) */
export const IMAGE_TOKENS_ESTIMATE = 1200;

export function estimateInputTokens(req: LlmRequest): number {
  let n = estimateTextTokens(req.system) + estimateTextTokens(JSON.stringify(req.output.json_schema));
  for (const p of req.content) n += p.type === "text" ? estimateTextTokens(p.text) : IMAGE_TOKENS_ESTIMATE;
  return n;
}
