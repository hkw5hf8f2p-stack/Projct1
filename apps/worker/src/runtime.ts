/** Стан процесу worker: пул БД, pg-boss, єдиний захищений браузер (перезапускається після краху), HostGate, фікстурні/тестові гачки. */
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { secureLaunch, type SecureBrowser } from "@sitelens/browser";
import { HostGate, HONEST_USER_AGENT, type Resolver, type Dialer } from "./browser-api.js";
import net from "node:net";
import dns from "node:dns";
import { aiEnvOverlay, readStoredAiSettings, type AiSnapshot, type AppConfig } from "@sitelens/pipeline";
import { ensureChromeWrapper } from "./chrome-wrapper.js";
import { createClientFromEnv, resolveConfig, type CallRecord, type LlmClient } from "@sitelens/llm";
import type { AuditRow } from "@sitelens/pipeline";
import { LLM_CONCURRENCY_DEFAULT, LLM_CONCURRENCY_MAX, LLM_CONCURRENCY_MIN, type BehavioralLens, type Task } from "@sitelens/schemas";

/** Клієнт LLM для однієї задачі: бюджет = MAX_AUDIT_TOKENS мінус уже витрачене цим аудитом (E4; між паралельними задачами — перевищення ≤ concurrency × max_tokens виклику). */
export interface LlmHandle { client: LlmClient; provider: string | null; model: string | null }

/** Вхід виконавця браузерних журналів (SPEC §19B/§20). Виконавець — packages/browser (sl-core-engineer); worker лише дає контекст і зберігає результат. */
export interface JournalInput {
  auditRunId: string; scenarioId: string; lens: BehavioralLens; task: Task; startUrl: string;
  browser: () => Promise<SecureBrowser>; gate: HostGate; userAgent: string | undefined; client: LlmClient; language: "uk" | "en"; artifactDir: string;
}
export interface JournalOutput {
  status: "done" | "skipped" | "failed" | "budget_limited"; reason?: string;
  session?: {
    session_id: string; success: "true" | "false" | "partial"; actions_used: number;
    frictions: Array<{ category: string; claim_kind?: string; severity: "low" | "medium" | "high"; evidence: string; page_url: string }>;
    positive_signals: string[]; uncertainties: string[]; final_summary: string; pages_seen: string[];
    steps: Array<{ action: string; target: string; reason_summary: string; task_progress: string; friction_detected: string[] }>;
  };
  calls: CallRecord[];
  /** скільки не-GET запитів заблоковано за журнал (кр. 5 S4: 0 пішло назовні) */
  non_get_blocked?: number;
}
export type JournalRunner = (input: JournalInput) => Promise<JournalOutput>;

/** Семафор паралельності LLM для ОДНОГО аудиту (DEV-92). Обмеження діє на LLM-секцію snapshot-задач; черга pg-boss дає верхню межу. */
export class Semaphore {
  active = 0;
  private waiters: Array<() => void> = [];
  constructor(readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((res) => this.waiters.push(res));
    else this.active++;
    try { return await fn(); } finally {
      const next = this.waiters.shift();
      if (next) next(); // слот передається наступному (active не змінюється)
      else this.active--;
    }
  }
  get idle(): boolean { return this.active === 0 && this.waiters.length === 0; }
}
export const clampConcurrency = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? Math.min(LLM_CONCURRENCY_MAX, Math.max(LLM_CONCURRENCY_MIN, v)) : LLM_CONCURRENCY_DEFAULT);

/**
 * Залишок токенів для клієнта задачі (E4, DEV-70/DEV-92): max − витрачене − резерв під УЖЕ виконувані паралельні задачі цього аудиту
 * (кожна ще не записала токени; резерв = їхня кількість × середні токени завершених snapshot-викликів). Немає завершених → резерв 0
 * (як було): перевищення обмежене concurrency × токени одного виклику; з резервом — лише першою хвилею.
 */
export function remainingBudget(o: { max: number; used: number; othersActive: number; avgCallTokens: number | null }): number {
  const reserve = o.avgCallTokens === null ? 0 : Math.ceil(o.othersActive * o.avgCallTokens);
  return Math.max(1, o.max - o.used - reserve);
}

