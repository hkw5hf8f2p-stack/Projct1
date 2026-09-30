/** Конфіг S2 з env (+ .env). Значення секретів у логи не потрапляють: `describeConfig` їх не містить. */
import path from "node:path";
import { dbConfigFromEnv, REPO_ROOT } from "@sitelens/db";

const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));
const int = (v: string | undefined, d: number, min = 0): number => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) throw new Error(`некоректне ціле значення "${v}" (мін. ${min})`);
  return n;
};

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  accessToken: string | null;
  rateLimitPerHour: number;
  domainLimitPerDay: number;
  artifactDir: string;
  artifactTtlDays: number;
  maxPages: number;
  maxDepth: number;
  maxProducts: number;
  pidDir: string;
  logDir: string;
  llmProvider: string | null;
  fixtureMode: boolean;
  fixtureOrigins: string[];
  production: boolean;
  /** лише тести (NODE_ENV≠production): host→IP; dial: "ip:port"→"127.0.0.1:port" */
  testResolverMap: Record<string, string>;
  testDialMap: Record<string, string>;
  /** лише тести (не production): SITELENS_FAULTS="lighthouse_broken,page_crash:/x" */
  faults: string[];
  lighthouse: { maxPages: number; formFactors: Array<"desktop" | "mobile">; timeoutMs: number; enabled: boolean };
  captureAttempts: number;
  ttlSweepIntervalMs: number;
  db: ReturnType<typeof dbConfigFromEnv>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env["NODE_ENV"] === "production";
  const token = env["ACCESS_TOKEN"];
  const fixtureMode = env["SITELENS_FIXTURE_MODE"] === "1";
  if (fixtureMode && production) throw new Error("SITELENS_FIXTURE_MODE=1 заборонено при NODE_ENV=production (fixture-режим послаблює SSRF-захист)");
  const json = (name: string): Record<string, string> => {
    const v = env[name];
    if (!v) return {};
    if (production) throw new Error(`${name} заборонено при NODE_ENV=production (тестовий гачок)`);
    return JSON.parse(v) as Record<string, string>;
  };
  const ff = (env["LIGHTHOUSE_FORM_FACTORS"] ?? "desktop").split(",").map((s) => s.trim()).filter(Boolean);
  for (const f of ff) if (f !== "desktop" && f !== "mobile") throw new Error(`LIGHTHOUSE_FORM_FACTORS: "${f}" — очікується desktop|mobile`);
  const db = dbConfigFromEnv(env);
  return {
    databaseUrl: db.databaseUrl,
    host: env["HOST"] ?? "127.0.0.1",
    port: int(env["PORT"] ?? env["API_PORT"], 3001, 0),
    accessToken: token && token.length > 0 ? token : null,
    rateLimitPerHour: int(env["RATE_LIMIT_PER_HOUR"], 20, 1),
    domainLimitPerDay: int(env["DOMAIN_LIMIT_PER_DAY"], 5, 1),
    artifactDir: abs(env["ARTIFACT_DIR"] ?? "data/artifacts"),
    artifactTtlDays: int(env["ARTIFACT_TTL_DAYS"], 30, 0),
    maxPages: int(env["MAX_PAGES"], 12, 1),
    maxDepth: int(env["MAX_CRAWL_DEPTH"], 3, 0),
    maxProducts: int(env["MAX_PRODUCT_PAGES"], 3, 0),
    pidDir: abs(env["PID_DIR"] ?? "data/pids"),
    logDir: abs(env["LOG_DIR"] ?? "data/logs"),
    llmProvider: env["LLM_PROVIDER"] || null,
    fixtureMode,
    fixtureOrigins: (env["SITELENS_FIXTURE_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    production,
    testResolverMap: json("SITELENS_TEST_RESOLVER_MAP"),
    testDialMap: json("SITELENS_TEST_DIAL_MAP"),
    faults: production ? [] : (env["SITELENS_FAULTS"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    lighthouse: { maxPages: int(env["LIGHTHOUSE_MAX_PAGES"], 3, 0), formFactors: ff as Array<"desktop" | "mobile">, timeoutMs: int(env["LIGHTHOUSE_TIMEOUT_MS"], 120_000, 1000), enabled: env["LIGHTHOUSE_ENABLED"] !== "0" },
    captureAttempts: int(env["CAPTURE_ATTEMPTS"], 2, 1),
    ttlSweepIntervalMs: int(env["TTL_SWEEP_INTERVAL_MS"], 600_000, 1000),
    db,
  };
}

/** Безпечний опис конфігу для логів: без токена/паролів/ключів. */
export function describeConfig(c: AppConfig): Record<string, unknown> {
  return {
    host: c.host, port: c.port, access_token: c.accessToken ? "set" : "unset", artifact_dir: c.artifactDir, ttl_days: c.artifactTtlDays,
    max_pages: c.maxPages, max_depth: c.maxDepth, fixture_mode: c.fixtureMode, fixture_origins: c.fixtureOrigins, llm_provider: c.llmProvider ?? "none",
    lighthouse: c.lighthouse, database: c.databaseUrl.replace(/\/\/[^@]*@/, "//***@"),
  };
}

// ---------------------------------------------------------------- G0-5: де слухає API
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|\[::1\])$/i;
export class ListenRefused extends Error {}

/** G0-5: не-loopback лише з явним HOST і непорожнім ACCESS_TOKEN (≥ 16 символів); інакше відмова. */
export function resolveListen(c: Pick<AppConfig, "host" | "port" | "accessToken">): { host: string; port: number; exposed: boolean } {
  const exposed = !LOOPBACK.test(c.host);
  if (exposed) {
    if (!c.accessToken) throw new ListenRefused(`HOST=${c.host} не є loopback: слухати не-loopback дозволено лише з ACCESS_TOKEN (G0-5). Відмова стартувати.`);
    if (c.accessToken.length < 16) throw new ListenRefused("ACCESS_TOKEN має бути ≥ 16 символів для не-loopback HOST (G0-5). Відмова стартувати.");
  }
  return { host: c.host, port: c.port, exposed };
}
