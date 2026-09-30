/**
 * Lighthouse за egress-проксі (S1b, A4, DEV-8, DEV-12, DEV-13).
 *
 * Chrome для Lighthouse запускає chrome-launcher, але:
 *   - `CHROME_PATH` = Chromium Playwright (`chromium.executablePath()`, /opt/pw-browsers), не системний Chrome;
 *   - ті самі прапорці шару 1, що й у Playwright: `secureChromiumArgs(proxy.url)` (`--proxy-server`,
 *     `--proxy-bypass-list=<-loopback>`, WebRTC лише через проксі, `--disable-quic`);
 *   - `ignoreDefaultFlags: true` + дефолти chrome-launcher БЕЗ `--disable-setuid-sandbox` (його chrome-launcher
 *     додає на Linux сам); `--no-sandbox` заборонено інваріантом → пісочниця як у Playwright;
 *   - env — той самий білий список `buildBrowserEnv` (chrome-launcher за замовчуванням передає весь process.env);
 *   - тимчасовий профіль, видаляється після прогону.
 * Шар 2 (блок не-GET) у Chrome Lighthouse — окреме CDP-з'єднання з `Fetch.requestPaused` (`cdp-method-guard.ts`,
 * DEV-51; до S1b-Fix його не було — DEV-12): не-GET/HEAD із вкладки, iframe, dedicated/Shared/Service Worker → failRequest.
 * IP кожного з'єднання, як і раніше, перевіряє проксі. Помилка Lighthouse ізольована: `runLighthouseIsolated` ніколи не кидає, повертає ok:false.
 * Результат → Evidence BENCHMARKED (performance, accessibility) у формі SPEC §23 / SCORING_SPEC §1.
 */
import { constants as fsc } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as ChromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromium } from "playwright";
import { evidenceId, type Evidence } from "../evidence.js";
import { startEgressProxy, type Dialer, type EgressProxy, type ProxyDecision, type ProxyLimits, type Resolver } from "../net/egress-proxy.js";
import { descendantsOf } from "../net/peer-check.js";
import { loadSiteDenylist, type SiteDenylist } from "../net/site-denylist.js";
import { buildBrowserEnv, proxyModeFrom, secureChromiumArgs } from "../secure-launch.js";
import { attachMethodGuard, type CdpBlocked } from "./cdp-method-guard.js";

export type FormFactor = "desktop" | "mobile";
export type LighthouseFn = typeof lighthouse;

/** Прапорці Chrome для Lighthouse: дефолти chrome-launcher (без setuid-відключення) + шар 1 + headless. */
export function lighthouseChromeFlags(proxyUrl: string): string[] {
  return [...ChromeLauncher.Launcher.defaultFlags(), ...secureChromiumArgs(proxyUrl), "--headless=new"];
}

export function assertSandboxedFlags(flags: string[]): void {
  const bad = flags.find((f) => f.startsWith("--no-sandbox") || f.startsWith("--disable-setuid-sandbox") || f.startsWith("--no-zygote"));
  if (bad) throw new Error(`lighthouse: прапорець ${bad} вимикає пісочницю — відмова`);
}

export interface ChromeProcInfo {
  pid: number;
  type: string;
  no_sandbox: boolean;
  env_keys: string[] | null;
  seccomp: number | null;
  /** Чи містить environ хоч одне зі значень `secretsProbe` (тести передають фейкові секрети). */
  secret_hits: number;
}

async function procInfo(rootPid: number, secretsProbe: string[]): Promise<ChromeProcInfo[]> {
  const pids = [rootPid, ...descendantsOf(rootPid)];
  const out: ChromeProcInfo[] = [];
  for (const pid of pids) {
    try {
      // Chrome переписує argv/environ під назву процесу (setproctitle) — розбираємо як рядок.
      const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
      let envKeys: string[] | null = null;
      let secretHits = 0;
      try {
        const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").filter(Boolean);
        const keys = env.map((e) => e.slice(0, e.indexOf("=")));
        // якщо область environ перезаписана назвою процесу — ключі невалідні, не вдаємо, що прочитали
        envKeys = keys.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) ? keys.sort() : null;
        secretHits = secretsProbe.filter((s) => env.some((e) => e.includes(s))).length;
      } catch {
        /* non-dumpable (пісочниця) — environ недоступний навіть тому самому uid */
      }
      const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
      const sec = /^Seccomp:\s+(\d)/m.exec(status);
      out.push({
        pid,
        type: /--type=(\S+)/.exec(cmd)?.[1] ?? "browser",
        no_sandbox: /(^|\s)--no-sandbox(\s|$)/.test(cmd),
        env_keys: envKeys,
        seccomp: sec ? Number(sec[1]) : null,
        secret_hits: secretHits,
      });
    } catch {
      /* процес завершився */
    }
  }
  return out;
}

