import { ProviderHttpError } from "../errors.js";
import { estimateInputTokens, estimateTextTokens } from "../tokens.js";
import type { LlmProvider, LlmRequest, ProviderResult } from "../types.js";
import type { AdapterConfig } from "./anthropic.js";
import { isSamplingRejection, postJson } from "./http.js";
import { loadImageB64 } from "./images.js";

/** Спосіб, яким сервер змушується віддати JSON: від найсуворішого до найслабшого (Zod у клієнті перевіряє в усіх випадках) */
export type ChatFormatMode = "json_schema" | "json_object" | "prompted";
const FORMAT_LADDER: readonly ChatFormatMode[] = ["json_schema", "json_object", "prompted"];

/** База може бути `http://host:11434`, `http://host:11434/v1` або з кінцевим `/`; шлях `/v1/<endpoint>` не дублюється */
export function openAiEndpoint(baseUrl: string | undefined, endpoint: "chat/completions" | "responses"): string {
  const b = (baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  return /\/v1$/.test(b) ? `${b}/${endpoint}` : `${b}/v1/${endpoint}`;
}

/** 400/422 від сервера, який не підтримує `response_format` (json_schema або й json_object) — тоді спускаємось на щабель нижче */
export function isFormatRejection(e: unknown): boolean {
  if (!(e instanceof ProviderHttpError) || (e.status !== 400 && e.status !== 422)) return false;
  if (isSamplingRejection(e)) return false;
  const body = String((e as { body?: string }).body ?? e.message);
  return /response_format|json_schema|json_object|structured|grammar|schema|unsupported|not supported|invalid.*format/i.test(body);
}

/** JSON із тексту відповіді: строго; інакше — з огорожі ```json …``` або першого збалансованого `{…}` (моделі на json_object/prompted часто обгортають) */
export function parseJsonLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { /* далі */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()); } catch { /* далі */ } }
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i] as string;
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { break; } }
    }
  }
  return undefined;
}

/**
 * OpenAI-сумісний `/v1/chat/completions` (Ollama, LM Studio, vLLM, llama.cpp server, більшість проксі; DEV-84).
 * Structured output: `response_format = json_schema` (strict) → якщо сервер відхиляє (400/422) — `json_object` + схема в system-повідомленні → якщо й це — лише схема в промпті.
 * Знайдений щабель запам'ятовується на екземплярі (не б'ємо кожен виклик відомо непідтримуваним форматом). Значення відповіді ЗАВЖДИ перевіряє Zod у LlmClient — сервер json_object не гарантує схему.
 * UNVERIFIED на живих серверах: перевірено лише контрактом на мок-HTTP у стилі Ollama/LM Studio (вимагає live pass із реальним сервером/моделлю). Зображення (image_url data URI) потребують vision-моделі.
 */
export class OpenAiChatProvider implements LlmProvider {
  readonly name = "openai" as const;
  readonly model: string;
  /** поточний щабель; лише зростає (json_schema → json_object → prompted) */
  private rung = 0;
  constructor(private readonly c: AdapterConfig) { this.model = c.model; }
  get formatMode(): ChatFormatMode { return FORMAT_LADDER[this.rung] as ChatFormatMode; }

  async buildBody(req: LlmRequest, mode: ChatFormatMode, withTemperature: boolean): Promise<Record<string, unknown>> {
    const parts: unknown[] = [];
    for (const p of req.content) {
      if (p.type === "text") parts.push({ type: "text", text: p.text });
      else parts.push({ type: "image_url", image_url: { url: `data:${p.media_type};base64,${await loadImageB64(p)}` } });
    }
    const schemaNote = `\n\nReply with ONE JSON object only (no prose, no code fences) that conforms to this JSON Schema:\n${JSON.stringify(req.output.json_schema)}`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: mode === "json_schema" ? req.system : req.system + schemaNote },
        { role: "user", content: parts },
      ],
      max_tokens: req.sampling.max_tokens,
      stream: false,
    };
    if (mode === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: req.output.name, schema: req.output.json_schema, strict: true } };
    else if (mode === "json_object") body.response_format = { type: "json_object" };
    if (withTemperature && req.sampling.temperature !== undefined) body.temperature = req.sampling.temperature;
    return body;
  }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    const t0 = Date.now();
    const url = openAiEndpoint(this.c.baseUrl, "chat/completions");
    const headers = { authorization: `Bearer ${this.c.apiKey}` };
    const http = { fetchImpl: this.c.fetchImpl, timeoutMs: this.c.timeoutMs, maxRetries: this.c.maxRetries, sleep: this.c.sleep, secrets: [this.c.apiKey] };
    let dropped = false;
    let withTemp = true;
    let res;
    for (;;) {
      const mode = this.formatMode;
      try {
        res = await postJson(url, headers, await this.buildBody(req, mode, withTemp), http);
        break;
      } catch (e) {
        if (withTemp && req.sampling.temperature !== undefined && isSamplingRejection(e)) { withTemp = false; dropped = true; continue; }
        if (mode !== "prompted" && isFormatRejection(e)) { this.rung++; continue; }
        throw e;
      }
    }
    const j = res.json as { choices?: Array<{ message?: { content?: unknown; refusal?: string | null }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    const msg = Array.isArray(j?.choices) ? j?.choices?.[0]?.message : undefined;
    if (!j || !msg) throw new ProviderHttpError("openai chat: unexpected response shape (no choices[0].message)", res.status, false);
    // content — рядок; деякі сервери віддають масив частин {type:"text", text}
    const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? (msg.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("") : "";
    const parsed = text ? parseJsonLoose(text) : undefined;
    const json: unknown = parsed === undefined ? null : parsed;
    const raw_text = json === null ? (text || msg.refusal || "") : undefined;
    const usageKnown = typeof j.usage?.prompt_tokens === "number" && typeof j.usage?.completion_tokens === "number";
    return {
      json, raw_text,
      input_tokens: usageKnown ? (j.usage?.prompt_tokens as number) : estimateInputTokens(req),
      output_tokens: usageKnown ? (j.usage?.completion_tokens as number) : estimateTextTokens(text),
      provider: "openai", model: this.model, latency_ms: Date.now() - t0, temperature_dropped: dropped,
      ...(usageKnown ? {} : { tokens_estimated: true }),
      provenance: { api: "chat_completions", response_format: this.formatMode, finish_reason: j.choices?.[0]?.finish_reason ?? null },
    };
  }
}
