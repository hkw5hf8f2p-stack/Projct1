/** Доступ до БД (pg). Усі записи ідемпотентні (ON CONFLICT) — повтор задачі після kill -9 не дублює рядків. */
import type { Pool, PoolClient } from "pg";
import type { ErrorClass } from "@sitelens/schemas";

export type Db = Pool | PoolClient;

export const STATUS_ORDER = ["queued", "crawling", "profiling", "generating_lenses", "running_scenarios", "aggregating", "completed", "failed"] as const;
export type AuditStatusName = (typeof STATUS_ORDER)[number];

export interface AuditRow {
  id: string; input_url: string; normalized_url: string; domain: string; status: AuditStatusName; created_at: Date; started_at: Date | null; completed_at: Date | null;
  error: string | null; error_class: ErrorClass | null; llm_mode: "live" | "replay" | "none"; stage_status: Record<string, { status: string; reason?: string; updated_at?: string }>;
  config_json: Record<string, unknown>; warnings: Array<{ stage: string; page_url?: string; class?: ErrorClass; message: string }>; language: "uk" | "en";
  artifact_expires_at: Date | null; artifacts_deleted_at: Date | null; llm_provider: string | null; llm_model: string | null;
}

export async function insertAudit(db: Db, a: { id: string; input_url: string; normalized_url: string; domain: string; language: "uk" | "en"; llm_mode: "live" | "replay" | "none"; ttl_days: number; config_json: Record<string, unknown> }): Promise<void> {
  await db.query(
    `INSERT INTO audit_runs (id, input_url, normalized_url, domain, status, llm_mode, language, config_json, artifact_expires_at)
     VALUES ($1,$2,$3,$4,'queued',$5,$6,$7, now() + ($8::int * interval '1 day'))`,
    [a.id, a.input_url, a.normalized_url, a.domain, a.llm_mode, a.language, JSON.stringify(a.config_json), a.ttl_days],
  );
}

export async function getAudit(db: Db, id: string): Promise<AuditRow | null> {
  const r = await db.query("SELECT * FROM audit_runs WHERE id = $1", [id]);
  return (r.rows[0] as AuditRow | undefined) ?? null;
}