export interface RawLighthouseRun {
  lhr: LhrLike | null;
  chrome_pid: number | null;
  chrome_alive_after: boolean;
  processes: ChromeProcInfo[];
  flags: string[];
  /** null — guard не вмикався (лише контрольні прогони runLighthouseRaw). */
  method_guard: { blocked: CdpBlocked[]; attached: Array<{ type: string; url: string }>; intercepted: number; errors: string[] } | null;
}

/** Мінімальна форма LHR, яку ми читаємо (lighthouse types важкі; беремо лише потрібне). */
export interface LhrLike {
  lighthouseVersion: string;
  finalDisplayedUrl?: string;
  requestedUrl?: string;
  runtimeError?: { code: string; message: string };
  runWarnings?: string[];
  categories: Record<string, { score: number | null; auditRefs?: Array<{ id: string; weight: number }> }>;
  audits: Record<string, { score: number | null; numericValue?: number; scoreDisplayMode?: string; title?: string; details?: unknown }>;
  environment?: { hostUserAgent?: string; benchmarkIndex?: number };
  configSettings?: { formFactor?: string; throttlingMethod?: string };
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Низькорівневий прогін: запускає Chrome з ДАНИМИ прапорцями/env і Lighthouse. Не додає захисту сам —
 * його додає `runLighthouseIsolated`; окремо експортовано для контрольних тестів (той самий шлях без проксі).
 */
export async function runLighthouseRaw(opts: {
  url: string;
  flags: string[];
  env: Record<string, string>;
  userDataDir: string;
  formFactor: FormFactor;
  chromePath?: string;
  timeoutMs: number;
  lighthouseImpl?: LighthouseFn;
  secretsProbe?: string[];
  /** CDP-блок не-GET (DEV-51). runIsolated завжди true; false/відсутній — лише контроль. */
  methodGuard?: boolean;
}): Promise<RawLighthouseRun> {
  const chromePath = opts.chromePath ?? chromium.executablePath();
  const run: RawLighthouseRun = { lhr: null, chrome_pid: null, chrome_alive_after: false, processes: [], flags: opts.flags, method_guard: null };
  // chrome-launcher не слухає 'error' від spawn: неіснуючий CHROME_PATH дав би unhandled error і повалив би worker.
  await access(chromePath, fsc.X_OK).catch(() => {
    throw new Error(`CHROME_PATH недоступний для запуску: ${chromePath}`);
  });
  const chrome = await ChromeLauncher.launch({
    chromePath,
    chromeFlags: opts.flags,
    ignoreDefaultFlags: true,
    envVars: opts.env,
    userDataDir: opts.userDataDir,
    logLevel: "silent",
    handleSIGINT: false,
    maxConnectionRetries: 40,
  });
  run.chrome_pid = chrome.pid;
  let timer: NodeJS.Timeout | undefined;
  let guard: Awaited<ReturnType<typeof attachMethodGuard>> | null = null;
  try {
    if (opts.methodGuard) {
      // fail-closed: без guard Lighthouse не стартує (виняток → ok:false у runLighthouseIsolated)
      guard = await attachMethodGuard(chrome.port);
      run.method_guard = guard;
    }
    const lh = opts.lighthouseImpl ?? lighthouse;
    const desktop = opts.formFactor === "desktop";
    const job = lh(opts.url, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "accessibility"],
      formFactor: opts.formFactor,
      screenEmulation: desktop
        ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
        : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
      ...(desktop ? { throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 } } : {}),
      disableFullPageScreenshot: true,
      maxWaitForLoad: Math.max(5000, opts.timeoutMs - 10_000),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`lighthouse timeout ${opts.timeoutMs} мс`)), opts.timeoutMs);
    });
    job.catch(() => {}); // після таймауту/kill відмова job не повинна стати unhandled rejection
    // процеси знімаємо під час роботи (після завершення Chrome їх уже немає)
    const snap = new Promise<void>((resolve) =>
      setTimeout(() => {
        void procInfo(chrome.pid, opts.secretsProbe ?? []).then((p) => {
          run.processes = p;
          resolve();
        });
      }, 1500),
    );
    const result = await Promise.race([job, timeout]);
    await snap;
    run.lhr = (result?.lhr as unknown as LhrLike) ?? null;
    return run;
  } finally {
    if (timer) clearTimeout(timer);
    if (guard) {
      run.method_guard = { blocked: guard.blocked, attached: guard.attached, intercepted: guard.intercepted, errors: guard.errors };
      await guard.close();
    }
    try {
      chrome.kill();
    } catch {
      /* вже завершився */
    }
    for (let i = 0; i < 40 && pidAlive(chrome.pid); i++) await new Promise((r) => setTimeout(r, 50));
    run.chrome_alive_after = pidAlive(chrome.pid);
  }
}

