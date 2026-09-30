import { ProviderHttpError } from "../errors.js";
import type { LlmProvider, LlmRequest, ProviderResult } from "../types.js";
import type { AdapterConfig } from "./anthropic.js";
import { isSamplingRejection, postJson } from "./http.js";
import { loadImageB64 } from "./images.js";
import { openAiEndpoint } from "./openai-chat.js";

/**
 * OpenAI Responses API (SPEC §6; `OPENAI_API_MODE=responses`, типово для api.openai.com; для сумісних серверів типовий режим — chat completions, див. openai-chat.ts): `text.format = json_schema` (strict). Автентифікація — Bearer з env.
 * UNVERIFIED до живого виклику: strict-режим схеми, поведінка `temperature` на reasoning-моделях.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = "openai" as const;
  readonly model: string;
  constructor(private readonly c: AdapterConfig) { this.model = c.model; }

  async buildBody(req: LlmRequest, withTemperature: boolean): Promise<Record<string, unknown>> {
    const content: unknown[] = [];
    for (const p of req.content) {
      if (p.type === "text") content.push({ type: "input_text", text: p.text });
      else content.push({ type: "input_image", image_url: `data:${p.media_type};base64,${await loadImageB64(p)}` });
    }
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: req.system,
      input: [{ role: "user", content }],
      max_output_tokens: req.sampling.max_tokens,
      text: { format: { type: "json_schema", name: req.output.name, schema: req.output.json_schema, strict: true } },
    };
    if (withTemperature && req.sampling.temperature !== undefined) body.temperature = req.sampling.temperature;
    return body;
  }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    const t0 = Date.now();
    const url = openAiEndpoint(this.c.baseUrl, "responses");
    const headers = { authorization: `Bearer ${this.c.apiKey}` };
    const http = { fetchImpl: this.c.fetchImpl, timeoutMs: this.c.timeoutMs, maxRetries: this.c.maxRetries, sleep: this.c.sleep, secrets: [this.c.apiKey] };
    let dropped = false;
    let res;
    try {
      res = await postJson(url, headers, await this.buildBody(req, true), http);
    } catch (e) {
      if (req.sampling.temperature !== undefined && isSamplingRejection(e)) {
        dropped = true;
        res = await postJson(url, headers, await this.buildBody(req, false), http);
      } else throw e;
    }
    const j = res.json as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } } | null;
    if (!j || !Array.isArray(j.output)) throw new ProviderHttpError("openai: unexpected response shape", res.status, false);
    const text = j.output.flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
    let json: unknown = null;
    let raw_text: string | undefined;
    try { json = JSON.parse(text); } catch { raw_text = text; }
    return {
      json, raw_text,
      input_tokens: j.usage?.input_tokens ?? 0,
      output_tokens: j.usage?.output_tokens ?? 0,
      provider: "openai", model: this.model, latency_ms: Date.now() - t0, temperature_dropped: dropped,
    };
  }
}
