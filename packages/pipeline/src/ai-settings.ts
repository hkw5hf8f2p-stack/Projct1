/**
 * BYO AI: сховище налаштувань AI-провайдера інсталяції (без облікових записів). Файл `data/secrets/ai-settings.enc` — AES-256-GCM
 * (node:crypto); майстер-ключ — env SITELENS_MASTER_KEY (32 байти, hex/base64) або `data/secrets/master.key` (0600, створюється при першому записі).
 * Ключ провайдера не повертається жодним View, не потрапляє в config_json аудиту (лише знімок kind/provider/model/base_url).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@sitelens/db";
import { type AiCheckErrorClass, type AiSettingsInput, MAX_AUDIT_TOKENS_MAX, MAX_AUDIT_TOKENS_MIN, type AiSettingsView, type ProviderKind } from "@sitelens/schemas";

export const DEFAULT_MAX_AUDIT_TOKENS_SETTING = 1_650_000;
const AAD = Buffer.from("sitelens-ai-settings-v1");
type Env = Record<string, string | undefined>;

export class AiSettingsError extends Error {
  constructor(readonly code: "master_key_missing" | "master_key_invalid" | "file_corrupt" | "invalid_input", message: string) { super(message); this.name = "AiSettingsError"; }
}

export interface LastCheck { ok: boolean; at: string; error_class?: AiCheckErrorClass; model_reported?: string }
export interface StoredAiSettings {
  kind: ProviderKind; model: string; base_url?: string; api_key?: string; max_audit_tokens: number; updated_at: string; last_check?: LastCheck;
}

export const secretsDir = (env: Env = process.env): string => path.resolve(env["SITELENS_SECRETS_DIR"] || path.join(REPO_ROOT, "data", "secrets"));
const encFile = (env: Env) => path.join(secretsDir(env), "ai-settings.enc");
const keyFile = (env: Env) => path.join(secretsDir(env), "master.key");

function parseKey(raw: string, src: string): Buffer {
  const s = raw.trim();
  const b = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (b.length !== 32) throw new AiSettingsError("master_key_invalid", `${src}: майстер-ключ має бути рівно 32 байти (64 hex-символи або base64)`);
  return b;
}

/** create=true — лише при записі: файл ключа створюється з 0600, якщо його ще немає */
function masterKey(env: Env, create: boolean): Buffer {
  if (env["SITELENS_MASTER_KEY"]) return parseKey(env["SITELENS_MASTER_KEY"], "SITELENS_MASTER_KEY");
  const f = keyFile(env);
  if (existsSync(f)) return parseKey(readFileSync(f, "utf8"), "data/secrets/master.key");
  if (!create) throw new AiSettingsError("master_key_missing", "Майстер-ключ відсутній (data/secrets/master.key або SITELENS_MASTER_KEY): збережені налаштування AI не розшифрувати. Задайте налаштування знову.");
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const k = randomBytes(32);
  writeFileSync(f, k.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(f, 0o600);
  return k;
}

const encrypt = (plain: string, key: Buffer): string => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
};

function decrypt(raw: string, key: Buffer): string {
  let o: { v?: number; alg?: string; iv?: string; tag?: string; ct?: string };
  try { o = JSON.parse(raw); } catch { throw new AiSettingsError("file_corrupt", "ai-settings.enc пошкоджено (не JSON). Видаліть файл і задайте налаштування знову."); }
  if (o.v !== 1 || o.alg !== "aes-256-gcm" || !o.iv || !o.tag || !o.ct) throw new AiSettingsError("file_corrupt", "ai-settings.enc пошкоджено (невідомий формат). Видаліть файл і задайте налаштування знову.");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64"));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(o.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new AiSettingsError("file_corrupt", "ai-settings.enc не розшифровується (пошкоджено або інший майстер-ключ). Видаліть файл і задайте налаштування знову.");
  }
}