export interface LighthouseRunOptions {
  url: string;
  formFactor?: FormFactor;
  mode: "prod" | "fixture";
  fixtureOrigins?: string[];
  allowFixtureLoopback?: boolean;
  resolver?: Resolver;
  dial?: Dialer;
  limits?: Partial<ProxyLimits>;
  siteDenylist?: SiteDenylist;
  /** Абсолютний каталог прогону; LHR пишеться як `<outDir>/<lhrName>`. */
  outDir: string;
  lhrName?: string;
  timeoutMs?: number;
  chromePath?: string;
  /** Ін'єкція (тести «зламаний Lighthouse»). */
  lighthouseImpl?: LighthouseFn;
  secretsProbe?: string[];
  /** false — ЛИШЕ контрольний тест (довести, що без guard не-GET доходить). За замовчуванням true. */
  methodGuard?: boolean;
}

export interface LighthouseRunResult {
  ok: boolean;
  error: string | null;
  url: string;
  form_factor: FormFactor;
  duration_ms: number;
  lighthouse_version: string | null;
  runtime_error: string | null;
  scores: Record<string, number | null>;
  /** Відносно outDir. */
  lhr_path: string | null;
  evidence: Evidence[];
  proxy_log: ProxyDecision[];
  proxy_auth_mode: string | null;
  method_guard: RawLighthouseRun["method_guard"];
  chrome: { pid: number | null; alive_after: boolean; flags: string[]; processes: ChromeProcInfo[]; env: Record<string, string> | null };
}

/** Прибирає base64-зображення з LHR (артефакт у репо лишається малим); решта — без змін. */
export function stripLhrImages<T>(lhr: T): T {
  return JSON.parse(JSON.stringify(lhr, (_k, v) => (typeof v === "string" && v.startsWith("data:image/") ? `<stripped ${v.length} chars>` : v))) as T;
}

const PERF_METRICS = ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index"] as const;

/** Evidence BENCHMARKED за категоріями LHR (SPEC §23; SCORING_SPEC §1). self_confirming=false — опорний факт (ET-SUP). */
export function lighthouseEvidence(lhr: LhrLike, o: { page_url: string; form_factor: FormFactor; artifact_reference: string }): Evidence[] {
  if (lhr.runtimeError) return [];
  const out: Evidence[] = [];
  for (const cat of ["performance", "accessibility"] as const) {
    const c = lhr.categories[cat];
    if (!c || c.score === null || c.score === undefined) continue;
    const score100 = Math.round(c.score * 100);
    const failing = (c.auditRefs ?? [])
      .filter((r) => r.weight > 0)
      .map((r) => ({ id: r.id, a: lhr.audits[r.id] }))
      .filter((x) => x.a && x.a.score !== null && x.a.score < 0.9 && x.a.scoreDisplayMode !== "notApplicable")
      .map((x) => ({ id: x.id, score: x.a!.score, title: x.a!.title ?? null }));
    const metrics =
      cat === "performance"
        ? Object.fromEntries(PERF_METRICS.map((m) => [m, lhr.audits[m]?.numericValue ?? null]))
        : undefined;
    out.push({
      id: evidenceId("lighthouse", o.page_url, o.form_factor, cat),
      type: "lighthouse",
      source_class: "BENCHMARKED",
      page_url: o.page_url,
      self_confirming: false,
      detector_id: `lighthouse:${cat}`,
      claim_kind: "lighthouse_category_score",
      viewport: o.form_factor,
      description: `Lighthouse ${lhr.lighthouseVersion} ${cat} (${o.form_factor}): ${score100}/100; аудитів із score < 0.9: ${failing.length}`,
      artifact_reference: o.artifact_reference,
      selector_or_region: { selector: `lhr.categories.${cat}`, region: null },
      data: {
        category: cat,
        score: c.score,
        score_100: score100,
        lighthouse_version: lhr.lighthouseVersion,
        throttling_method: lhr.configSettings?.throttlingMethod ?? null,
        benchmark_index: lhr.environment?.benchmarkIndex ?? null,
        failing_audits: failing,
        ...(metrics ? { metrics } : {}),
        run_warnings: lhr.runWarnings ?? [],
      },
    });
  }
  return out;
}

