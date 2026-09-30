/**
 * DEV-ONLY (явний прапорець SITELENS_SOURCE=fixture, не production): записані звіти замість живого API.
 * Джерела — РЕАЛЬНІ звіти без LLM (planning/qa/artifacts/sprint-4) і приклад із replay (packages/schemas/examples).
 * Варіанти станів будуються мутацією цих звітів і в тесті проходять повний Zod-контракт `Report` (apps/web/test/fixtures.test.ts),
 * тож UI не бачить звіту, якого контракт не допустив би.
 */
import fs from "node:fs";
import path from "node:path";

export const ERROR_CLASSES = [
  "invalid_url", "dns_failure", "ssl_failure", "timeout", "bot_protection", "captcha",
  "browser_crash", "page_crash", "redirect_loop", "unsupported_site", "empty_page", "js_rendering_failure",
] as const;

export function isFixtureMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SITELENS_SOURCE"] === "fixture" && env["NODE_ENV"] !== "production";
}

export function repoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, "pnpm-workspace.yaml"))) return d;
    d = path.dirname(d);
  }
  throw new Error("repo root not found");
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- динамічна мутація JSON-фікстури

const SRC = {
  completed: { file: "packages/schemas/examples/report.fixture.json", artifacts: "planning/qa/artifacts/sprint-1a-fix/shop" },
  nollm: { file: "planning/qa/artifacts/sprint-4/report-fixture-nollm.json", artifacts: "planning/qa/artifacts/sprint-1a-fix/shop" },
  clean: { file: "planning/qa/artifacts/sprint-4/report-fixture-nollm-shop-clean.json", artifacts: "planning/qa/artifacts/sprint-1a-fix/shop-clean" },
} as const;
type BaseId = keyof typeof SRC;

function load(id: BaseId): Json {
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), SRC[id].file), "utf8")) as Json;
}

function codeText(r: Json, template: string, templateId: string, cls = "OBSERVED"): Json {
  return { template, params: {}, origin: "code", source_class: cls, lang: r["audit"]["language"], template_id: templateId, guard: { status: "not_applicable", attempts: 0, rule_ids: [] } };
}

/** Варіанти станів (кожен — валідний за контрактом; перевіряється тестом) */
function variant(name: string): Json | null {
  switch (name) {
    case "completed": return load("completed");
    case "nollm": return load("nollm");
    case "clean": return load("clean");
    case "partial": {
      const r = load("completed");
      r["technical"]["lighthouse"] = { status: "failed", reason: "lighthouse worker crashed", runs: [] };
      r["technical"]["status"] = "partial";
      r["audit"]["stage_status"]["lighthouse"] = { status: "failed", reason: "lighthouse worker crashed" };
      r["audit"]["stage_status"]["lenses"] = { status: "failed", reason: "12 lenses planned, fewer produced" };
      r["lenses"]["items"] = r["lenses"]["items"].slice(0, 2);
      r["audit"]["banners"].push({ code: "stage_failed", stage: "lighthouse", text: codeText(r, "Етап Lighthouse завершився помилкою; технічний розділ неповний.", "banner.stage_failed") });
      r["audit"]["banners"].push({ code: "stage_failed", stage: "lenses", text: codeText(r, "Етап лінз завершився помилкою; лінз менше, ніж планувалось.", "banner.stage_failed") });
      return r;
    }
    case "budget": {
      const r = load("completed");
      r["audit"]["stage_status"]["snapshot_sessions"] = { status: "budget_limited", reason: "MAX_AUDIT_TOKENS reached" };
      r["audit"]["banners"].push({ code: "budget_limited", stage: "snapshot_sessions", text: codeText(r, "Етап знімкових сесій зупинено: вичерпано бюджет токенів.", "banner.budget_limited") });
      r["budget"]["used_tokens"] = r["budget"]["max_audit_tokens"];
      r["budget"]["cost"] = { amount: 1.5, currency: "USD", price_date: "2026-09-01", price_source: "config/prices.json (fixture)" };
      return r;
    }
    case "early": { // LLM-етапи не дійшли: лінз немає, журналів немає
      const r = load("completed");
      r["lenses"] = null;
      r["audit"]["stage_status"]["lenses"] = { status: "failed", reason: "lens generation failed" };
      r["audit"]["banners"].push({ code: "stage_failed", stage: "lenses", text: codeText(r, "Етап лінз завершився помилкою.", "banner.stage_failed") });
      for (const e of r["evidence"]) if (e["level"] === "journey") e["level"] = "snapshot";
      r["executive_summary"]["synthetic_journeys"] = 0;
      return r;
    }
    default: return null;
  }
}

export interface FixtureSpec {
  id: string;
  /** які станові поля повертає GET /audits/:id */
  status: "queued" | "running" | "running_partial" | "failed" | "completed" | "live";
  errorClass?: string;
  report?: string; // ім'я варіанта
  reportHttp?: number; // 404/500 замість звіту
  reportDelayMs?: number;
  artifactsDeleted?: boolean;
  locked?: boolean;
  badSchema?: boolean;
}

