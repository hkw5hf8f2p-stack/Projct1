import type { z } from "zod";
import type { AuditStage as AuditStageZ, StageStatus as StageStatusZ } from "@sitelens/schemas";

export type AuditStage = z.infer<typeof AuditStageZ>;
/** `awaiting_session_model` — лише транспорт `session` (S7 без API): запит записано у requests/, відповіді ще немає. НЕ completed; у схему AuditRun/Report не потрапляє (DEV-81). */
export type StageStatus = z.infer<typeof StageStatusZ> | "awaiting_session_model";

export interface TextPart { type: "text"; text: string }
/** зображення: у запиті/ключі кешу — лише sha256 і тип; байти читає адаптер із `path`/`data_b64` в момент відправки */
export interface ImagePart { type: "image"; sha256: string; media_type: "image/png" | "image/jpeg"; path?: string; data_b64?: string; label?: string }
export type ContentPart = TextPart | ImagePart;

/** Логічний ключ scripted fake (G0-16 а): не залежить від пікселів і від тексту промпту */
export interface LogicalKey {
  prompt_id: string;
  page_url?: string;
  lens_id?: string;
  task_id?: string;
  step?: number;
  /** 0 = основний виклик, 1 = repair-повтор */
  attempt?: number;
}

/** Параметри семплінгу. temperature/top_p за замовчуванням НЕ надсилаються (G0-27; «400» — unverified) */
export interface Sampling { max_tokens: number; temperature?: number }

export interface LlmRequest {
  stage: AuditStage;
  prompt_id: string;
  system: string;
  content: ContentPart[];
  output: { name: string; description: string; json_schema: Record<string, unknown> };
  sampling: Sampling;
  logical_key: LogicalKey;
}

export interface ProviderResult {
  /** розібраний структурований вихід (ще не перевірений Zod) */
  json: unknown;
  /** сирий текст, якщо провайдер не зміг віддати JSON (невалідний JSON → repair) */
  raw_text?: string;
  input_tokens: number;
  output_tokens: number;
  provider: string;
  model: string;
  latency_ms: number;
  synthetic?: boolean;
  temperature_dropped?: boolean;
  /** токени оцінено за символами, а не взято з usage провайдера (session; claude-cli без usage) */
  tokens_estimated?: boolean;
  /** походження відповіді (session: answered_by, файл відповіді; claude-cli: транспорт) — потрапляє в запис кешу */
  provenance?: Record<string, unknown>;
}

export interface CallOptions { signal?: AbortSignal }
export interface LlmProvider {
  readonly name: "anthropic" | "openai" | "replay" | "fake" | "session" | "claude-cli";
  readonly model: string;
  complete(req: LlmRequest, opts?: CallOptions): Promise<ProviderResult>;
}

export type CacheMode = "use" | "bypass";
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;
