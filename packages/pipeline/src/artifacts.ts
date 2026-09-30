/** Сховище артефактів (F3): <ARTIFACT_DIR>/<auditId>/…; TTL-прибирання; видалення аудиту цілком (диск + БД + черга). */
import { mkdirSync, readdirSync, rmSync, lstatSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { AUDIT_ID_RE } from "./ids.js";

export function auditDir(artifactDir: string, auditId: string): string {
  if (!AUDIT_ID_RE.test(auditId)) throw new Error(`некоректний auditId для шляху: ${JSON.stringify(auditId).slice(0, 40)}`);
  return path.join(artifactDir, auditId);
}
export function ensureAuditDir(artifactDir: string, auditId: string): string {
  const d = auditDir(artifactDir, auditId);
  mkdirSync(d, { recursive: true });
  return d;
}

export interface TreeStats { files: number; bytes: number }
export function treeStats(dir: string): TreeStats {
  const out: TreeStats = { files: 0, bytes: 0 };
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else {
        out.files++;
        out.bytes += st.size;
      }
    }
  };
  walk(dir);
  return out;
}

/** Видаляє каталог аудиту (тільки під artifactDir; символічні посилання не розкриваються). */
export function removeAuditDir(artifactDir: string, auditId: string): TreeStats {
  const d = auditDir(artifactDir, auditId);
  const before = treeStats(d);
  rmSync(d, { recursive: true, force: true });
  return before;
}

export interface DeleteReport { audit_id: string; existed: boolean; files_removed: number; bytes_removed: number; queue_jobs_removed: number; rows_before: Record<string, number> }

const AUDIT_TABLES = ["page_artifacts", "evidence", "audit_jobs", "llm_calls", "customer_tasks", "site_profiles", "behavioral_lenses", "scenarios", "synthetic_sessions", "findings", "finding_evidence", "recommendations", "audit_reports"] as const;
export const auditRowCounts = async (pool: Pool, id: string): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of AUDIT_TABLES) out[t] = Number((await pool.query(`SELECT count(*) AS n FROM ${t} WHERE audit_run_id = $1`, [id])).rows[0].n);
  return out;
};

/** F3: видалення аудиту цілком. Порядок: БД (каскад) + черга в одній транзакції, потім диск. Повторний виклик — no-op. */
export async function deleteAuditFully(pool: Pool, artifactDir: string, id: string): Promise<DeleteReport> {
  const rep: DeleteReport = { audit_id: id, existed: false, files_removed: 0, bytes_removed: 0, queue_jobs_removed: 0, rows_before: {} };
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    rep.existed = (await c.query("SELECT 1 FROM audit_runs WHERE id = $1 FOR UPDATE", [id])).rowCount === 1;
    if (rep.existed) rep.rows_before = await auditRowCounts(pool, id);
    const has = (await c.query("SELECT to_regclass('pgboss.job') AS t")).rows[0].t !== null;
    if (has) rep.queue_jobs_removed = (await c.query("DELETE FROM pgboss.job WHERE data->>'auditRunId' = $1", [id])).rowCount ?? 0;
    await c.query("DELETE FROM audit_runs WHERE id = $1", [id]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  const s = removeAuditDir(artifactDir, id);
  rep.files_removed = s.files;
  rep.bytes_removed = s.bytes;
  return rep;
}

export interface SweepReport { now: string; expired: Array<{ audit_id: string; files_removed: number }>; kept: number }

/** TTL: аудити з artifact_expires_at ≤ now без artifacts_deleted_at → каталог видаляється, час фіксується. Рядки БД лишаються (метадані). */
export async function sweepExpiredArtifacts(pool: Pool, artifactDir: string, now = new Date()): Promise<SweepReport> {
  const due = (await pool.query("SELECT id FROM audit_runs WHERE artifacts_deleted_at IS NULL AND artifact_expires_at IS NOT NULL AND artifact_expires_at <= $1 AND status IN ('completed','failed') ORDER BY artifact_expires_at", [now])).rows as Array<{ id: string }>;
  const rep: SweepReport = { now: now.toISOString(), expired: [], kept: 0 };
  for (const r of due) {
    const s = removeAuditDir(artifactDir, r.id);
    await pool.query("UPDATE audit_runs SET artifacts_deleted_at = $2, updated_at = now() WHERE id = $1", [r.id, now]);
    rep.expired.push({ audit_id: r.id, files_removed: s.files });
  }
  rep.kept = Number((await pool.query("SELECT count(*) AS n FROM audit_runs WHERE artifacts_deleted_at IS NULL")).rows[0].n);
  return rep;
}
