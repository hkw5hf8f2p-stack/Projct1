import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cacheKey } from "../cache.js";
import { sha256 } from "../canonical.js";
import { ConfigError, SessionAwaitingError } from "../errors.js";
import { estimateTextTokens, IMAGE_TOKENS_ESTIMATE } from "../tokens.js";
import type { ImagePart, LlmProvider, LlmRequest, ProviderResult } from "../types.js";
import { loadImageB64 } from "./images.js";

/**
 * Транспорт `session` (S7 без API-ключа, DEV-81): моделлю виступає Claude у сесії оркестратора, відповіді дають «сліпі» агенти.
 * Двофазний, БЕЗ МЕРЕЖІ:
 *  - промах (відповіді немає) → запит пишеться в `<root>/requests/<request_id>.json` (+ зображення в `requests/img/`) і кидається
 *    `SessionAwaitingError` → етап отримує статус `awaiting_session_model` (не completed);
 *  - відповідь є (`<root>/responses/<request_id>.json`, сирий текст моделі) → повертається як ProviderResult.raw_text/json, далі ТА САМА
 *    обробка, що й для API: `LlmClient.call` (JSON parse → Zod → semantic/guard → один repair-повтор → запис у кеш E5 із provenance).
 * Ключ запиту — той самий E5 (`cacheKey`, ідентичність {provider:"session", model:SESSION_MODEL_NAME}). Репетити repair = інший вміст → інший ключ (attempt=2).
 * Сценарій/namespace у файл запиту НЕ пишуться (сліпота E3c): вони лише в `<root>/index.json`, який відповідач не читає.
 */
export const SESSION_ANSWERED_BY = "blind-subagent";
export const SESSION_BANNER = "модель: Claude у сесії, без API; ціна — ⏭️";
export const DEFAULT_NAMESPACE = "s7";

export interface SessionProviderOptions {
  /** корінь обміну: requests/, responses/, index.json */
  root: string;
  /** SESSION_MODEL_NAME (входить у ключ E5) */
  model: string;
  namespace: string;
  /** мітка сценарію — лише для index.json */
  scenario?: string;
  language?: "uk" | "en";
  now?: () => Date;
}

export interface SessionRequestFile {
  schema: "sitelens-s7-request/v1";
  request_id: string;
  /** повний ключ E5 */
  key: string;
  attempt: 1 | 2;
  prompt_id: string;
  prompt_version: string;
  language: "uk" | "en" | null;
  system: string;
  /** user-повідомлення: текстові частини за порядком; зображення — маркер `[image: img/<файл>]` на своєму місці */
  user: string;
  /** шляхи відносно requests/ (відповідач читає лише requests/) */
  images: string[];
  response_json_schema: Record<string, unknown>;
  output_name: string;
  output_description: string;
  max_tokens: number;
  answer_instructions: string;
}

/** id запиту: ключ E5; для namespace, відмінного від типового, — `<key>__<6 hex sha256(namespace)>` (E2: три прогони мають окремі відповіді) */
export const requestId = (key: string, namespace: string): string => (namespace === DEFAULT_NAMESPACE ? key : `${key}__${sha256(namespace).slice(0, 6)}`);

const promptVersion = (id: string): string => /-(v\d+)$/.exec(id)?.[1] ?? "unversioned";
const extOf = (p: ImagePart): string => (p.media_type === "image/jpeg" ? "jpg" : "png");

const ANSWER_INSTRUCTIONS =
  "Reply with EXACTLY ONE JSON object that validates against response_json_schema: no prose, no markdown fences, no comments. " +
  "Use only the material in this file and in the listed images. Finding no issue is a valid result.";

