/**
 * Сценарії S2 (критерії виходу 1–9) справжніми процесами: Postgres (embedded, демон), API, worker, фікстури — усе від `sitelens`.
 * Запуск: pnpm s2:scenarios [фаза …]   (фази: baseline crawl lighthouse api partial taxonomy repeat ttl ssrf listen all)
 * Артефакти: planning/qa/artifacts/sprint-2/*.json. Кожна перевірка має контроль (уміє впасти). Жодного pkill -f / killall.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { descendantsOf, cmdlineOf, isSameProc, readPidFile, readStat } from "../packages/db/src/index.js";
import { ENTRY_CORPUS, startAttacker, startCanary } from "./s2/ssrf.js";
import { API, ART, FX, PORTS, ROOT, S2, alive, baseEnv, browserPids, http, idOf, launch, listFiles, logHas, orphanReport, pool, q, runSync, save, sh, sleep, snapshotForeign, waitFor } from "./s2/harness.js";
import { apiUp, dbDown, dbUp, fixturesUp, newestRecovery, pidOf, stack, stopGraceful, workerUp } from "./s2/stack.js";

const db = pool();
const phases = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["all"]);
const want = (p: string) => phases.has("all") || phases.has(p);
const results: Record<string, unknown> = {};
const artifactPath = (id: string) => path.join(S2, "artifacts", id);
const S1A_PAGES = (JSON.parse(readFileSync(path.join(ROOT, "planning/qa/artifacts/sprint-1a-fix/shop/pages.json"), "utf8")) as Array<{ id: string }>).map((p) => p.id).sort();
const foreign = snapshotForeign();
const stopStack = process.env["S2_KEEP_STACK"] !== "1";

const submit = async (url: string, headers: Record<string, string> = {}) => {
  const r = await http("POST", `${API}/api/audits`, { url }, headers);
  return { status: r.status, id: (r.json as { auditId?: string } | null)?.auditId ?? null, body: r.json };
};
const submitOk = async (url: string) => {
  const s = await submit(url);
  if (!s.id) throw new Error(`POST ${url} → ${s.status} ${JSON.stringify(s.body)}`);
  return s as { status: number; id: string; body: unknown };
};
const auditRow = async (id: string) => (await q<{ status: string; error_class: string | null; error: string | null; warnings: unknown[]; stage_status: Record<string, { status: string; reason?: string }> }>(db, "SELECT status, error_class, error, warnings, stage_status FROM audit_runs WHERE id = $1", [id]))[0];
const done = async (id: string, ms = 420_000) => waitFor(`аудит ${id} завершено`, async () => { const r = await auditRow(id); return r && (r.status === "completed" || r.status === "failed") ? r : null; }, ms, 500);
const pageCount = async (id: string) => Number((await q(db, "SELECT count(*) AS n FROM page_artifacts WHERE audit_run_id = $1", [id]))[0]!["n"]);
const pageIds = async (id: string) => (await q<{ id: string }>(db, "SELECT id FROM page_artifacts WHERE audit_run_id = $1 ORDER BY id", [id])).map((r) => r.id);
const evIds = async (id: string, notLh = true) => (await q<{ id: string }>(db, `SELECT id FROM evidence WHERE audit_run_id = $1 ${notLh ? "AND type <> 'lighthouse'" : ""} ORDER BY id`, [id])).map((r) => r.id);
const jobKeys = async (id: string) => (await q<{ job_key: string }>(db, "SELECT job_key FROM audit_jobs WHERE audit_run_id = $1 ORDER BY job_key", [id])).map((r) => r.job_key);
/** еталон множин для «0 дублів» (S2-1): id сторінок, id доказів УСІХ типів (включно з Lighthouse), ключі задач */
interface Ref { pages: string[]; ev_all: string[]; lh: string[]; jobs: string[] }
const lhIds = async (id: string) => (await q<{ id: string }>(db, "SELECT id FROM evidence WHERE audit_run_id = $1 AND type = 'lighthouse' ORDER BY id", [id])).map((r) => r.id);
const refOf = async (id: string): Promise<Ref> => ({ pages: await pageIds(id), ev_all: await evIds(id, false), lh: await lhIds(id), jobs: await jobKeys(id) });
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const same = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);
const workerBrowsers = (w: number) => descendantsOf(w).filter((p) => /headless|chrom/.test(readStat(p)?.comm ?? ""));
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/**
 * «0 дублів / 0 втрат» = РІВНІСТЬ МНОЖИН з еталоном (id сторінок, id доказів усіх типів включно з Lighthouse, ключі задач) + число Lighthouse-рядків.
 * `structural_*` (count − count(DISTINCT) по PK/UNIQUE) лишено лише як довідку: PK + ON CONFLICT роблять їх структурно нульовими й вони НЕ входять у pass (S2-1).
 */
