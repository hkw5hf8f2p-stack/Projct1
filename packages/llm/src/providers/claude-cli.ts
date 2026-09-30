import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, ProviderAuthError, ProviderHttpError, ProviderTimeoutError } from "../errors.js";
import { estimateInputTokens, estimateTextTokens } from "../tokens.js";
import type { LlmProvider, LlmRequest, ProviderResult } from "../types.js";
import { loadImageB64 } from "./images.js";

/**
 * Транспорт `claude-cli` (DEV-82): SiteLens викликає локальний Claude Code CLI (`claude -p`), залогінений ПІДПИСКОЮ власника, без API-ключа.
 * Промпт (system) і JSON Schema — ті самі, що пішли б в API; відповідь → той самий JSON parse → Zod → guard → repair, що й для API.
 * Прапорці перевірено за `claude --help` v2.1.285: -p, --output-format json, --json-schema, --model, --system-prompt, --tools, --allowedTools,
 * --add-dir, --restricted, --strict-mcp-config, --disable-slash-commands, --no-session-persistence, --permission-mode. `--max-turns` у цій версії
 * НЕ задокументовано → не використовується (UNVERIFIED; межа — таймаут і лише інструмент Read). Форму JSON-виводу (structured_output, result, usage,
 * modelUsage, is_error) зафіксовано одним ping-викликом 30.09.2026; інші версії CLI — unverified.
 * Безпека (сторінка може містити prompt injection): єдиний інструмент — Read; доступ лише до тимчасового каталогу із зображеннями (--add-dir,
 * cwd = він же); жодних Bash/Edit/Write/WebFetch/MCP; env дочірнього процесу — білий список БЕЗ API-ключів (щоб CLI не пішов на API-тариф).
 */
export interface ClaudeCliConfig {
  /** типово `claude` з PATH (`CLAUDE_CLI_BIN`) */
  bin?: string;
  /** LLM_MODEL; порожньо → модель за замовчуванням CLI (в ключ E5 іде «cli-default», фактична модель — у provenance) */
  model?: string;
  timeoutMs?: number;
  /** базове env (типово process.env); з нього береться лише білий список */
  env?: Record<string, string | undefined>;
  /** додаткові змінні дочірнього процесу (тести) */
  extraEnv?: Record<string, string>;
}

export const CLI_DEFAULT_MODEL = "cli-default";
export const CLAUDE_CLI_TIMEOUT_MS = 180_000;
const MAX_ARG_BYTES = 100_000;
/** змінні, що передаються CLI. Немає ANTHROPIC_API_KEY/OPENAI_API_KEY/DATABASE_URL: підписка, а не API-тариф, і жодних зайвих секретів */
const ENV_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
] as const;

export function cliEnv(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) { const v = base[k]; if (v !== undefined) out[k] = v; }
  return { ...out, ...extra };
}

/** прапорці CLI для запиту (винесено для тестів: жодного Bash/Edit/Write/WebFetch, лише Read у tmp) */
export function buildCliArgs(req: LlmRequest, model: string | undefined, addDir: string): string[] {
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(req.output.json_schema), "--system-prompt", req.system,
    "--tools", "Read", "--allowedTools", "Read", "--permission-mode", "dontAsk", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
    "--no-session-persistence", "--add-dir", addDir,
  ];
  if (model && model !== CLI_DEFAULT_MODEL) args.push("--model", model);
  return args;
}

const AUTH_RX = /not logged in|please run .*login|\/login|authenticat|invalid api key|oauth|401|unauthorized|credential/i;

interface CliJson {
  type?: string; subtype?: string; is_error?: boolean; result?: unknown; structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli" as const;
  readonly model: string;
  constructor(private readonly c: ClaudeCliConfig = {}) { this.model = c.model?.trim() || CLI_DEFAULT_MODEL; }

