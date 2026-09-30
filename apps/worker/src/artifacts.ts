/**
 * Матеріалізація артефактів аудиту з БД + файлів S2 у форму S1a (pages.json, evidence.json, coverage.json, axe-groups.json), яку читають
 * `loadPagesFromArtifacts` (packages/llm) і `loadS1aRun` (packages/reporting). Один шлях читання для LLM-етапів, aggregate і generate_report.
 * Джерело істини — БД (page_artifacts, evidence, audit_jobs); файли — похідні, перезаписуються ідемпотентно.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { auditDir, type AuditRow } from "@sitelens/pipeline";
import { Evidence } from "@sitelens/schemas";
import { loadS1aRun, type AuditArtifacts, type LighthouseIn } from "@sitelens/reporting";

const nn = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

/** рядок evidence (БД) → об'єкт для Zod `Evidence` (NULL → відсутнє поле; службові колонки прибрано) */
export function evidenceFromRow(r: Record<string, unknown>): Evidence {
  const { audit_run_id: _a, created_at: _c, ...rest } = r;
  void _a; void _c;
  return Evidence.parse(nn(rest));
}

/** запис через тимчасовий файл + rename: паралельні задачі не бачать напівзаписаного JSON */
export async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function materializePages(pool: Pool, artifactDir: string, auditId: string): Promise<number> {
  const dir = auditDir(artifactDir, auditId);
  await mkdir(dir, { recursive: true });
  // збійні сторінки (capture_error) без вмісту: §48 «не вигадувати аналіз» — у pages.json не потрапляють (лишаються в warnings і audit_jobs)
  const rows = (await pool.query("SELECT * FROM page_artifacts WHERE audit_run_id = $1 AND NOT (technical_json ? 'capture_error') ORDER BY id", [auditId])).rows;
  const pages = rows.map((r) => ({
    id: r.id, audit_run_id: null, url: r.url, page_type: r.page_type, page_type_reason: r.page_type_reason, title: r.title, http_status: r.http_status,
    desktop_screenshot: r.desktop_screenshot, mobile_screenshot: r.mobile_screenshot, dom_text: r.dom_text, aria_snapshot: r.aria_snapshot, visible_text: r.visible_text,
    metadata_json: r.metadata_json, links_json: r.links_json, technical_json: r.technical_json, created_at: null,
  }));
  await writeAtomic(path.join(dir, "pages.json"), JSON.stringify(pages, null, 2) + "\n");
  return pages.length;
}

/** докази інструментів/детекторів (OBSERVED/BENCHMARKED) — усі рядки БД, у стабільному порядку; невалідний рядок кидає (fail-closed, а не мовчазне відкидання) */
export async function loadDeterministicEvidence(pool: Pool, auditId: string): Promise<Evidence[]> {
  const rows = (await pool.query("SELECT * FROM evidence WHERE audit_run_id = $1 AND source_class IN ('OBSERVED','BENCHMARKED') ORDER BY id", [auditId])).rows;
  return rows.map(evidenceFromRow);
}

export async function lighthouseFromJobs(pool: Pool, auditId: string): Promise<LighthouseIn> {
  const jobs = (await pool.query("SELECT job_key, page_url, status, error, result_json FROM audit_jobs WHERE audit_run_id = $1 AND kind = 'lighthouse' ORDER BY job_key", [auditId])).rows;
  const ev = (await pool.query("SELECT page_url, viewport, measurement FROM evidence WHERE audit_run_id = $1 AND type = 'lighthouse' AND category = 'performance'", [auditId])).rows;
  if (jobs.length === 0) return { status: "not_run", reason: "Lighthouse не запускався для цього аудиту", runs: [] };
  const runs: LighthouseIn["runs"] = jobs.map((j) => {
    const ff = (j.job_key as string).endsWith(":mobile") ? "mobile" : "desktop";
    const s = ((j.result_json as { scores?: Record<string, number | null> }).scores ?? {}) as Record<string, number | null>;
    const to100 = (x: number | null | undefined) => (typeof x === "number" ? Math.round(x * 100) : null);
    const m = (ev.find((e) => e.page_url === j.page_url && e.viewport === (ff === "mobile" ? "M" : "D"))?.measurement as { metrics?: Record<string, number | null> } | undefined)?.metrics ?? {};
    const num = (x: number | null | undefined) => (typeof x === "number" ? x : null);
    return {
      page_url: j.page_url as string, form_factor: ff as "mobile" | "desktop", status: j.status === "done" ? "done" : "failed",
      scores: { performance: to100(s["performance"]), accessibility: to100(s["accessibility"]), best_practices: to100(s["best-practices"]), seo: to100(s["seo"]) },
      metrics: { lcp_ms: num(m["largest-contentful-paint"]), tbt_ms: num(m["total-blocking-time"]), cls: num(m["cumulative-layout-shift"]), fcp_ms: num(m["first-contentful-paint"]) },
    };
  });
  const failed = runs.filter((r) => r.status === "failed").length;
  return failed === 0 ? { status: "done", reason: null, runs } : failed === runs.length ? { status: "failed", reason: `усі ${runs.length} прогони Lighthouse завершились помилкою`, runs } : { status: "partial", reason: `${failed} з ${runs.length} прогонів Lighthouse з помилкою`, runs };
}

/**
 * Повний вхід buildReport: pages.json/coverage.json/axe-groups.json (файли) + докази з БД + Lighthouse із журналу задач.
 * evidence.json пишеться з БД (а не з файлів задач): БД уже містить оновлені aggregate-ом виміри (області axe, глибини кліків).
 */
export async function loadAuditArtifacts(pool: Pool, artifactDir: string, audit: AuditRow, o: { completedAt: string }): Promise<AuditArtifacts> {
  const dir = auditDir(artifactDir, audit.id);
  await materializePages(pool, artifactDir, audit.id);
  const evidence = await loadDeterministicEvidence(pool, audit.id);
  await writeAtomic(path.join(dir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  const okPages = (await pool.query("SELECT id FROM page_artifacts WHERE audit_run_id = $1 AND NOT (technical_json ? 'capture_error') ORDER BY id", [audit.id])).rows.map((r) => r.id as string);
  const coverage: unknown[] = [];
  for (const id of okPages) {
    const f = path.join(dir, "pages", id, "coverage.json");
    if (existsSync(f)) coverage.push(...(JSON.parse(await readFile(f, "utf8")) as unknown[]));
  }
  await writeAtomic(path.join(dir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  if (!existsSync(path.join(dir, "axe-groups.json"))) await writeFile(path.join(dir, "axe-groups.json"), "[]\n");
  const stage_status = Object.fromEntries(Object.entries(audit.stage_status).map(([k, v]) => [k, { status: v.status, reason: v.reason ?? null }]));
  const art = loadS1aRun(dir, {
    id: audit.id, input_url: audit.input_url, normalized_url: audit.normalized_url, domain: audit.domain, language: audit.language, status: "completed",
    created_at: audit.created_at.toISOString(), completed_at: o.completedAt, snapshot_at: (audit as AuditRow & { snapshot_at?: Date | null }).snapshot_at?.toISOString() ?? null,
    stage_status: stage_status as never,
  });
  art.lighthouse = await lighthouseFromJobs(pool, audit.id);
  return art;
}