async function integrity(id: string, exp: Ref) {
  const cnt = async (t: string, col: string) => { const r = await q<{ n: string; u: string }>(db, `SELECT count(*) AS n, count(DISTINCT ${col}) AS u FROM ${t} WHERE audit_run_id = $1`, [id]); return Number(r[0]!.n) - Number(r[0]!.u); };
  const ids = await pageIds(id);
  const eids = await evIds(id, false);
  const jids = await jobKeys(id);
  const lhRows = Number((await q(db, "SELECT count(*) AS n FROM evidence WHERE audit_run_id = $1 AND type = 'lighthouse'", [id]))[0]!["n"]);
  const diff = (have: string[], want: string[]) => ({ lost: want.filter((x) => !have.includes(x)), extra: have.filter((x) => !want.includes(x)) });
  const pg = diff(ids, exp.pages), ev = diff(eids, exp.ev_all), jb = diff(jids, exp.jobs);
  return {
    pages_expected: exp.pages.length, pages_found: ids.length, pages_lost: pg.lost.length, pages_extra: pg.extra.length,
    evidence_expected: exp.ev_all.length, evidence_rows: eids.length, evidence_lost: ev.lost.length, evidence_extra: ev.extra.length, evidence_set_equal_to_baseline_incl_lighthouse: same(eids, exp.ev_all),
    lighthouse_rows: lhRows, lighthouse_rows_expected_from_baseline: exp.lh.length,
    jobs_expected: exp.jobs.length, jobs_found: jids.length, jobs_lost: jb.lost.length, jobs_extra: jb.extra.length, jobs_set_equal_to_baseline: same(jids, exp.jobs),
    structural_note: "PK-лічильники (count − count(DISTINCT)) структурно нульові й не входять у pass; «0 дублів» = рівність множин із baseline",
    structural_pages_duplicated: await cnt("page_artifacts", "url"), structural_evidence_duplicated: await cnt("evidence", "id"), structural_jobs_duplicated: await cnt("audit_jobs", "job_key"),
    missing: pg.lost, extra: pg.extra, evidence_lost_ids: ev.lost.slice(0, 10), evidence_extra_ids: ev.extra.slice(0, 10), jobs_lost_keys: jb.lost, jobs_extra_keys: jb.extra,
  };
}
type Integrity = Awaited<ReturnType<typeof integrity>>;
const integrityOk = (i: Integrity): boolean => i.pages_lost === 0 && i.pages_extra === 0 && i.evidence_lost === 0 && i.evidence_extra === 0 && i.evidence_set_equal_to_baseline_incl_lighthouse && i.jobs_lost === 0 && i.jobs_extra === 0 && i.jobs_set_equal_to_baseline && i.lighthouse_rows === i.lighthouse_rows_expected_from_baseline && i.lighthouse_rows > 0;

/**
 * Контроль (S2-1): мутант «Lighthouse записано двічі з різним id» — копія Lighthouse-рядка з іншим id. Порівняння МАЄ впасти (evidence_extra > 0, lighthouse_rows > очікуваних);
 * після контролю рядок видаляється і порівняння знову чисте. Доводить, що перевірка вміє ловити подвійний Lighthouse, а не лише PK-структуру.
 */
async function dupControl(id: string, exp: Ref) {
  const planted = "ev_00000000d0d0";
  const n = await q(db, "INSERT INTO evidence SELECT r.* FROM evidence e, LATERAL jsonb_populate_record(NULL::evidence, to_jsonb(e) || jsonb_build_object('id', $2::text)) r WHERE e.audit_run_id = $1 AND e.type = 'lighthouse' ORDER BY e.id LIMIT 1 RETURNING id", [id, planted]);
  try {
    const bad = await integrity(id, exp);
    return { planted_rows: n.length, detected: !integrityOk(bad) && bad.evidence_extra > 0 && bad.lighthouse_rows > bad.lighthouse_rows_expected_from_baseline, evidence_extra: bad.evidence_extra, lighthouse_rows: bad.lighthouse_rows, lighthouse_rows_expected: bad.lighthouse_rows_expected_from_baseline, structural_evidence_duplicated_would_have_been: bad.structural_evidence_duplicated };
  } finally {
    await q(db, "DELETE FROM evidence WHERE audit_run_id = $1 AND id = $2", [id, planted]);
  }
}

let baseline: Ref | null = null;
const loadBaseline = async () => {
  if (baseline) return baseline;
  const f = path.join(ART, "baseline.json");
  if (existsSync(f)) { baseline = JSON.parse(readFileSync(f, "utf8")).ids; return baseline!; }
  throw new Error("немає baseline: запустіть фазу baseline");
};

