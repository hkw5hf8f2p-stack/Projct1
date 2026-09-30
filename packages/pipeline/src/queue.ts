/**
 * pg-boss (DEV-1): черга в тій самій PostgreSQL. Задачі SPEC §47: crawl_site → capture_page → run_lighthouse / run_accessibility →
 * (LLM-етапи: build_site_profile → generate_tasks → generate_lenses → build_scenario_matrix) → aggregate_findings.
 * Кожна задача ідемпотентна й повторюється (retryLimit, backoff); прогрес — у audit_jobs / audit_runs.stage_status.
 */
import { PgBoss } from "pg-boss";
import type { Db as IDatabase } from "pg-boss";
import type { PoolClient } from "pg";

export const Q = {
  crawl: "crawl_site",
  capture: "capture_page",
  lighthouse: "run_lighthouse",
  accessibility: "run_accessibility",
  profile: "build_site_profile",
  tasks: "generate_tasks",
  lenses: "generate_lenses",
  matrix: "build_scenario_matrix",
  snapshot: "run_snapshot_scenario",
  browser: "run_browser_scenario",
  aggregate: "aggregate_findings",
  report: "generate_report",
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];

export interface QueueSpec { retryLimit: number; retryDelay: number; expireInSeconds: number; heartbeatSeconds: number; concurrency: number }
/** retryLimit — скільки повторів після збою/смерті воркера; heartbeat — pg-boss сам повертає задачу, якщо воркер помер (kill -9). */
export const QUEUE_SPECS: Record<QueueName, QueueSpec> = {
  crawl_site: { retryLimit: 8, retryDelay: 2, expireInSeconds: 3600, heartbeatSeconds: 30, concurrency: 2 },
  capture_page: { retryLimit: 6, retryDelay: 2, expireInSeconds: 600, heartbeatSeconds: 30, concurrency: 1 },
  run_lighthouse: { retryLimit: 3, retryDelay: 3, expireInSeconds: 600, heartbeatSeconds: 30, concurrency: 1 },
  run_accessibility: { retryLimit: 5, retryDelay: 2, expireInSeconds: 300, heartbeatSeconds: 30, concurrency: 2 },
  build_site_profile: { retryLimit: 3, retryDelay: 2, expireInSeconds: 600, heartbeatSeconds: 30, concurrency: 2 },
  generate_tasks: { retryLimit: 3, retryDelay: 2, expireInSeconds: 600, heartbeatSeconds: 30, concurrency: 2 },
  generate_lenses: { retryLimit: 3, retryDelay: 2, expireInSeconds: 600, heartbeatSeconds: 30, concurrency: 2 },
  build_scenario_matrix: { retryLimit: 3, retryDelay: 2, expireInSeconds: 300, heartbeatSeconds: 30, concurrency: 2 },
  run_snapshot_scenario: { retryLimit: 3, retryDelay: 2, expireInSeconds: 600, heartbeatSeconds: 30, concurrency: 4 },
  run_browser_scenario: { retryLimit: 2, retryDelay: 3, expireInSeconds: 1200, heartbeatSeconds: 30, concurrency: 1 },
  generate_report: { retryLimit: 5, retryDelay: 2, expireInSeconds: 300, heartbeatSeconds: 30, concurrency: 2 },
  aggregate_findings: { retryLimit: 5, retryDelay: 2, expireInSeconds: 300, heartbeatSeconds: 30, concurrency: 2 },
};

export interface JobData { auditRunId: string; [k: string]: unknown }

export function createBoss(connectionString: string, o: { supervise?: boolean; max?: number; application_name?: string } = {}): PgBoss {
  return new PgBoss({ connectionString, max: o.max ?? 6, supervise: o.supervise ?? true, schedule: false, application_name: o.application_name ?? "sitelens" });
}

export async function startBoss(boss: PgBoss): Promise<void> {
  boss.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "pg-boss error", err: String(e?.message ?? e).slice(0, 300) })));
  await boss.start();
  for (const [name, s] of Object.entries(QUEUE_SPECS)) {
    await boss.createQueue(name, { retryLimit: s.retryLimit, retryDelay: s.retryDelay, retryBackoff: true, expireInSeconds: s.expireInSeconds, heartbeatSeconds: s.heartbeatSeconds, retentionSeconds: 7 * 86400, deleteAfterSeconds: 7 * 86400 });
  }
}

/** Адаптер: pg-boss виконує send у транзакції нашого клієнта (створення AuditRun і задачі — атомарно). */
export const txDb = (c: PoolClient): IDatabase => ({ executeSql: async (text, values) => ({ rows: (await c.query(text, values as unknown[])).rows }) });

export async function enqueue(boss: PgBoss, name: QueueName, data: JobData, o: { db?: IDatabase; startAfter?: number } = {}): Promise<string | null> {
  return boss.send(name, data, { ...(o.db ? { db: o.db } : {}), ...(o.startAfter ? { startAfter: o.startAfter } : {}) });
}