  async complete(req: LlmRequest): Promise<ProviderResult> {
    const t0 = Date.now();
    if (Buffer.byteLength(req.system) + Buffer.byteLength(JSON.stringify(req.output.json_schema)) > MAX_ARG_BYTES) throw new ConfigError("claude-cli: system+schema завеликі для аргументів CLI");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sitelens-cli-"));
    try {
      // зображення → файли в tmp; модель бачить їх лише через Read
      const parts: string[] = [];
      let n = 0;
      for (const p of req.content) {
        if (p.type === "text") { parts.push(p.text); continue; }
        const name = `img${++n}-${p.sha256.slice(0, 8)}.${p.media_type === "image/jpeg" ? "jpg" : "png"}`;
        const abs = path.join(dir, name);
        if (p.path) { await loadImageB64(p); copyFileSync(p.path, abs); }
        else if (p.data_b64) writeFileSync(abs, Buffer.from(p.data_b64, "base64"));
        else throw new ConfigError(`claude-cli: зображення ${p.sha256.slice(0, 8)} без байтів`);
        parts.push(`[Image file: ${abs}${p.label ? ` (${p.label})` : ""} — open it with the Read tool before answering.]`);
      }
      mkdirSync(dir, { recursive: true });
      const out = await this.run(buildCliArgs(req, this.c.model, dir), parts.join("\n\n"), dir);
      return this.parse(req, out, Date.now() - t0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private run(args: string[], stdin: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const bin = this.c.bin ?? this.c.env?.["CLAUDE_CLI_BIN"] ?? process.env["CLAUDE_CLI_BIN"] ?? "claude";
    const timeout = this.c.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;
    const env = cliEnv(this.c.env ?? process.env, this.c.extraEnv);
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill("SIGKILL");
        reject(new ProviderTimeoutError(`claude-cli: таймаут ${timeout} мс`));
      }, timeout);
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(e.code === "ENOENT" ? new ConfigError(`claude-cli: бінарник «${bin}» не знайдено (встанови Claude Code CLI; CLAUDE_CLI_BIN)`) : new ProviderHttpError(`claude-cli: ${e.message}`, null, false));
      });
      child.on("close", (code) => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.on("error", () => { /* процес міг завершитись раніше, ніж прочитав stdin */ });
      child.stdin.end(stdin);
    });
  }

  private parse(req: LlmRequest, o: { code: number | null; stdout: string; stderr: string }, latency_ms: number): ProviderResult {
    let j: CliJson | null = null;
    try { j = JSON.parse(o.stdout.trim()) as CliJson; } catch { j = null; }
    const errText = `${o.stderr}\n${typeof j?.result === "string" ? j.result : ""}`;
    if (o.code !== 0 || j?.is_error === true) {
      // не друкуємо stdout/stderr цілком: там може бути що завгодно; лише клас помилки й обрізаний фрагмент без токенів
      if (AUTH_RX.test(errText)) throw new ProviderAuthError("claude-cli: не залогінено або токен недійсний — виконай `pnpm llm:login` (claude auth login | claude setup-token)");
      throw new ProviderHttpError(`claude-cli: збій (код ${o.code}${j?.subtype ? `, ${j.subtype}` : ""})`, null, false);
    }
    if (j === null) {
      // 0 і не JSON: віддаємо як текст → invalid_json → repair (як API без structured output)
      return this.result(req, null, o.stdout, undefined, latency_ms, undefined);
    }
    let json: unknown = j.structured_output ?? null;
    let raw: string | undefined;
    if (json === null || json === undefined) {
      json = null;
      if (typeof j.result === "string") {
        raw = j.result;
        try { json = JSON.parse(j.result.trim()); raw = undefined; } catch { json = null; }
      }
    }
    return this.result(req, json, raw, j.usage, latency_ms, j.modelUsage);
  }

  private result(req: LlmRequest, json: unknown, raw: string | undefined, usage: CliJson["usage"], latency_ms: number, modelUsage: Record<string, unknown> | undefined): ProviderResult {
    const hasUsage = usage !== undefined && (usage.input_tokens !== undefined || usage.output_tokens !== undefined);
    const input = hasUsage ? (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) : estimateInputTokens(req);
    const output = hasUsage ? (usage?.output_tokens ?? 0) : estimateTextTokens(json === null ? (raw ?? "") : JSON.stringify(json));
    const actual = modelUsage ? Object.keys(modelUsage)[0] : undefined;
    return {
      json, ...(raw !== undefined ? { raw_text: raw } : {}), input_tokens: input, output_tokens: output, provider: "claude-cli", model: actual ?? this.model, latency_ms,
      synthetic: false, ...(hasUsage ? {} : { tokens_estimated: true }),
      // $ не рахуємо: підписка (total_cost_usd з CLI навмисно ігнорується)
      provenance: { provider: "claude-cli", requested_model: this.model, actual_model: actual ?? null, transport: "claude -p (subscription)", synthetic: false, tokens_estimated: !hasUsage },
    };
  }
}

// ------------------------------------------------------------------------------------------------ автентифікація (pnpm llm:login / llm:check)
export interface CliAuthStatus { installed: boolean; version: string | null; logged_in: boolean | null; auth_method: string | null; api_provider: string | null; detail: string }

function runSimple(bin: string, args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ""; let done = false;
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); resolve({ code: null, stdout, error: "timeout" }); } }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.on("error", (e: NodeJS.ErrnoException) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: null, stdout, error: e.code ?? e.message }); } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout }); } });
  });
}

/** `claude --version` + `claude auth status --json`. Токенів не читає й не друкує (статус містить лише метод автентифікації). */
export async function claudeCliAuthStatus(cfg: { bin?: string; env?: Record<string, string | undefined> } = {}): Promise<CliAuthStatus> {
  const bin = cfg.bin ?? cfg.env?.["CLAUDE_CLI_BIN"] ?? process.env["CLAUDE_CLI_BIN"] ?? "claude";
  const env = cliEnv(cfg.env ?? process.env);
  const v = await runSimple(bin, ["--version"], env);
  if (v.error === "ENOENT") return { installed: false, version: null, logged_in: null, auth_method: null, api_provider: null, detail: `бінарник «${bin}» не знайдено` };
  const version = v.stdout.trim().split("\n")[0] || null;
  const s = await runSimple(bin, ["auth", "status", "--json"], env);
  try {
    const j = JSON.parse(s.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
    return { installed: true, version, logged_in: j.loggedIn === true, auth_method: j.authMethod ?? null, api_provider: j.apiProvider ?? null, detail: j.loggedIn === true ? "залогінено" : "не залогінено" };
  } catch {
    return { installed: true, version, logged_in: null, auth_method: null, api_provider: null, detail: `статус автентифікації не розібрано (код ${s.code}${s.error ? `, ${s.error}` : ""})` };
  }
}