async function killScenario(name: string, opts: { requireOrphanControl: boolean; url: string; trigger: (w: number, id: string) => Promise<unknown>; expect: Ref }) {
  const w1 = pidOf("worker")!;
  const sub = await submit(opts.url);
  const id = sub.id!;
  log(`${name}: аудит ${id}, worker pid ${w1}`);
  await opts.trigger(w1, id);
  const tracked = readPidFile(path.join(S2, "pids", "worker.json"))!;
  const trackedKids = tracked.children.filter((c) => isSameProc(c));
  const desc = descendantsOf(w1).map(idOf);
  const descBrowsers = desc.filter((p) => /headless|chrom/.test(p.comm));
  const pagesAtKill = await pageCount(id);
  const statusAtKill = (await auditRow(id))!.status;
  const tKill = Date.now();
  process.kill(w1, "SIGKILL"); // kill -9 worker
  await sleep(700);
  const orphansImmediately = descBrowsers.filter((p) => isSameProc(p)).map((p) => p.pid);
  const activeJobs = await q(db, "SELECT name, state FROM pgboss.job WHERE data->>'auditRunId' = $1 AND state = 'active'", [id]);
  const auditMidState = (await auditRow(id))!.status;
  const w2 = await workerUp();
  const rec = newestRecovery(tKill - 1000);
  const fin = await done(id);
  const integ = await integrity(id, opts.expect);
  const control = await dupControl(id, opts.expect);
  const jobs = await q(db, "SELECT name, state, retry_count FROM pgboss.job WHERE data->>'auditRunId' = $1 ORDER BY name, created_on", [id]);
  const trackedAlive = trackedKids.filter((c) => isSameProc(c)).map((c) => c.pid);
  const descAlive = desc.filter((p) => isSameProc(p) && !descendantsOf(w2).includes(p.pid)).map((p) => p.pid);
  const orph = orphanReport(foreign, [w2], pidOf("postgres"));
  const out = {
    scenario: name, audit_id: id, worker_killed: { pid: w1, signal: "SIGKILL", audit_status_at_kill: statusAtKill, pages_at_kill: pagesAtKill, active_queue_jobs_after_kill: activeJobs },
    pre_cleanup: { orphan_browser_pids_alive_right_after_kill: orphansImmediately, tracked_children_in_pid_file: trackedKids.length, note: opts.requireOrphanControl ? "контроль (обов'язковий у цьому сценарії): Chrome Lighthouse ІСНУЄ після kill -9 до прибирання — перевірка «0 сиріт» уміє показати ненуль" : "інформативно: Playwright Chromium сам виходить, коли закривається канал (--remote-debugging-pipe); може встигнути зникнути за 700 мс" },
    restart: { new_worker_pid: w2, recovery_report: rec, note: "killed = записані PID-файлом; killed_from_spawn_log = записані обгорткою Chrome Lighthouse ДО exec (без вікна гонки)" },
    final: { status: fin.status, stage_status_keys: Object.keys(fin.stage_status), warnings: fin.warnings },
    integrity: integ, dup_control: control, queue_jobs: jobs,
    orphans_after: { tracked_pids_still_alive: trackedAlive, descendants_of_dead_worker_still_alive: descAlive, independent_scan: orph },
    pass: fin.status === "completed" && integrityOk(integ) && control.detected && trackedAlive.length === 0 && descAlive.length === 0 && orph.orphan_browsers.length === 0 && orph.orphan_postgres.length === 0 && (!opts.requireOrphanControl || orphansImmediately.length > 0) && auditMidState !== "completed",
  };
  const st = await http("GET", `${API}/api/audits/${id}`);
  save(`${name}.json`, out);
  save(`${name}-api-status.json`, st.json);
  results[name] = { pass: out.pass, pages: `${integ.pages_found}/${integ.pages_expected}`, lost: integ.pages_lost, duplicates_or_extra: integ.pages_extra + integ.evidence_extra + integ.jobs_extra, lighthouse_rows: `${integ.lighthouse_rows}/${integ.lighthouse_rows_expected_from_baseline}`, dup_control_detected: control.detected, orphans_after: trackedAlive.length + descAlive.length + orph.orphan_browsers.length };
  log(`${name}: ${JSON.stringify(results[name])}`);
  return out;
}