export function fixtureSpec(id: string): FixtureSpec | null {
  const fixed: Record<string, Omit<FixtureSpec, "id">> = {
    fx_completed: { status: "completed", report: "completed" },
    fx_nollm: { status: "completed", report: "nollm" },
    fx_clean: { status: "completed", report: "clean" },
    fx_partial: { status: "completed", report: "partial" },
    fx_budget: { status: "completed", report: "budget" },
    fx_early: { status: "completed", report: "early" },
    fx_queued: { status: "queued" },
    fx_running: { status: "running" },
    fx_running_partial: { status: "running_partial" },
    fx_slow: { status: "completed", report: "completed", reportDelayMs: 2500 },
    fx_report_500: { status: "completed", reportHttp: 500 },
    fx_report_404: { status: "completed", reportHttp: 404 },
    fx_deleted: { status: "completed", report: "completed", artifactsDeleted: true },
    fx_bad_schema: { status: "completed", badSchema: true },
    fx_locked: { status: "completed", report: "nollm", locked: true },
    fx_live: { status: "live", report: "completed" },
  };
  const f = fixed[id];
  if (f) return { id, ...f };
  const m = /^fx_failed_(.+)$/.exec(id);
  if (m && (ERROR_CLASSES as readonly string[]).includes(m[1] as string)) return { id, status: "failed", errorClass: m[1] as string };
  return null;
}

export const FIXTURE_IDS = ["fx_completed", "fx_nollm", "fx_clean", "fx_partial", "fx_budget", "fx_early", "fx_queued", "fx_running", "fx_running_partial", "fx_slow", "fx_report_500", "fx_report_404", "fx_deleted", "fx_bad_schema", "fx_locked", "fx_live", ...ERROR_CLASSES.map((c) => `fx_failed_${c}`)];
export const REPORT_VARIANTS = ["completed", "nollm", "clean", "partial", "budget", "early"] as const;
export const reportVariant = (name: string): Json | null => variant(name);

export function artifactRoot(spec: FixtureSpec): string {
  const name = (spec.report ?? "completed") as string;
  const base: BaseId = name === "nollm" ? "nollm" : name === "clean" ? "clean" : "completed";
  return path.join(repoRoot(), SRC[base].artifacts);
}

// ---------------------------------------------------------------- «живий» аудит із часом (для e2e submit → progress → report)
const STAGES = ["crawl", "capture", "lighthouse", "accessibility", "site_profile", "tasks", "lenses", "scenario_matrix", "snapshot_sessions", "browser_sessions", "aggregate", "report"] as const;
const LIVE_STEP_MS = 400;
const liveStart = new Map<string, number>();
export function startLive(id: string): void {
  liveStart.set(id, Date.now());
}

const STATUS_FOR_STAGE = ["crawling", "crawling", "crawling", "crawling", "profiling", "profiling", "generating_lenses", "running_scenarios", "running_scenarios", "running_scenarios", "aggregating", "aggregating"] as const;

export function statusView(spec: FixtureSpec, reportName: string | null): Json {
  const base = reportName ? reportVariant(reportName) : null;
  const url = (base?.["audit"]?.["normalized_url"] as string | undefined) ?? "http://127.0.0.1:4210/";
  const lang = (base?.["audit"]?.["language"] as string | undefined) ?? "uk";
  const now = "2026-09-30T09:00:00.000Z";
  const view: Json = {
    id: spec.id, status: "completed", input_url: url, normalized_url: url, language: lang, llm_mode: base?.["audit"]?.["llm_mode"] ?? "replay",
    created_at: now, started_at: now, completed_at: now, stage_status: {},
    progress: { pages_captured: 0, pages_failed: 0, lighthouse_done: 0, lighthouse_failed: 0 },
    warnings: [], error: null, artifacts_deleted: !!spec.artifactsDeleted, artifact_expires_at: null,
  };
  const done = (n: number, failedAt?: string): Json => Object.fromEntries(STAGES.slice(0, n).map((s) => [s, s === failedAt ? { status: "failed", reason: "lighthouse worker crashed" } : { status: "done", reason: null }]));
  switch (spec.status) {
    case "queued": return { ...view, status: "queued", started_at: null, completed_at: null };
    case "running": return { ...view, status: "running_scenarios", completed_at: null, stage_status: done(7) };
    case "running_partial": return { ...view, status: "running_scenarios", completed_at: null, stage_status: done(7, "lighthouse"), warnings: [{ stage: "lighthouse", message: "lighthouse worker crashed" }] };
    case "failed": return { ...view, status: "failed", completed_at: now, error: { class: spec.errorClass, message: `fixture: ${spec.errorClass}` } };
    case "live": {
      const t0 = liveStart.get(spec.id) ?? Date.now();
      const n = Math.floor((Date.now() - t0) / LIVE_STEP_MS);
      if (n <= 0) return { ...view, status: "queued", started_at: null, completed_at: null };
      if (n >= STAGES.length + 1) return { ...view, stage_status: base?.["audit"]?.["stage_status"] ?? done(STAGES.length) };
      return { ...view, status: STATUS_FOR_STAGE[Math.min(n - 1, STAGES.length - 1)], completed_at: null, stage_status: done(n - 1) };
    }
    default:
      return { ...view, stage_status: base?.["audit"]?.["stage_status"] ?? {}, progress: { pages_captured: base?.["executive_summary"]?.["pages_inspected"] ?? 0, pages_failed: 0, lighthouse_done: 0, lighthouse_failed: 0 } };
  }
}