/** Просуває статус ЛИШЕ вперед (queued → … → aggregating); completed/failed — окремі функції. Повертає true, якщо змінено. */
export async function advanceStatus(db: Db, id: string, to: Exclude<AuditStatusName, "completed" | "failed">): Promise<boolean> {
  const r = await db.query(
    `UPDATE audit_runs SET status = $2, started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = $1 AND status NOT IN ('completed','failed') AND array_position($3::text[], status) < array_position($3::text[], $2)`,
    [id, to, [...STATUS_ORDER]],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function setStage(db: Db, id: string, stage: string, status: "done" | "skipped" | "budget_limited" | "failed", reason?: string): Promise<void> {
  const v = { status, ...(reason ? { reason } : {}), updated_at: new Date().toISOString() };
  await db.query("UPDATE audit_runs SET stage_status = jsonb_set(stage_status, ARRAY[$2]::text[], $3::jsonb, true), updated_at = now() WHERE id = $1", [id, stage, JSON.stringify(v)]);
}

/** Попередження про частковий збій (§47): ідемпотентне за (stage, page_url, class). */
export async function addWarning(db: Db, id: string, w: { stage: string; page_url?: string; class?: ErrorClass; message: string }): Promise<void> {
  await db.query(
    `UPDATE audit_runs SET warnings = warnings || $2::jsonb, updated_at = now()
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(warnings) x WHERE x->>'stage' = $3 AND COALESCE(x->>'page_url','') = $4 AND COALESCE(x->>'class','') = $5)`,
    [id, JSON.stringify([w]), w.stage, w.page_url ?? "", w.class ?? ""],
  );
}

export async function failAudit(db: Db, id: string, cls: ErrorClass, message: string): Promise<void> {
  await db.query("UPDATE audit_runs SET status='failed', error=$3, error_class=$2, completed_at = now(), updated_at = now() WHERE id = $1 AND status NOT IN ('completed','failed')", [id, cls, message]);
}
export async function completeAudit(db: Db, id: string): Promise<void> {
  await db.query("UPDATE audit_runs SET status='completed', completed_at = now(), snapshot_at = COALESCE(snapshot_at, now()), updated_at = now() WHERE id = $1 AND status NOT IN ('completed','failed')", [id]);
}
export async function mergeConfig(db: Db, id: string, patch: Record<string, unknown>): Promise<void> {
  await db.query("UPDATE audit_runs SET config_json = config_json || $2::jsonb, updated_at = now() WHERE id = $1", [id, JSON.stringify(patch)]);
}

// ---------------------------------------------------------------- audit_jobs
export interface JobRecord { audit_run_id: string; job_key: string; kind: "capture" | "lighthouse" | "accessibility"; page_url: string | null; status: "done" | "failed" | "skipped"; error_class: ErrorClass | null; error: string | null; attempts: number; result_json: Record<string, unknown> }
export async function getJob(db: Db, id: string, key: string): Promise<JobRecord | null> {
  return ((await db.query("SELECT * FROM audit_jobs WHERE audit_run_id = $1 AND job_key = $2", [id, key])).rows[0] as JobRecord | undefined) ?? null;
}
export async function upsertJob(db: Db, j: Omit<JobRecord, "attempts"> & { attempts?: number }): Promise<void> {
  await db.query(
    `INSERT INTO audit_jobs (audit_run_id, job_key, kind, page_url, status, error_class, error, attempts, result_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (audit_run_id, job_key) DO UPDATE SET status = EXCLUDED.status, error_class = EXCLUDED.error_class, error = EXCLUDED.error,
       attempts = audit_jobs.attempts + 1, result_json = EXCLUDED.result_json, page_url = EXCLUDED.page_url, updated_at = now()`,
    [j.audit_run_id, j.job_key, j.kind, j.page_url, j.status, j.error_class, j.error, j.attempts ?? 1, JSON.stringify(j.result_json)],
  );
}

// ---------------------------------------------------------------- page_artifacts
export interface PageRow {
  id: string; url: string; page_type: string; page_type_reason: string | null; title: string | null; http_status: number | null;
  desktop_screenshot: string | null; mobile_screenshot: string | null; dom_text: string | null; aria_snapshot: string | null; visible_text: string | null;
  metadata_json: unknown; links_json: unknown[]; technical_json: unknown;
}
export async function upsertPage(db: Db, auditId: string, p: PageRow): Promise<void> {
  await db.query(
    `INSERT INTO page_artifacts (audit_run_id, id, url, page_type, page_type_reason, title, http_status, desktop_screenshot, mobile_screenshot, dom_text, aria_snapshot, visible_text, metadata_json, links_json, technical_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (audit_run_id, id) DO UPDATE SET url = EXCLUDED.url, page_type = EXCLUDED.page_type, page_type_reason = EXCLUDED.page_type_reason, title = EXCLUDED.title,
       http_status = EXCLUDED.http_status, desktop_screenshot = EXCLUDED.desktop_screenshot, mobile_screenshot = EXCLUDED.mobile_screenshot, dom_text = EXCLUDED.dom_text,
       aria_snapshot = EXCLUDED.aria_snapshot, visible_text = EXCLUDED.visible_text, metadata_json = EXCLUDED.metadata_json, links_json = EXCLUDED.links_json, technical_json = EXCLUDED.technical_json`,
    [auditId, p.id, p.url, p.page_type, p.page_type_reason, p.title, p.http_status, p.desktop_screenshot, p.mobile_screenshot, p.dom_text, p.aria_snapshot, p.visible_text, JSON.stringify(p.metadata_json), JSON.stringify(p.links_json), JSON.stringify(p.technical_json)],
  );
}

// ---------------------------------------------------------------- evidence
/** Рядок доказу в «плоскій» формі S1a (EvidenceRow) — приймаємо структурно, щоб не тягнути типи браузера в repo. */
export interface EvidenceInput {
  id: string; type: string; source_class: string; page_url: string; page_path?: string; page_id?: string; page_type?: string; page_type_reason?: string | null; page_group?: string;
  category?: string; description: string; artifact_reference: string; screenshot_reference?: string; selector_or_region: unknown; excerpt?: string; detector_id?: string; claim_kind?: string;
  assertion?: string; viewport?: string; measurement?: unknown; self_confirming: boolean; capture_complete?: boolean; incomplete_reasons?: string[]; capture_context?: unknown; evidence_tier?: string;
}
export async function insertEvidence(db: Db, auditId: string, rows: EvidenceInput[]): Promise<number> {
  let n = 0;
  for (const e of rows) {
    const r = await db.query(
      `INSERT INTO evidence (audit_run_id, id, type, source_class, page_url, page_id, page_path, page_type, page_type_reason, page_group, category, description, artifact_reference, screenshot_reference,
         selector_or_region, excerpt, detector_id, claim_kind, assertion, viewport, measurement, self_confirming, capture_complete, incomplete_reasons, capture_context, evidence_tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       ON CONFLICT (audit_run_id, id) DO NOTHING`,
      [auditId, e.id, e.type, e.source_class, e.page_url, e.page_id ?? null, e.page_path ?? null, e.page_type ?? null, e.page_type_reason ?? null, e.page_group ?? null, e.category ?? null, e.description, e.artifact_reference,
        e.screenshot_reference ?? null, JSON.stringify(e.selector_or_region), e.excerpt ?? null, e.detector_id ?? null, e.claim_kind ?? null, e.assertion ?? null, e.viewport ?? null,
        e.measurement === undefined ? null : JSON.stringify(e.measurement), e.self_confirming, e.capture_complete ?? null, e.incomplete_reasons ?? null,
        e.capture_context === undefined ? null : JSON.stringify(e.capture_context), e.evidence_tier ?? null],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
export async function updateEvidenceMeasurement(db: Db, auditId: string, id: string, measurement: unknown, excerpt?: string): Promise<void> {
  await db.query("UPDATE evidence SET measurement = $3::jsonb, excerpt = COALESCE($4, excerpt) WHERE audit_run_id = $1 AND id = $2", [auditId, id, JSON.stringify(measurement), excerpt ?? null]);
}