async function main() {
  const git = (a: string[]) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
  save("_run-info.json", {
    started_at: new Date().toISOString(), node: process.version, phases: [...phases], git_sha: git(["rev-parse", "HEAD"]), working_tree_dirty_files: git(["status", "--porcelain"]).split("\n").filter(Boolean).length,
    note: "Живий пас (публічні сайти) — ⏭️: мережа закрита. Фази, не перелічені в `phases`, у цьому запуску не виконувались (їхні артефакти — з попереднього запуску).",
  });
  const dbs = dbUp();
  log(`Postgres: ${JSON.stringify(dbs)}, PID-файл ${JSON.stringify(readPidFile(path.join(S2, "pids", "postgres.json"))?.pid)}`);
  await fixturesUp();
  await apiUp();
  await workerUp();

  // ------------------------------------------------------------------ baseline
  if (want("baseline") || want("crawl") || want("lighthouse") || want("api")) {
    if (want("baseline") || !existsSync(path.join(ART, "baseline.json"))) {
      const t0 = Date.now();
      const s = await submit(FX.shop + "/");
      const fin = await done(s.id!);
      const ref = await refOf(s.id!);
      const pages = ref.pages, ev = ref.ev_all;
      const api = await http("GET", `${API}/api/audits/${s.id}`);
      const apiPages = await http("GET", `${API}/api/audits/${s.id}/pages`);
      const s1aEqual = same(pages, S1A_PAGES);
      save("baseline.json", { audit_id: s.id, duration_ms: Date.now() - t0, status: fin.status, ids: ref, pages_equal_to_S1a_artifact: s1aEqual, s1a_pages: S1A_PAGES.length, evidence_rows: ev.length, note: "ідентичність множини сторінок незалежному артефакту S1a (planning/qa/artifacts/sprint-1a-fix/shop/pages.json)" });
      save("baseline-api-status.json", api.json);
      save("baseline-api-pages.json", apiPages.json);
      results["baseline"] = { status: fin.status, pages: pages.length, s1a_equal: s1aEqual, evidence: ev.length };
      log(`baseline: ${JSON.stringify(results["baseline"])}`);
      if (fin.status !== "completed" || !s1aEqual) throw new Error("baseline не пройдено");
    }
    baseline = null;
    await loadBaseline();
  }

  // ------------------------------------------------------------------ 1а. kill -9 worker посеред crawl
  if (want("crawl")) {
    const b = await loadBaseline();
    await killScenario("kill9-worker-crawl", {
      requireOrphanControl: false, url: FX.shop + "/", expect: b,
      trigger: async (_w, id) => { await waitFor("≥ 4 сторінки й crawling", async () => (await pageCount(id)) >= 4 && (await auditRow(id))!.status === "crawling" ? true : null, 180_000, 200); await waitFor("браузер живий", () => (workerBrowsers(pidOf("worker")!).length > 0) || null, 30_000, 100); },
    });
  }
  // ------------------------------------------------------------------ 1б. kill -9 worker посеред Lighthouse
  if (want("lighthouse")) {
    // еталон малого сайту: 4 сторінки
    const ref = await submit(FX.errors + "/ok");
    await done(ref.id!);
    const refSets = await refOf(ref.id!);
    await killScenario("kill9-worker-lighthouse", {
      requireOrphanControl: true, url: FX.errors + "/ok", expect: refSets,
      trigger: async (w) => { await waitFor("Chrome Lighthouse запущено (профіль sl-lh-)", () => descendantsOf(w).some((p) => cmdlineOf(p).includes("/sl-lh-")) || null, 240_000, 50); },
    });
    const id = (JSON.parse(readFileSync(path.join(ART, "kill9-worker-lighthouse.json"), "utf8")) as { audit_id: string }).audit_id;
    const lh = await q(db, "SELECT type, count(*)::int AS n, count(DISTINCT id)::int AS u FROM evidence WHERE audit_run_id = $1 AND type = 'lighthouse' GROUP BY 1", [id]);
    const lhJobs = await q(db, "SELECT job_key, status, attempts FROM audit_jobs WHERE audit_run_id = $1 AND kind = 'lighthouse'", [id]);
    const lhInfo = { lighthouse_evidence: lh, lighthouse_jobs: lhJobs, ok: lh[0]?.["n"] === 2 && lh[0]?.["u"] === 2 && lhJobs.length === 1 && lhJobs[0]!["status"] === "done" };
    save("kill9-worker-lighthouse-lh.json", lhInfo);
    results["kill9-worker-lighthouse"] = { ...(results["kill9-worker-lighthouse"] as object), lighthouse_rows_exactly_once: lhInfo.ok };
    if (!lhInfo.ok) (results["kill9-worker-lighthouse"] as { pass: boolean }).pass = false;
  }
  // ------------------------------------------------------------------ 1в. kill -9 API посеред опитування
  if (want("api")) {
    const b = await loadBaseline();
    const sub = await submit(FX.shop + "/");
    const id = sub.id!;
    const samples: Array<{ t: number; ok: boolean; status?: number; audit_status?: string; err?: string }> = [];
    let polling = true;
    const t0 = Date.now();
    const poller = (async () => {
      while (polling) {
        try { const r = await http("GET", `${API}/api/audits/${id}`); samples.push({ t: Date.now() - t0, ok: r.status === 200, status: r.status, audit_status: (r.json as { status?: string })?.status }); }
        catch (e) { samples.push({ t: Date.now() - t0, ok: false, err: String((e as Error).cause ?? (e as Error).message).slice(0, 60) }); }
        await sleep(300);
      }
    })();
    await waitFor("≥ 3 сторінки", async () => (await pageCount(id)) >= 3 || null, 180_000, 200);
    const apiPid = pidOf("api")!;
    const pagesAtKill = await pageCount(id);
    const workerPidBefore = pidOf("worker");
    process.kill(apiPid, "SIGKILL"); // kill -9 API
    await sleep(500);
    let refused = false;
    try { await http("GET", `${API}/api/health`); } catch { refused = true; }
    await sleep(6000); // worker працює без API
    const pagesDuringDowntime = await pageCount(id);
    const newApi = await apiUp();
    const fin = await done(id);
    polling = false;
    await poller;
    const apiStatus = await http("GET", `${API}/api/audits/${id}`);
    const apiPages = await http("GET", `${API}/api/audits/${id}/pages`);
    const integ = await integrity(id, b);
    const control = await dupControl(id, b);
    const failures = samples.filter((s) => !s.ok);
    const firstOkAfter = samples.find((s, i) => s.ok && samples.slice(0, i).some((x) => !x.ok));
    const jobRow = await q(db, "SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'crawl_site' AND data->>'auditRunId' = $1", [id]);
    const orph = orphanReport(foreign, [pidOf("worker")!], pidOf("postgres"));
    const pgOk = readPidFile(path.join(S2, "pids", "postgres.json"))?.pid === pidOf("postgres") && alive(pidOf("postgres")!);
    const out = {
      scenario: "kill9-api", audit_id: id, api_killed: { pid: apiPid, signal: "SIGKILL", pages_at_kill: pagesAtKill }, connection_refused_after_kill: refused,
      worker_unaffected: { pid_before: workerPidBefore, pid_after: pidOf("worker"), pages_during_api_downtime: pagesDuringDowntime, progressed_while_api_dead: pagesDuringDowntime > pagesAtKill || fin.status === "completed" },
      restart: { new_api_pid: newApi }, poller: { samples: samples.length, failures: failures.length, first_ok_after_outage_ms: firstOkAfter?.t ?? null, error_samples: [...new Set(failures.map((f) => f.err ?? `HTTP ${f.status}`))] },
      final: { status: fin.status }, integrity: integ, dup_control: control, atomic_submit: { crawl_site_jobs_for_audit: jobRow[0]!["n"] }, orphans_after: orph, postgres_pid_file_consistent: pgOk,
      pass: fin.status === "completed" && refused && integrityOk(integ) && control.detected && failures.length > 0 && !!firstOkAfter && orph.orphan_browsers.length === 0 && orph.orphan_postgres.length === 0 && pgOk,
    };
    save("kill9-api.json", out);
    save("kill9-api-status.json", apiStatus.json);
    save("kill9-api-pages.json", apiPages.json);
    results["kill9-api"] = { pass: out.pass, pages: `${integ.pages_found}/${integ.pages_expected}`, lost: integ.pages_lost, duplicates_or_extra: integ.pages_extra + integ.evidence_extra + integ.jobs_extra, lighthouse_rows: `${integ.lighthouse_rows}/${integ.lighthouse_rows_expected_from_baseline}`, dup_control_detected: control.detected, outage_samples_failed: failures.length };
    log(`kill9-api: ${JSON.stringify(results["kill9-api"])}`);
  }

  // ------------------------------------------------------------------ 2. частковий збій
  if (want("partial")) {
    await stopGraceful("worker");
    await workerUp({ SITELENS_FAULTS: "lighthouse_broken", CAPTURE_ATTEMPTS: "1" });
    const sub = await submit(FX.errors + "/partial");
    const fin = await done(sub.id!);
    const st = await http("GET", `${API}/api/audits/${sub.id}`);
    const pages = await http("GET", `${API}/api/audits/${sub.id}/pages`);
    const s = st.json as { status: string; warnings: Array<{ stage: string; class?: string }>; progress: Record<string, number>; error: unknown };
    const ev500 = Number((await q(db, "SELECT count(*) AS n FROM evidence WHERE audit_run_id = $1 AND page_url LIKE '%/e/500'", [sub.id]))[0]!["n"]);
    const out = {
      scenario: "partial-failure", audit_id: sub.id, faults: "lighthouse_broken + сторінка /e/500 (HTTP 500)", status: s.status, progress: s.progress, warnings: s.warnings, error: s.error, stage_status: fin.stage_status, evidence_rows_for_failed_page: ev500,
      audits_failed_because_of_one_page_or_lighthouse: s.status === "failed" ? 1 : 0,
      pass: s.status === "completed" && s.warnings.some((w) => w.stage === "capture" && w.class === "unsupported_site") && s.warnings.some((w) => w.stage === "lighthouse") && ev500 === 0 && s.progress["pages_failed"] === 1,
    };
    save("partial-failure.json", out);
    save("partial-failure-api-status.json", st.json);
    save("partial-failure-api-pages.json", pages.json);
    results["partial-failure"] = { pass: out.pass, status: s.status, audits_failed: out.audits_failed_because_of_one_page_or_lighthouse };
    log(`partial: ${JSON.stringify(results["partial-failure"])}`);
    await stopGraceful("worker");
    await workerUp();
  }

  // ------------------------------------------------------------------ 3. §48 12/12 через API
  if (want("taxonomy")) {
    await stopGraceful("worker");
    await workerUp({ CAPTURE_ATTEMPTS: "1" });
    const rows: Array<Record<string, unknown>> = [];
    const runOne = async (cls: string, route: string, url: string, during?: (w: number) => Promise<void>) => {
      const sub = await submit(url);
      if (during) await during(pidOf("worker")!);
      const fin = await done(sub.id!, 240_000);
      const st = (await http("GET", `${API}/api/audits/${sub.id}`)).json as { error: { class: string; message: string } | null; status: string };
      const ev = Number((await q(db, "SELECT count(*) AS n FROM evidence WHERE audit_run_id = $1", [sub.id]))[0]!["n"]);
      rows.push({ class: cls, route, url, audit_id: sub.id, status: fin.status, got_class: fin.error_class, message: st.error?.message ?? null, evidence_rows: ev, pass: fin.status === "failed" && fin.error_class === cls && ev === 0 && (st.error?.message.length ?? 0) > 30 });
      log(`taxonomy ${cls}: ${fin.status}/${fin.error_class}`);
    };
    // invalid_url — вхід API
    const bad = await http("POST", `${API}/api/audits`, { url: "http://127.0.0.1:4399/x" });
    rows.push({ class: "invalid_url", route: "POST /api/audits {url: loopback}", url: "http://127.0.0.1:4399/x", audit_id: null, status: `HTTP ${bad.status}`, got_class: (bad.json as { error: { class: string } }).error.class, message: (bad.json as { error: { message: string } }).error.message, evidence_rows: 0, pass: bad.status === 400 && (bad.json as { error: { class: string } }).error.class === "invalid_url" });
    await runOne("dns_failure", "*.invalid", "http://sl-no-such-host.invalid/");
    await runOne("ssl_failure", "HTTPS самопідписаний", FX.errorsTls + "/ok");
    await runOne("bot_protection", "/e/cf", FX.errors + "/e/cf");
    await runOne("captcha", "/e/captcha", FX.errors + "/e/captcha");
    await runOne("redirect_loop", "/e/redirect-loop", FX.errors + "/e/redirect-loop");
    await runOne("unsupported_site", "/e/500", FX.errors + "/e/500");
    await runOne("empty_page", "/e/empty", FX.errors + "/e/empty");
    await runOne("js_rendering_failure", "/e/js-broken", FX.errors + "/e/js-broken");
    await runOne("browser_crash", "/e/timeout + SIGKILL браузера", FX.errors + "/e/timeout", async (w) => {
      await waitFor("навігація зависла", () => workerBrowsers(w).some((p) => cmdlineOf(p).includes("--type=renderer")) || null, 60_000, 100);
      await sleep(2500);
      for (const p of workerBrowsers(w).filter((x) => !cmdlineOf(x).includes("--type="))) process.kill(p, "SIGKILL");
    });
    await runOne("page_crash", "/e/timeout + SIGKILL рендерера", FX.errors + "/e/timeout", async (w) => {
      await waitFor("навігація зависла", () => workerBrowsers(w).some((p) => cmdlineOf(p).includes("--type=renderer")) || null, 60_000, 100);
      await sleep(2500);
      for (const p of workerBrowsers(w).filter((x) => cmdlineOf(x).includes("--type=renderer"))) process.kill(p, "SIGKILL");
    });
    await runOne("timeout", "/e/timeout", FX.errors + "/e/timeout");
    const passed = rows.filter((r) => r["pass"]).length;
    save("taxonomy-48.json", { classes_total: 12, classes_passed: passed, rows, note: "0 випадків «аналізу» при збої: evidence_rows=0 для кожного; повідомлення — людські (uk)" });
    results["taxonomy-48"] = { passed: `${passed}/12`, zero_analysis_on_failure: rows.every((r) => r["evidence_rows"] === 0) };
    log(`taxonomy: ${JSON.stringify(results["taxonomy-48"])}`);
    await stopGraceful("worker");
    await workerUp();
  }

  // ------------------------------------------------------------------ 4. повтор
  if (want("repeat")) {
    const a = await submit(FX.errors + "/ok");
    await done(a.id!);
    const digest = async (id: string) => sha(await Promise.all([q(db, "SELECT id, url, page_type, title, http_status, technical_json FROM page_artifacts WHERE audit_run_id = $1 ORDER BY id", [id]), q(db, "SELECT id, type, page_url, description, measurement FROM evidence WHERE audit_run_id = $1 ORDER BY id", [id]), q(db, "SELECT job_key, status FROM audit_jobs WHERE audit_run_id = $1 ORDER BY job_key", [id])]));
    const before = await digest(a.id!);
    const filesBefore = listFiles(artifactPath(a.id!)).length;
    const b = await submit(FX.errors + "/ok");
    const fb = await done(b.id!);
    const after = await digest(a.id!);
    const out = {
      scenario: "repeat", first: a.id, second: b.id, distinct_audit_runs: new Set([a.id, b.id]).size, second_status: fb.status, first_digest_before: before, first_digest_after: after, first_unchanged: before === after,
      first_artifact_files_before: filesBefore, first_artifact_files_after: listFiles(artifactPath(a.id!)).length, second_has_own_rows: (await pageCount(b.id!)) > 0, pass: a.id !== b.id && before === after && fb.status === "completed",
    };
    save("repeat.json", out);
    results["repeat"] = { pass: out.pass, independent_runs: out.distinct_audit_runs, first_unchanged: out.first_unchanged };
    log(`repeat: ${JSON.stringify(results["repeat"])}`);
  }

  // ------------------------------------------------------------------ 5. TTL і видалення
  if (want("ttl")) {
    const a = await submit(FX.errors + "/ok"); await done(a.id!);
    const b = await submit(FX.errors + "/ok"); await done(b.id!);
    const c = await submit(FX.errors + "/ok"); await done(c.id!);
    const filesA = listFiles(artifactPath(a.id!)).length, filesB = listFiles(artifactPath(b.id!)).length;
    await db.query("UPDATE audit_runs SET artifact_expires_at = now() - interval '1 day' WHERE id = $1", [a.id]);
    await waitFor("TTL-прибирання воркером", async () => (await q(db, "SELECT artifacts_deleted_at FROM audit_runs WHERE id = $1", [a.id]))[0]!["artifacts_deleted_at"] !== null || null, 60_000, 500);
    const ttl = {
      expired_audit: a.id, files_before: filesA, dir_exists_after: existsSync(artifactPath(a.id!)), files_after: listFiles(artifactPath(a.id!)).length,
      fresh_audit: b.id, fresh_files_before: filesB, fresh_files_after: listFiles(artifactPath(b.id!)).length, fresh_artifacts_deleted_at: (await q(db, "SELECT artifacts_deleted_at FROM audit_runs WHERE id = $1", [b.id]))[0]!["artifacts_deleted_at"],
    };
    const tables = ["page_artifacts", "evidence", "audit_jobs", "llm_calls", "customer_tasks", "site_profiles", "behavioral_lenses", "scenarios", "synthetic_sessions", "findings", "finding_evidence", "recommendations"];
    const counts = async (id: string): Promise<Record<string, number>> => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await q(db, `SELECT count(*) AS n FROM ${t} WHERE audit_run_id = $1`, [id]))[0]!["n"])])));
    const beforeC = await counts(c.id!);
    const filesC = listFiles(artifactPath(c.id!)).length;
    const jobsC = Number((await q(db, "SELECT count(*) AS n FROM pgboss.job WHERE data->>'auditRunId' = $1", [c.id]))[0]!["n"]);
    const del = await http("DELETE", `${API}/api/audits/${c.id}`);
    const afterC = await counts(c.id!);
    const jobsAfter = Number((await q(db, "SELECT count(*) AS n FROM pgboss.job WHERE data->>'auditRunId' = $1", [c.id]))[0]!["n"]);
    const rowsBefore = Object.values(beforeC).reduce((x, y) => x + y, 0);
    const rowsAfter = Object.values(afterC).reduce((x, y) => x + y, 0);
    const delOut = {
      deleted_audit: c.id, http_status: del.status, files_before: filesC, files_after: listFiles(artifactPath(c.id!)).length, dir_exists_after: existsSync(artifactPath(c.id!)),
      db_rows_before: rowsBefore, db_rows_after: rowsAfter, per_table_before: beforeC, per_table_after: afterC, audit_row_after: Number((await q(db, "SELECT count(*) AS n FROM audit_runs WHERE id = $1", [c.id]))[0]!["n"]),
      queue_jobs_before: jobsC, queue_jobs_after: jobsAfter, get_after_delete: (await http("GET", `${API}/api/audits/${c.id}`)).status,
    };
    const pct = (removed: number, total: number) => (total === 0 ? 100 : Math.round((removed / total) * 1000) / 10);
    const out = {
      scenario: "ttl-and-delete", ttl, delete: delOut,
      percent_removed: { ttl_files: pct(ttl.files_before - ttl.files_after, ttl.files_before), delete_files: pct(filesC - delOut.files_after, filesC), delete_db_rows: pct(rowsBefore - rowsAfter + 1 - delOut.audit_row_after, rowsBefore + 1), delete_queue_jobs: pct(jobsC - jobsAfter, jobsC) },
      pass: !ttl.dir_exists_after && ttl.files_after === 0 && ttl.fresh_files_after === ttl.fresh_files_before && ttl.fresh_artifacts_deleted_at === null && del.status === 200 && delOut.files_after === 0 && !delOut.dir_exists_after && rowsAfter === 0 && delOut.audit_row_after === 0 && jobsAfter === 0 && delOut.get_after_delete === 404 && filesC > 0 && rowsBefore > 0,
    };
    save("ttl-and-delete.json", out);
    results["ttl-and-delete"] = { pass: out.pass, ...out.percent_removed };
    log(`ttl: ${JSON.stringify(results["ttl-and-delete"])}`);
  }

  // ------------------------------------------------------------------ 6. SSRF через API (вхід + worker)
  if (want("ssrf")) {
    const canary = await startCanary(PORTS.canary);
    const attacker = await startAttacker(PORTS.attacker, `http://127.0.0.2:${PORTS.canary}`);
    const canaryOrigin = `http://127.0.0.2:${PORTS.canary}`;
    // контроль канарки: пряме звернення її лічить
    await fetch(canaryOrigin + "/control-direct");
    const controlDirect = canary.hits.filter((h) => h.path === "/control-direct").length;
    canary.hits.length = 0;

    // 6.1 ВХІД
    const rowsBefore = Number((await q(db, "SELECT count(*) AS n FROM audit_runs"))[0]!["n"]);
    const entry: Array<{ url: string; status: number; class: string | null }> = [];
    for (const u of ENTRY_CORPUS(PORTS.canary)) {
      const r = await http("POST", `${API}/api/audits`, { url: u });
      entry.push({ url: u, status: r.status, class: (r.json as { error?: { class: string } } | null)?.error?.class ?? null });
    }
    const rowsAfter = Number((await q(db, "SELECT count(*) AS n FROM audit_runs"))[0]!["n"]);
    const entryOut = { vectors: entry.length, rejected_400: entry.filter((e) => e.status === 400).length, accepted: entry.filter((e) => e.status !== 400).map((e) => e.url), audit_rows_created: rowsAfter - rowsBefore, canary_hits: canary.hits.length };
    // контроль входу: легітимний URL (фікстура) приймається
    const okCtl = await submit(FX.errors + "/ok");
    save("ssrf-entry.json", { ...entryOut, control_legit_url_status: okCtl.status, control_direct_canary_hit: controlDirect, details: entry });
    await done(okCtl.id!);

    // 6.2 WORKER. A: fixture-режим, канарка НЕ в allowlist; B: контроль — канарка в allowlist; C: prod-режим (резолвер/дайлер-гачки)
    const runWorker = async (label: string, env: Record<string, string>, url: string) => {
      await stopGraceful("worker");
      canary.hits.length = 0;
      await workerUp(env);
      const sub = await submitOk(url);
      const fin = await done(sub.id, 300_000);
      const pages = (await http("GET", `${API}/api/audits/${sub.id}/pages`)).json as { pages: Array<{ url: string; capture_ok: boolean; egress_denied: Array<{ host: string; reason: string }> }> };
      const denied = pages.pages.flatMap((p) => p.egress_denied);
      const deniedCanary = denied.filter((d) => d.host === "127.0.0.2");
      const byVec = [...new Set(canary.hits.map((h) => h.path.split("/")[1]?.split("?")[0]))].sort();
      return { label, audit_id: sub.id, status: fin.status, error_class: fin.error_class, canary_hits: canary.hits.length, canary_paths: byVec, egress_denied_total: denied.length, egress_denied_canary_host: deniedCanary.length, denied_sample: deniedCanary.slice(0, 3), pages: pages.pages.map((p) => ({ url: p.url, ok: p.capture_ok })) };
    };
    const allowAttackerOnly = FX.errors && `${attacker.origin}`;
    const A = await runWorker("A: fixture-режим, канарка поза allowlist", { SITELENS_FIXTURE_ORIGINS: `${allowAttackerOnly}`, CAPTURE_ATTEMPTS: "1", LIGHTHOUSE_ENABLED: "0" }, attacker.origin + "/");
    const B = await runWorker("B (КОНТРОЛЬ): fixture-режим, канарка В allowlist", { SITELENS_FIXTURE_ORIGINS: `${allowAttackerOnly},${canaryOrigin}`, CAPTURE_ATTEMPTS: "1", LIGHTHOUSE_ENABLED: "0" }, attacker.origin + "/");
    const C = await runWorker(
      "C: prod-режим (без fixture), attacker.test → публічна IP → локальний сервер",
      { SITELENS_FIXTURE_MODE: "", SITELENS_FIXTURE_ORIGINS: "", SITELENS_TEST_RESOLVER_MAP: JSON.stringify({ "attacker.test": "93.184.216.34" }), SITELENS_TEST_DIAL_MAP: JSON.stringify({ "93.184.216.34:80": `127.0.0.1:${PORTS.attacker}` }), CAPTURE_ATTEMPTS: "1", LIGHTHOUSE_ENABLED: "0", MAX_PAGES: "3" },
      "http://attacker.test/",
    );
    const out = {
      scenario: "ssrf-via-api", entry: entryOut, worker: { A, B, C },
      summary: { entry_vectors: entry.length, entry_rejected: entryOut.rejected_400, entry_canary_hits: canary.hits.length, worker_canary_hits_A: A.canary_hits, worker_canary_hits_C: C.canary_hits, control_B_canary_hits: B.canary_hits, control_direct_canary_hit: controlDirect },
      pass: entryOut.rejected_400 === entry.length && entryOut.audit_rows_created === 0 && entryOut.canary_hits === 0 && okCtl.status === 202 && controlDirect === 1 && A.canary_hits === 0 && A.status === "completed" && A.egress_denied_canary_host > 0 && C.canary_hits === 0 && C.status === "completed" && C.egress_denied_canary_host > 0 && B.canary_hits > 0 && B.egress_denied_canary_host === 0,
    };
    save("ssrf-via-api.json", out);
    results["ssrf-via-api"] = { pass: out.pass, ...out.summary };
    log(`ssrf: ${JSON.stringify(results["ssrf-via-api"])}`);
    await canary.close();
    await attacker.close();
    await stopGraceful("worker");
    await workerUp();
  }

  // ------------------------------------------------------------------ 9. listen
  if (want("listen")) {
    const lsof = (pid: number) => sh("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"]).trim();
    const apiPid = pidOf("api")!;
    const own = lsof(apiPid);
    const anyPort = sh("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"]).split("\n").filter((l) => new RegExp(`:${PORTS.api}\\b`).test(l));
    // контроль 1: HOST=0.0.0.0 без токена → відмова
    const control1 = (() => { try { runSync(["pnpm", "--silent", "api"], baseEnv({ HOST: "0.0.0.0", PORT: "3111", PID_DIR: path.join(S2, "pids-tmp") })); return { exit: 0, out: "" }; } catch (e) { const x = e as { status: number; stderr: string; stdout: string }; return { exit: x.status, out: (x.stderr + x.stdout).slice(0, 400) }; } })();
    const listening3111 = sh("lsof", ["-iTCP:3111", "-sTCP:LISTEN", "-P", "-n"]).trim();
    // контроль 2: HOST=0.0.0.0 + токен → стартує й lsof показує НЕ-loopback (перевірка вміє показати ненуль)
    const TOKEN = "s2-listen-control-token-0123456789";
    const p2 = launch("api-exposed", ["pnpm", "--silent", "api"], baseEnv({ HOST: "0.0.0.0", PORT: "3112", ACCESS_TOKEN: TOKEN, RATE_LIMIT_PER_HOUR: "1000", PID_DIR: path.join(S2, "pids-exposed") }), "../pids-exposed/api.json");
    await waitFor("exposed API", async () => { try { return (await http("GET", "http://127.0.0.1:3112/api/health")).status === 200; } catch { return false; } }, 60_000);
    const exposedPid = readPidFile(path.join(S2, "pids-exposed", "api.json"))!.pid;
    const exposedLsof = lsof(exposedPid);
    const noTok = await http("POST", "http://127.0.0.1:3112/api/audits", { url: FX.errors + "/ok" });
    const withTok = await http("POST", "http://127.0.0.1:3112/api/audits", { url: FX.errors + "/ok" }, { authorization: `Bearer ${TOKEN}` });
    if ((withTok.json as { auditId?: string })?.auditId) await done((withTok.json as { auditId: string }).auditId);
    process.kill(exposedPid, "SIGTERM");
    await sleep(500);
    void p2;
    const out = {
      scenario: "listen-127.0.0.1", default_api_pid: apiPid, lsof_default_api: own, all_listeners_on_api_port: anyPort,
      loopback_only: own.includes("127.0.0.1:" + PORTS.api) && !/\*:|0\.0\.0\.0:|\[::\]:/.test(own),
      control_host_0000_no_token: { exit_code: control1.exit, output: control1.out, listening_on_3111: listening3111 === "" ? "nothing" : listening3111 },
      control_host_0000_with_token: { lsof: exposedLsof, shows_non_loopback: /\*:3112|0\.0\.0\.0:3112/.test(exposedLsof), no_token_status: noTok.status, with_token_status: withTok.status },
      pass: own.includes("127.0.0.1:" + PORTS.api) && !/\*:|0\.0\.0\.0:|\[::\]:/.test(own) && control1.exit === 3 && /Відмова/.test(control1.out) && listening3111 === "" && /\*:3112|0\.0\.0\.0:3112/.test(exposedLsof) && noTok.status === 401 && withTok.status === 202,
    };
    save("listen.json", out);
    results["listen"] = { pass: out.pass, loopback_only: out.loopback_only, control_refused_exit: control1.exit };
    log(`listen: ${JSON.stringify(results["listen"])}`);
  }

  // ------------------------------------------------------------------ підсумок
  const finalOrph = orphanReport(foreign, [pidOf("worker")!], pidOf("postgres"));
  save("summary-scenarios.json", { finished_at: new Date().toISOString(), results, final_orphan_scan: finalOrph });
  log(`ПІДСУМОК: ${JSON.stringify(results)}`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error("СЦЕНАРІЙ ВПАВ:", e);
  save("_error.json", { error: String((e as Error).stack ?? e) });
} finally {
  await db.end().catch(() => undefined);
  if (stopStack) {
    for (const n of ["worker", "api", "fixtures"] as const) await stopGraceful(n);
    dbDown();
  }
  void stack;
  void alive; void browserPids; void logHas; void readdirSync; void ROOT;
  process.exit(failed ? 1 : 0);
}