export interface Runtime {
  cfg: AppConfig;
  pool: Pool;
  boss: PgBoss;
  gate: HostGate;
  userAgent: string | undefined;
  getBrowser(): Promise<SecureBrowser>;
  /** закрити й забути браузер (після краху) — наступний getBrowser() запустить новий */
  resetBrowser(): Promise<void>;
  /** режим і ін'єкції, з якими запускається браузер/Lighthouse */
  netOptions(): { mode: "prod" | "fixture"; fixtureOrigins?: string[]; allowFixtureLoopback?: boolean; resolver?: Resolver; dial?: Dialer };
  hasFault(name: string, url?: string): boolean;
  /** LLM-клієнт задачі (DEV-57): за замовчуванням createClientFromEnv(process.env); тести підставляють scripted fake / replay */
  llm(audit: AuditRow, o?: { inSlot?: boolean }): Promise<LlmHandle>;
  /** виконати LLM-секцію в межах паралельності аудиту (config_json.llm_concurrency, 1–6) */
  llmSlot<T>(audit: AuditRow, fn: () => Promise<T>): Promise<T>;
  /** залишок бюджету E4 з резервом під паралельні задачі (див. remainingBudget); тести з підміненим rt.llm викликають його теж */
  budgetRemaining(audit: AuditRow, max: number, o?: { inSlot?: boolean }): Promise<number>;
  /** виконавець журналів; null → run_browser_scenario фіксує `skipped` з причиною (виконавця ще не підключено) */
  journalRunner: JournalRunner | null;
  /** обгортка Chrome Lighthouse з обліком PID до exec (chrome-launcher не прив'язує Chrome до батька) */
  chromeWrapper: { script: string; spawnLog: string };
  /** збої навігаційних запитів і краші вкладок усіх контекстів цього браузера (потрібні, коли captureViewport кидає виняток і власних даних не лишає) */
  nav: { failures: Array<{ url: string; failure: string }>; crashes: number };
  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** Тестовий резолвер: host→IP з SITELENS_TEST_RESOLVER_MAP (лише не-production); решта — справжній DNS. */
function testResolver(map: Record<string, string>): Resolver | undefined {
  if (Object.keys(map).length === 0) return undefined;
  return async (hostname) => {
    const ip = map[hostname.toLowerCase()];
    if (ip) return [{ address: ip, family: ip.includes(":") ? 6 : 4 }];
    const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return r.map((x) => ({ address: x.address, family: x.family === 6 ? 6 : 4 }));
  };
}
/** Тестовий дайлер: "ip:port" → "host:port" (симульований інтернет: публічна IP веде на локальний сервер). Отримує лише ПЕРЕВІРЕНУ IP. */
function testDialer(map: Record<string, string>): Dialer | undefined {
  if (Object.keys(map).length === 0) return undefined;
  return (ip, port) => {
    const to = map[`${ip}:${port}`];
    if (!to) return net.connect({ host: ip, port });
    const [h, p] = to.split(":");
    return net.connect({ host: h!, port: Number(p) });
  };
}

export function createRuntime(cfg: AppConfig, pool: Pool, boss: PgBoss): Runtime {
  let browser: SecureBrowser | null = null;
  let launching: Promise<SecureBrowser> | null = null;
  const fixture = cfg.fixtureMode;
  const gate = fixture ? new HostGate(0, { fixture: true }) : new HostGate();
  const resolver = testResolver(cfg.testResolverMap);
  const dial = testDialer(cfg.testDialMap);
  const netOptions = () => (fixture
    ? { mode: "fixture" as const, fixtureOrigins: cfg.fixtureOrigins, allowFixtureLoopback: true, resolver, dial }
    : { mode: "prod" as const, resolver, dial });
  const nav: Runtime["nav"] = { failures: [], crashes: 0 };
  const chromeWrapper = ensureChromeWrapper(cfg.pidDir);
  const instrument = (sb: SecureBrowser): SecureBrowser => {
    const orig = sb.newContext.bind(sb);
    sb.newContext = async (options) => {
      const ctx = await orig(options);
      ctx.on("requestfailed", (r) => {
        if (r.isNavigationRequest() && nav.failures.length < 500) nav.failures.push({ url: r.url(), failure: r.failure()?.errorText ?? "unknown" });
      });
      ctx.on("page", (p) => p.on("crash", () => void nav.crashes++));
      return ctx;
    };
    return sb;
  };
  const sems = new Map<string, Semaphore>();
  const rt: Runtime = {
    cfg, pool, boss, gate, nav, chromeWrapper,
    async llmSlot(audit, fn) {
      let sem = sems.get(audit.id);
      if (!sem) sems.set(audit.id, (sem = new Semaphore(clampConcurrency((audit.config_json as { llm_concurrency?: unknown }).llm_concurrency))));
      try { return await sem.run(fn); } finally { if (sem.idle && sems.get(audit.id) === sem) sems.delete(audit.id); }
    },
    async budgetRemaining(audit, max, o = {}) {
      const used = Number(((await pool.query("SELECT tokens_input + tokens_output AS used FROM audit_runs WHERE id = $1", [audit.id])).rows[0] as { used: string } | undefined)?.used ?? 0);
      const others = Math.max(0, (sems.get(audit.id)?.active ?? 0) - (o.inSlot ? 1 : 0));
      let avg: number | null = null;
      if (others > 0) {
        const a = (await pool.query("SELECT avg(input_tokens + output_tokens)::float8 AS a FROM llm_calls WHERE audit_run_id = $1 AND stage = 'snapshot_sessions' AND input_tokens IS NOT NULL", [audit.id])).rows[0] as { a: number | null };
        avg = a.a;
      }
      return remainingBudget({ max, used, othersActive: others, avgCallTokens: avg });
    },
    userAgent: fixture ? undefined : HONEST_USER_AGENT,
    async getBrowser() {
      if (browser && browser.browser.isConnected()) return browser;
      if (browser) await rt.resetBrowser();
      launching ??= secureLaunch(netOptions()).then((b) => (browser = instrument(b))).finally(() => (launching = null));
      return launching;
    },
    async resetBrowser() {
      const b = browser;
      browser = null;
      if (b) await b.close().catch(() => undefined);
    },
    netOptions,
    journalRunner: null,
    async llm(audit, o = {}) {
      // BYO AI: провайдер+модель беруться зі ЗНІМКА аудиту (config_json.ai), ключ — зі сховища; зміна налаштувань під час аудиту на нього не діє.
      // Якщо kind у сховищі змінився (ключ іншого провайдера) — гучна помилка, а не тихий перехід.
      const snap = (audit.config_json as { ai?: AiSnapshot }).ai;
      let env: NodeJS.ProcessEnv = process.env;
      if (snap?.source === "ui") {
        const st = readStoredAiSettings(process.env);
        if (snap.kind !== "none" && snap.kind !== "claude_cli" && (!st || st.kind !== snap.kind)) throw new Error(`AI-налаштування змінено під час аудиту (знімок: ${snap.kind}); ключ недоступний — запустіть аудит знову`);
        env = aiEnvOverlay({ kind: snap.kind, model: snap.model, base_url: snap.base_url, api_key: st?.api_key, max_audit_tokens: snap.max_audit_tokens }, process.env);
      }
      const max = resolveConfig(env).max_audit_tokens;
      const remaining = await rt.budgetRemaining(audit, max, o);
      const { client, config } = createClientFromEnv({ ...env, MAX_AUDIT_TOKENS: String(remaining) });
      return { client, provider: config.provider, model: config.model };
    },
    hasFault(name, url) {
      return cfg.faults.some((f) => f === name || (url !== undefined && f.startsWith(name + ":") && url.includes(f.slice(name.length + 1))));
    },
    log(level, msg, extra = {}) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
    },
    async close() {
      await rt.resetBrowser();
    },
  };
  return rt;
}
