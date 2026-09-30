import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import type { LlmRequest } from "./types.js";

export interface CacheIdentity { provider: string; model: string }

/**
 * Ключ E5 (record/replay, G0-16 б): провайдер + модель + ID промпту + ПОВНИЙ вміст
 * (system, текстові частини, зображення за sha256, схема виходу) + параметри семплінгу.
 * Зміна будь-чого з цього → інший ключ → промах.
 */
export function cacheKey(id: CacheIdentity, req: LlmRequest): string {
  return sha256(canonicalJson({
    provider: id.provider, model: id.model, prompt_id: req.prompt_id, system: req.system,
    content: req.content.map((p) => (p.type === "text" ? { t: "text", text: p.text } : { t: "image", sha256: p.sha256, media_type: p.media_type })),
    output: { name: req.output.name, json_schema: req.output.json_schema },
    sampling: req.sampling,
  }));
}

export interface CacheEntry {
  key: string;
  provider: string;
  model: string;
  prompt_id: string;
  /** запис зроблено scripted-скриптом/вручну, а не живою моделлю */
  synthetic: boolean;
  response: unknown;
  raw_text?: string;
  input_tokens: number;
  output_tokens: number;
  /** без байтів зображень і без ключів: лише для інспекції (SPEC §35) */
  request_summary: { stage: string; logical_key: unknown; image_sha256: string[]; sampling: unknown; system_sha256: string };
  recorded_at: string;
}

export interface CacheStore {
  get(ns: string, key: string): CacheEntry | undefined;
  put(ns: string, key: string, e: CacheEntry): void;
}

export class MemoryStore implements CacheStore {
  readonly data = new Map<string, CacheEntry>();
  get(ns: string, key: string) { return this.data.get(`${ns}/${key}`); }
  put(ns: string, key: string, e: CacheEntry) { this.data.set(`${ns}/${key}`, e); }
}

/** fixtures/replay/<namespace>/<key>.json */
export class DirStore implements CacheStore {
  constructor(readonly root: string, readonly readOnly = false) {}
  private file(ns: string, key: string) { return path.join(this.root, ns, `${key}.json`); }
  get(ns: string, key: string): CacheEntry | undefined {
    const f = this.file(ns, key);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as CacheEntry) : undefined;
  }
  put(ns: string, key: string, e: CacheEntry) {
    if (this.readOnly) throw new Error("DirStore: read-only (replay)");
    const f = this.file(ns, key);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(e, null, 2) + "\n");
  }
}

/** Кеш із лічильниками (критерій: bypass → 0 читань) і namespace на прогін (E2, G0-8). */
export class ReplayCache {
  reads = 0; hits = 0; misses = 0; writes = 0;
  constructor(readonly store: CacheStore, readonly namespace: string) {}
  get(key: string): CacheEntry | undefined {
    this.reads++;
    const e = this.store.get(this.namespace, key);
    if (e) this.hits++; else this.misses++;
    return e;
  }
  put(key: string, e: CacheEntry): void { this.writes++; this.store.put(this.namespace, key, e); }
  counters() { return { reads: this.reads, hits: this.hits, misses: this.misses, writes: this.writes }; }
}