export interface IndexEntry {
  request_id: string; key: string; namespace: string; scenarios: string[]; prompt_id: string; attempt: number; images: string[]; created_at: string;
}
export const indexPath = (root: string): string => path.join(root, "index.json");
export function readIndex(root: string): { requests: Record<string, IndexEntry> } {
  const f = indexPath(root);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { requests: Record<string, IndexEntry> }) : { requests: {} };
}
function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export class SessionProvider implements LlmProvider {
  readonly name = "session" as const;
  readonly model: string;
  /** запити, записані цим екземпляром (для звітів export) */
  readonly written: string[] = [];
  constructor(private readonly o: SessionProviderOptions) {
    if (!o.model) throw new ConfigError("session: SESSION_MODEL_NAME не задано (входить у ключ E5)");
    this.model = o.model;
  }

  get requestsDir(): string { return path.join(this.o.root, "requests"); }
  get responsesDir(): string { return path.join(this.o.root, "responses"); }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    const key = cacheKey({ provider: "session", model: this.model }, req);
    const id = requestId(key, this.o.namespace);
    const attempt = (req.logical_key.attempt ?? 0) + 1 === 2 ? 2 : 1;
    const respFile = path.join(this.responsesDir, `${id}.json`);
    if (!existsSync(respFile)) {
      const file = await this.writeRequest(req, key, id, attempt);
      throw new SessionAwaitingError(id, key, attempt, file);
    }
    const t0 = Date.now();
    const raw = readFileSync(respFile, "utf8");
    let json: unknown = null;
    try { json = JSON.parse(raw.trim()); } catch { json = null; } // як API без tool_use: невалідний JSON → raw_text → repair
    const inTok = (await this.inputTokens(req));
    const outTok = estimateTextTokens(raw);
    return {
      json, raw_text: json === null ? raw : undefined, input_tokens: inTok, output_tokens: outTok, provider: "session", model: this.model,
      latency_ms: Date.now() - t0, synthetic: false, tokens_estimated: true,
      provenance: { provider: "session", model: this.model, answered_by: SESSION_ANSWERED_BY, synthetic: false, tokens_estimated: true, request_id: id, response_sha256: sha256(raw), attempt },
    };
  }

  private async inputTokens(req: LlmRequest): Promise<number> {
    let n = estimateTextTokens(req.system) + estimateTextTokens(JSON.stringify(req.output.json_schema));
    for (const p of req.content) n += p.type === "text" ? estimateTextTokens(p.text) : IMAGE_TOKENS_ESTIMATE;
    return n;
  }

  private async writeRequest(req: LlmRequest, key: string, id: string, attempt: 1 | 2): Promise<string> {
    const file = path.join(this.requestsDir, `${id}.json`);
    const images: string[] = [];
    const parts: string[] = [];
    for (const p of req.content) {
      if (p.type === "text") { parts.push(p.text); continue; }
      const rel = `img/${p.sha256}.${extOf(p)}`;
      const abs = path.join(this.requestsDir, rel);
      if (!existsSync(abs)) {
        mkdirSync(path.dirname(abs), { recursive: true });
        if (p.path) {
          await loadImageB64(p); // звіряє sha256 із заявленим: запит не може «підмінити» картинку
          copyFileSync(p.path, abs);
        } else if (p.data_b64) writeFileSync(abs, Buffer.from(p.data_b64, "base64"));
        else throw new ConfigError(`session: зображення ${p.sha256.slice(0, 8)} без байтів (path/data_b64) — експортувати нічого; потрібні справжні скриншоти`);
      }
      images.push(rel);
      parts.push(`[image: ${rel}${p.label ? ` — ${p.label}` : ""}]`);
    }
    const body: SessionRequestFile = {
      schema: "sitelens-s7-request/v1", request_id: id, key, attempt, prompt_id: req.prompt_id, prompt_version: promptVersion(req.prompt_id),
      language: this.o.language ?? null, system: req.system, user: parts.join("\n\n"), images, response_json_schema: req.output.json_schema,
      output_name: req.output.name, output_description: req.output.description, max_tokens: req.sampling.max_tokens, answer_instructions: ANSWER_INSTRUCTIONS,
    };
    if (!existsSync(file)) writeAtomic(file, JSON.stringify(body, null, 2) + "\n");
    this.written.push(id);
    const idx = readIndex(this.o.root);
    const prev = idx.requests[id];
    const scenario = this.o.scenario ?? "unknown";
    idx.requests[id] = prev
      ? { ...prev, scenarios: [...new Set([...prev.scenarios, scenario])] }
      : { request_id: id, key, namespace: this.o.namespace, scenarios: [scenario], prompt_id: req.prompt_id, attempt, images, created_at: (this.o.now?.() ?? new Date()).toISOString() };
    writeAtomic(indexPath(this.o.root), JSON.stringify(idx, null, 1) + "\n");
    return file;
  }
}
