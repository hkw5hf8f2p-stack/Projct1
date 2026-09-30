import type { Job } from "pg-boss";
import { QUEUE_SPECS, advanceStatus, enqueue, getAudit, setStage, txDb, Q, type AuditRow, type JobData, type QueueName } from "@sitelens/pipeline";
import type { Runtime } from "../runtime.js";
import { setTimeout as sleep } from "node:timers/promises";

export class AuditGone extends Error {
  constructor(id: string) {
    super(`audit ${id} видалено або завершено`);
  }
}
export const TERMINAL = new Set(["completed", "failed"]);

/** Аудит існує і не термінальний; інакше null (видалений/завершений — задача — no-op). */
export async function liveAudit(rt: Runtime, id: string): Promise<AuditRow | null> {
  const a = await getAudit(rt.pool, id);
  return a && !TERMINAL.has(a.status) ? a : null;
}

/** Остання спроба: далі pg-boss не повторить — замість throw записуємо збій і рухаємося далі (§47: частковий збій ≠ провал аудиту). */
export const advanceIsFinal = (name: string, retryCount: number): boolean => retryCount >= (QUEUE_SPECS[name as QueueName]?.retryLimit ?? 0);
export const isFinalAttempt = (name: QueueName, job: Job<JobData>): boolean => job.retryCount >= QUEUE_SPECS[name].retryLimit;

export async function waitUntil<T>(fn: () => Promise<T | null>, o: { timeoutMs: number; pollMs?: number }): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - t0 > o.timeoutMs) throw new Error(`очікування перевищило ${o.timeoutMs} мс`);
    await sleep(o.pollMs ?? 300);
  }
}

/**
 * Приєднання після crawl: коли всі очікувані lighthouse/accessibility-задачі мають запис у audit_jobs → ОДИН раз (прапорець у config_json,
 * під FOR UPDATE) виставити стани етапів, статус profiling і поставити build_site_profile. Ідемпотентно: повтор задачі не дублює.
 */
export async function advancePostCrawl(rt: Runtime, auditId: string): Promise<boolean> {
  const c = await rt.pool.connect();
  try {
    await c.query("BEGIN");
    const a = (await c.query("SELECT status, config_json FROM audit_runs WHERE id = $1 FOR UPDATE", [auditId])).rows[0] as { status: string; config_json: Record<string, unknown> } | undefined;
    if (!a || TERMINAL.has(a.status) || !a.config_json["post_crawl_enqueued"] || a.config_json["post_crawl_advanced"]) {
      await c.query("COMMIT");
      return false;
    }
    const expected = (a.config_json["expected_jobs"] as string[] | undefined) ?? [];
    const rows = (await c.query("SELECT job_key, kind, status FROM audit_jobs WHERE audit_run_id = $1 AND kind IN ('lighthouse','accessibility')", [auditId])).rows as Array<{ job_key: string; kind: string; status: string }>;
    const have = new Set(rows.map((r) => r.job_key));
    if (!expected.every((k) => have.has(k))) {
      await c.query("COMMIT");
      return false;
    }
    for (const [kind, stage] of [["lighthouse", "lighthouse"], ["accessibility", "accessibility"]] as const) {
      const mine = rows.filter((r) => r.kind === kind);
      const failed = mine.filter((r) => r.status === "failed").length;
      if (mine.length === 0) await setStage(c, auditId, stage, "skipped", kind === "lighthouse" ? "Lighthouse вимкнено або немає сторінок для прогону" : "немає сторінок");
      else if (failed === mine.length) await setStage(c, auditId, stage, "failed", `усі ${mine.length} прогони завершились помилкою`);
      else await setStage(c, auditId, stage, "done", failed > 0 ? `часткові результати: ${failed} з ${mine.length} прогонів з помилкою` : undefined);
    }
    // §35: знімок сайту зафіксовано — усі сторінки захоплено (snapshot_at у звіті й відтворюваності)
    await c.query("UPDATE audit_runs SET config_json = config_json || '{\"post_crawl_advanced\": true}'::jsonb, snapshot_at = COALESCE(snapshot_at, now()) WHERE id = $1", [auditId]);
    await advanceStatus(c, auditId, "profiling");
    await enqueue(rt.boss, Q.profile, { auditRunId: auditId }, { db: txDb(c) });
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