/** Захищений прогін. Ніколи не кидає: будь-яка помилка → ok:false, Chrome і проксі прибрано. */
export async function runLighthouseIsolated(opts: LighthouseRunOptions): Promise<LighthouseRunResult> {
  const t0 = Date.now();
  const formFactor = opts.formFactor ?? "desktop";
  const res: LighthouseRunResult = {
    ok: false,
    error: null,
    url: opts.url,
    form_factor: formFactor,
    duration_ms: 0,
    lighthouse_version: null,
    runtime_error: null,
    scores: {},
    lhr_path: null,
    evidence: [],
    proxy_log: [],
    proxy_auth_mode: null,
    method_guard: null,
    chrome: { pid: null, alive_after: false, flags: [], processes: [], env: null },
  };
  let proxy: EgressProxy | null = null;
  let tmpRoot: string | null = null;
  try {
    const mode = proxyModeFrom(opts);
    proxy = await startEgressProxy({ mode, resolver: opts.resolver, dial: opts.dial, limits: opts.limits, siteDenylist: opts.siteDenylist ?? loadSiteDenylist() });
    res.proxy_log = proxy.log;
    res.proxy_auth_mode = proxy.authMode;
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "sl-lh-"));
    for (const sub of ["home/.config", "home/.cache", "tmp", "profile"]) await mkdir(path.join(tmpRoot, sub), { recursive: true });
    const env = buildBrowserEnv(tmpRoot);
    const flags = lighthouseChromeFlags(proxy.url);
    assertSandboxedFlags(flags);
    res.chrome.flags = flags;
    res.chrome.env = env;
    const raw = await runLighthouseRaw({
      url: opts.url,
      flags,
      env,
      userDataDir: path.join(tmpRoot, "profile"),
      formFactor,
      chromePath: opts.chromePath,
      timeoutMs: opts.timeoutMs ?? 90_000,
      lighthouseImpl: opts.lighthouseImpl,
      secretsProbe: opts.secretsProbe,
      methodGuard: opts.methodGuard !== false,
    });
    res.method_guard = raw.method_guard;
    res.chrome.pid = raw.chrome_pid;
    res.chrome.alive_after = raw.chrome_alive_after;
    res.chrome.processes = raw.processes;
    if (!raw.lhr) throw new Error("lighthouse не повернув LHR");
    const lhr = raw.lhr;
    res.lighthouse_version = lhr.lighthouseVersion;
    res.runtime_error = lhr.runtimeError ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` : null;
    res.scores = Object.fromEntries(Object.entries(lhr.categories).map(([k, v]) => [k, v.score]));
    await mkdir(opts.outDir, { recursive: true });
    // Повний LHR (без зображень) — gzip: ≈ 190 КБ JSON → ≈ 25 КБ (бюджет артефактів S1b ≤ 2 МБ).
    const name = opts.lhrName ?? `lighthouse-${formFactor}.json.gz`;
    await writeFile(path.join(opts.outDir, name), gzipSync(JSON.stringify(stripLhrImages(lhr))));
    res.lhr_path = name;
    res.evidence = lighthouseEvidence(lhr, { page_url: opts.url, form_factor: formFactor, artifact_reference: name });
    res.ok = !lhr.runtimeError && res.evidence.length > 0;
    if (!res.ok && !res.error) res.error = res.runtime_error ?? "немає оцінок категорій";
  } catch (e) {
    res.ok = false;
    res.error = (e as Error).message ?? String(e);
  } finally {
    await proxy?.close().catch(() => {});
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    res.duration_ms = Date.now() - t0;
  }
  return res;
}

/** Для діагностики: чи лишились процеси Chrome з нашим тимчасовим профілем (очікується 0). */
export async function strayChromeProcesses(profileHint = "sl-lh-"): Promise<number[]> {
  const out: number[] = [];
  for (const d of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(d)) continue;
    const exe = await readlink(`/proc/${d}/exe`).catch(() => "");
    if (!exe.includes("chrom")) continue;
    const cmd = await readFile(`/proc/${d}/cmdline`, "utf8").catch(() => "");
    if (cmd.includes(profileHint)) out.push(Number(d));
  }
  return out;
}
