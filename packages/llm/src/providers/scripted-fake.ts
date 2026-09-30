import { ReplayMissError } from "../errors.js";
import { estimateTextTokens } from "../tokens.js";
import type { LlmProvider, LlmRequest, LogicalKey, ProviderResult } from "../types.js";

/** Логічний ключ (G0-16 а): prompt_id + page_url + lens_id + task_id + номер кроку (+ repair-спроба). Пікселі й текст промпту не входять. */
export function logicalKeyString(k: LogicalKey): string {
  return [k.prompt_id, k.page_url ?? "", k.lens_id ?? "", k.task_id ?? "", String(k.step ?? 0)].join("|") + (k.attempt ? `#r${k.attempt}` : "");
}

export interface ScriptEntry { response: unknown; input_tokens?: number; output_tokens?: number; raw_text?: string }

/**
 * Scripted fake provider для тестів. Відповіді — `synthetic: true`. Промах = гучна помилка (жодного фолбеку).
 * Свідомо НЕ читає ImagePart: два запити, що відрізняються лише байтами скриншота, отримують ту саму відповідь.
 */
export class ScriptedFakeProvider implements LlmProvider {
  readonly name = "fake" as const;
  readonly model = "scripted-fake";
  readonly received: string[] = [];
  constructor(private readonly script: Map<string, ScriptEntry>) {}

  static from(entries: Array<[LogicalKey, ScriptEntry]>): ScriptedFakeProvider {
    return new ScriptedFakeProvider(new Map(entries.map(([k, v]) => [logicalKeyString(k), v])));
  }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    const key = logicalKeyString(req.logical_key);
    this.received.push(key);
    const e = this.script.get(key);
    if (!e) throw new ReplayMissError(`scripted fake: немає відповіді для логічного ключа «${key}»`, key);
    const textIn = req.system + req.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    return {
      json: e.raw_text !== undefined ? null : e.response,
      raw_text: e.raw_text,
      input_tokens: e.input_tokens ?? estimateTextTokens(textIn),
      output_tokens: e.output_tokens ?? estimateTextTokens(JSON.stringify(e.response ?? e.raw_text)),
      provider: "fake", model: this.model, latency_ms: 0, synthetic: true,
    };
  }
}