/** null — налаштувань через UI ще немає. Кидає AiSettingsError за пошкодженого файлу / відсутнього ключа. */
export function readStoredAiSettings(env: Env = process.env): StoredAiSettings | null {
  const f = encFile(env);
  if (!existsSync(f)) return null;
  const raw = readFileSync(f, "utf8");
  const o = JSON.parse(decrypt(raw, masterKey(env, false))) as StoredAiSettings;
  if (!o || typeof o !== "object" || typeof o.kind !== "string") throw new AiSettingsError("file_corrupt", "ai-settings.enc: неочікуваний вміст");
  return o;
}

function writeStored(s: StoredAiSettings, env: Env): void {
  const key = masterKey(env, true);
  const dir = secretsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.ai-settings.${process.pid}.tmp`);
  writeFileSync(tmp, encrypt(JSON.stringify(s), key), { mode: 0o600 });
  renameSync(tmp, encFile(env));
}

const KEY_KINDS: ProviderKind[] = ["anthropic", "openai", "openai_compatible"];
const envMax = (env: Env): number => { const n = Number(env["MAX_AUDIT_TOKENS"]); return Number.isInteger(n) && n >= MAX_AUDIT_TOKENS_MIN && n <= MAX_AUDIT_TOKENS_MAX ? n : DEFAULT_MAX_AUDIT_TOKENS_SETTING; };

/** PUT: пропущені поля зберігаються з попереднього стану (той самий kind); ключ скидається, якщо kind змінився на безключовий/інший. */
export function saveAiSettings(input: AiSettingsInput, env: Env = process.env): StoredAiSettings {
  const prev = readStoredAiSettings(env);
  const same = prev?.kind === input.kind;
  const model = input.model ?? (same ? prev!.model : "");
  if (KEY_KINDS.includes(input.kind) && !model) throw new AiSettingsError("invalid_input", "model обов'язкова (модель не хардкодиться)");
  const api_key = !KEY_KINDS.includes(input.kind) ? undefined : input.api_key ?? (same ? prev!.api_key : undefined);
  if ((input.kind === "anthropic" || input.kind === "openai") && !api_key) throw new AiSettingsError("invalid_input", `${input.kind}: потрібен api_key`);
  const next: StoredAiSettings = {
    kind: input.kind, model, ...(input.base_url ? { base_url: input.base_url.replace(/\/+$/, "") } : {}), ...(api_key ? { api_key } : {}),
    max_audit_tokens: input.max_audit_tokens ?? prev?.max_audit_tokens ?? envMax(env), updated_at: new Date().toISOString(),
  };
  writeStored(next, env);
  return next;
}

export function deleteAiKey(env: Env = process.env): StoredAiSettings | null {
  const prev = readStoredAiSettings(env);
  if (!prev) return null;
  const next: StoredAiSettings = { ...prev, updated_at: new Date().toISOString() };
  delete next.api_key;
  writeStored(next, env);
  return next;
}

export function recordAiCheck(c: LastCheck, env: Env = process.env): void {
  const prev = readStoredAiSettings(env);
  if (prev) writeStored({ ...prev, last_check: c }, env);
}

/** чинна конфігурація: UI > env > none */
export interface EffectiveAi { source: "ui" | "env" | "none"; kind: ProviderKind; model: string; base_url?: string; api_key?: string; max_audit_tokens: number; stored: StoredAiSettings | null }
export function resolveEffectiveAi(env: Env = process.env): EffectiveAi {
  const st = readStoredAiSettings(env);
  if (st) return { source: "ui", kind: st.kind, model: st.model, base_url: st.base_url, api_key: st.api_key, max_audit_tokens: st.max_audit_tokens, stored: st };
  const p = (env["LLM_PROVIDER"] ?? "").trim().toLowerCase();
  const kind: ProviderKind = p === "anthropic" || (!p && env["ANTHROPIC_API_KEY"]) ? "anthropic" : p === "openai" || (!p && env["OPENAI_API_KEY"]) ? "openai" : p === "claude-cli" ? "claude_cli" : "none";
  if (kind === "none") return { source: "none", kind, model: "", max_audit_tokens: envMax(env), stored: null };
  return { source: "env", kind, model: env["LLM_MODEL"] ?? "", api_key: kind === "anthropic" ? env["ANTHROPIC_API_KEY"] : kind === "openai" ? env["OPENAI_API_KEY"] : undefined, max_audit_tokens: envMax(env), stored: null };
}

/** View без ключа: лише key_set і (для збереженого через UI) «…abcd» */
export function toAiView(e: EffectiveAi): AiSettingsView {
  return {
    kind: e.kind, model: e.model, ...(e.base_url ? { base_url: e.base_url } : {}), key_set: !!e.api_key,
    ...(e.source === "ui" && e.api_key ? { key_hint: "…" + e.api_key.slice(-4) } : {}),
    max_audit_tokens: e.max_audit_tokens, updated_at: e.stored?.updated_at ?? null, ...(e.stored?.last_check ? { last_check: e.stored.last_check } : {}), source: e.source,
  };
}

/** знімок для AuditRun.config_json.ai — БЕЗ ключа */
export interface AiSnapshot { source: "ui" | "env" | "none"; kind: ProviderKind; provider: "anthropic" | "openai" | "claude-cli" | null; model: string | null; base_url?: string; max_audit_tokens: number }
export function aiSnapshot(e: EffectiveAi): AiSnapshot {
  const provider = e.kind === "anthropic" ? "anthropic" : e.kind === "openai" || e.kind === "openai_compatible" ? "openai" : e.kind === "claude_cli" ? "claude-cli" : null;
  return { source: e.source, kind: e.kind, provider, model: e.model || null, ...(e.base_url ? { base_url: e.base_url } : {}), max_audit_tokens: e.max_audit_tokens };
}

/** env-накладка для createClientFromEnv: UI-налаштування перекривають env; source≠ui → env без змін */
export function aiEnvOverlay(e: { kind: ProviderKind; model: string | null; base_url?: string; api_key?: string; max_audit_tokens: number }, base: Env): Env {
  const out: Env = { ...base, MAX_AUDIT_TOKENS: String(e.max_audit_tokens) };
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "LLM_MODEL"]) delete out[k];
  if (e.model) out["LLM_MODEL"] = e.model;
  switch (e.kind) {
    case "none": out["LLM_PROVIDER"] = "none"; break;
    case "anthropic": out["LLM_PROVIDER"] = "anthropic"; out["ANTHROPIC_API_KEY"] = e.api_key ?? ""; break;
    case "openai": out["LLM_PROVIDER"] = "openai"; out["OPENAI_API_KEY"] = e.api_key ?? ""; break;
    case "openai_compatible": out["LLM_PROVIDER"] = "openai"; out["OPENAI_API_KEY"] = e.api_key || "local-no-key"; out["OPENAI_BASE_URL"] = e.base_url ?? ""; break;
    case "claude_cli": out["LLM_PROVIDER"] = "claude-cli"; break;
  }
  return out;
}

/**
 * Значення `audit_runs.llm_provider` / `llm_calls.provider` (enum LLM_PROVIDERS, DEV-84) за провайдером клієнта і знімком налаштувань аудиту.
 * Клієнт для openai_compatible називається «openai» (той самий адаптер), тож розрізняє знімок (config_json.ai.kind).
 */
export function reportProvider(clientProvider: string | null | undefined, aiKind?: string | null): "anthropic" | "openai" | "openai_compatible" | "claude_cli" | "replay" | "session" {
  if (clientProvider === "anthropic") return "anthropic";
  if (clientProvider === "openai") return aiKind === "openai_compatible" ? "openai_compatible" : "openai";
  if (clientProvider === "claude-cli" || clientProvider === "claude_cli") return "claude_cli";
  if (clientProvider === "session") return "session";
  return "replay";
}

export const redactKey = (text: string, key: string | undefined): string => (key && key.length >= 4 ? text.split(key).join("[REDACTED]") : text);
