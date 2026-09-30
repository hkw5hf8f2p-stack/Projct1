import { ProviderHttpError } from "../errors.js";
import type { LlmProvider, LlmRequest, ProviderResult, FetchLike } from "../types.js";
import { isSamplingRejection, postJson } from "./http.js";
import { loadImageB64 } from "./images.js";

export interface AdapterConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Anthropic Messages API: structured output через tool use (один інструмент, tool_choice = він).
 * UNVERIFIED до першого живого виклику (OQ-1): версія заголовка, поведінка `temperature` на моделях Opus 5/5.5, Sonnet 5.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  constructor(private readonly c: AdapterConfig) { this.model = c.model; }

  async buildBody(req: LlmRequest, withTemperature: boolean): Promise<Record<string, unknown>> {
    const content: unknown[] = [];
    for (const p of req.content) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      else content.push({ type: "image", source: { type: "base64", media_type: p.media_type, data: await loadImageB64(p) } });
    }
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.sampling.max_tokens,
      system: req.system,
      messages: [{ role: "user", content }],
      tools: [{ name: req.output.name, description: req.output.description, input_schema: req.output.json_schema }],
      tool_choice: { type: "tool", name: req.output.name },
    };
    if (withTemperature && req.sampling.temperature !== undefined) body.temperature = req.sampling.temperature;
    return body;
  }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    const t0 = Date.now();
    const url = `${(this.c.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
    const headers = { "x-api-key": this.c.apiKey, "anthropic-version": "2023-06-01" };
    const http = { fetchImpl: this.c.fetchImpl, timeoutMs: this.c.timeoutMs, maxRetries: this.c.maxRetries, sleep: this.c.sleep, secrets: [this.c.apiKey] };
    let dropped = false;
    let res;
    try {
      res = await postJson(url, headers, await this.buildBody(req, true), http);
    } catch (e) {
      if (req.sampling.temperature !== undefined && isSamplingRejection(e)) {
        dropped = true; // G0-27: повтор без temperature
        res = await postJson(url, headers, await this.buildBody(req, false), http);
      } else throw e;
    }
    const j = res.json as { content?: Array<{ type: string; input?: unknown; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } | null;
    if (!j || !Array.isArray(j.content)) throw new ProviderHttpError("anthropic: unexpected response shape", res.status, false);
    const tool = j.content.find((b) => b.type === "tool_use");
    const text = j.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return {
      json: tool ? tool.input : null,
      raw_text: tool ? undefined : text,
      input_tokens: j.usage?.input_tokens ?? 0,
      output_tokens: j.usage?.output_tokens ?? 0,
      provider: "anthropic", model: this.model, latency_ms: Date.now() - t0, temperature_dropped: dropped,
    };
  }
}
