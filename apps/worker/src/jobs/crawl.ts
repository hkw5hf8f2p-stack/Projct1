/**
 * crawl_site: виконує ТОЙ САМИЙ алгоритм crawl() із S1a, але кожне захоплення — окрема задача capture_page (черга), а вже зроблені сторінки при повторі
 * відтворюються з диска/БД (replay). Тому `kill -9` посеред crawl → задача повторюється, довершує решту, 0 втрат і 0 дублів (PK+UNIQUE у БД, маркер audit_jobs).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job } from "pg-boss";
import {
  Q, addWarning, advanceStatus, enqueue, ensureAuditDir, failAudit, getAudit, getJob, humanMessage, mergeConfig, setStage, txDb,
  type AuditRow, type JobData, type JobRecord,
} from "@sitelens/pipeline";
import type { ErrorClass } from "@sitelens/schemas";
import { crawl, normalizeCrawlUrl, robotsPolicyFromResponse, robotsVerdict, type PageCapture, type RobotsPolicy } from "../browser-api.js";
import { pageIdOf } from "../capture.js";
import { failedStub } from "../page-row.js";
import type { Runtime } from "../runtime.js";
import { AuditGone, advancePostCrawl, liveAudit, waitUntil } from "./common.js";

const CAPTURE_WAIT_MS = 15 * 60_000;

async function fetchRobots(rt: Runtime, origin: string): Promise<{ status: number | null; body: string | null }> {
  const url = origin + "/robots.txt";
  const sb = await rt.getBrowser();
  return rt.gate.run(url, async () => {
    const ctx = await sb.newContext({ userAgent: rt.userAgent });
    try {
      const page = await ctx.newPage();
      await rt.gate.wait(url);
      try {
        const resp = await page.goto(url, { waitUntil: "load", timeout: 20_000 });
        return { status: resp?.status() ?? null, body: resp ? ((await resp.text().catch(() => null)) ?? null)?.slice(0, 200_000) ?? null : null };
      } catch {
        return { status: null, body: null };
      }
    } finally {
      await ctx.close().catch(() => undefined);
    }
  });
}

async function loadPolicy(rt: Runtime, a: AuditRow): Promise<RobotsPolicy | null> {
  if (rt.cfg.fixtureMode) return null; // robots — лише на живих сайтах (DEV-18); фікстури не обмежуємо
  const saved = a.config_json["robots"] as { status: number | null; body: string | null } | undefined;
  if (saved) return robotsPolicyFromResponse(saved.status, saved.body);
  const r = await fetchRobots(rt, new URL(a.normalized_url).origin);
  await mergeConfig(rt.pool, a.id, { robots: r });
  return robotsPolicyFromResponse(r.status, r.body);
}

export async function crawlJob(rt: Runtime, job: Job<JobData>): Promise<void> {
  const id = job.data.auditRunId;
  let audit = await liveAudit(rt, id);
  if (!audit) return;
  if (audit.config_json["post_crawl_enqueued"]) {
    await advancePostCrawl(rt, id); // повтор після краху між enqueue і complete
    return;
  }
  await advanceStatus(rt.pool, id, "crawling");
  const runDir = ensureAuditDir(rt.cfg.artifactDir, id);
  const seed = normalizeCrawlUrl(audit.normalized_url);
  if (!seed) {
    await failAudit(rt.pool, id, "invalid_url", humanMessage("invalid_url", audit.language, "URL не проходить нормалізацію crawl"));
    return;
  }
  const policy = await loadPolicy(rt, audit);
  const allow = policy ? (url: string) => { const x = new URL(url); return robotsVerdict(policy, x.pathname + x.search); } : undefined;
  const limits = { maxPages: audit.config_json["max_pages"] as number, maxDepth: audit.config_json["max_depth"] as number, maxProducts: audit.config_json["max_products"] as number };

  const capture = async (url: string): Promise<PageCapture> => {
    const u = new URL(url);
    const pageId = pageIdOf(u);
    const key = `capture:${pageId}`;
    let rec: JobRecord | null = await getJob(rt.pool, id, key);
    if (!rec) {
      await enqueue(rt.boss, Q.capture, { auditRunId: id, url, pageId, seedUrl: seed }, { });
      rec = await waitUntil(async () => {
        const r = await getJob(rt.pool, id, key);
        if (r) return r;
        if (!(await getAudit(rt.pool, id))) throw new AuditGone(id);
        return null;
      }, { timeoutMs: CAPTURE_WAIT_MS });
    }
    if (rec.status === "done") return JSON.parse(await readFile(path.join(runDir, "pages", pageId, "page-capture.json"), "utf8")) as PageCapture;
    return failedStub(url, pageId, (rec.error_class ?? "browser_crash") as ErrorClass, null);
  };

  let cr;
  try {
    cr = await crawl({ seedUrl: seed, capture, limits, allow });
  } catch (e) {
    if (e instanceof AuditGone) return;
    throw e;
  }
  audit = await getAudit(rt.pool, id);
  if (!audit || audit.status === "completed" || audit.status === "failed") return;

  await writeFile(path.join(runDir, "crawl.json"), JSON.stringify({ limits, order: cr.log, skipped: cr.skipped, edges: [...new Set(cr.edges.map((e) => `${e.from} -> ${e.to}`))].sort(), robots: policy ? { fetch: policy.fetch } : { enforced: false } }, null, 2) + "\n");

  // сайт-рівневий збій: сід недоступний → аналізу немає (§48). Одна збійна НЕ-сід сторінка аудит не валить.
  const seedRec = cr.pages.find((p) => p.url === seed);
  if (!seedRec) {
    const rb = cr.skipped.find((s) => s.reason === "robots_disallow" && s.url === seed);
    const msg = humanMessage("bot_protection", audit.language, rb ? `robots.txt забороняє сторінку (${rb.rule ?? "Disallow"}); не відкрито` : "сторінку-джерело не захоплено");
    await setStage(rt.pool, id, "crawl", "failed", msg);
    await failAudit(rt.pool, id, "bot_protection", msg);
    return;
  }
  if (seedRec.page_error) {
    const rec = await getJob(rt.pool, id, `capture:${seedRec.page_id}`);
    const cls = (rec?.error_class ?? "browser_crash") as ErrorClass;
    const msg = humanMessage(cls, audit.language, rec?.error?.match(/\(([^)]*)\)$/)?.[1]);
    await setStage(rt.pool, id, "crawl", "failed", msg);
    await setStage(rt.pool, id, "capture", "failed", msg);
    await failAudit(rt.pool, id, cls, msg);
    return;
  }
  for (const s of cr.skipped.filter((x) => x.reason === "robots_disallow")) await addWarning(rt.pool, id, { stage: "crawl", page_url: s.url, message: `robots.txt забороняє сторінку (${s.rule ?? "Disallow"}); не відкрито` });

  const ok = cr.pages.filter((p) => !p.page_error);
  const bad = cr.pages.length - ok.length;
  await setStage(rt.pool, id, "crawl", "done", `сторінок захоплено ${ok.length}, збійних ${bad}, пропущено ${cr.skipped.length}`);
  await setStage(rt.pool, id, "capture", "done", bad > 0 ? `часткові результати: ${bad} з ${cr.pages.length} сторінок не захоплено` : undefined);

  // ---- Lighthouse і accessibility: один раз, атомарно з прапорцем (повтор crawl_site не дублює)
  const lh = rt.cfg.lighthouse;
  const lhPages = lh.enabled ? ok.slice(0, lh.maxPages) : [];
  const lhJobs = lhPages.flatMap((p) => lh.formFactors.map((ff) => ({ key: `lighthouse:${p.page_id}:${ff}`, data: { auditRunId: id, pageId: p.page_id, url: p.url, formFactor: ff } })));
  const a11yJobs = ok.map((p) => ({ key: `accessibility:${p.page_id}`, data: { auditRunId: id, pageId: p.page_id, url: p.url } }));
  const c = await rt.pool.connect();
  try {
    await c.query("BEGIN");
    const cur = (await c.query("SELECT config_json FROM audit_runs WHERE id = $1 FOR UPDATE", [id])).rows[0] as { config_json: Record<string, unknown> } | undefined;
    if (!cur || cur.config_json["post_crawl_enqueued"]) {
      await c.query("COMMIT");
      return;
    }
    await c.query("UPDATE audit_runs SET config_json = config_json || $2::jsonb WHERE id = $1", [id, JSON.stringify({ post_crawl_enqueued: true, expected_jobs: [...lhJobs, ...a11yJobs].map((j) => j.key) })]);
    for (const j of lhJobs) await enqueue(rt.boss, Q.lighthouse, j.data, { db: txDb(c) });
    for (const j of a11yJobs) await enqueue(rt.boss, Q.accessibility, j.data, { db: txDb(c) });
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  if (lhJobs.length + a11yJobs.length === 0) await advancePostCrawl(rt, id);
}
