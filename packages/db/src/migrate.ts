/**
 * Forward-only міграції: файли `NNN_name.sql` за порядком, кожен — в одній транзакції; застосовані фіксуються в
 * `schema_migrations(version, checksum)`. Змінений застосований файл → помилка (заборонено переписувати історію).
 * pg-boss створює свою схему `pgboss` сам (DEV-1) — тут її немає.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

export interface MigrationResult { applied: string[]; skipped: string[] }

export async function migrate(connectionString: string, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  const res: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock(7325001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Map<string, string>((await client.query("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version as string, r.checksum as string]));
    for (const f of files) {
      const sql = readFileSync(path.join(dir, f), "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      const prev = done.get(f);
      if (prev !== undefined) {
        if (prev !== sum) throw new Error(`міграція ${f} змінена після застосування (checksum ${prev.slice(0, 8)} ≠ ${sum.slice(0, 8)}); міграції forward-only — додайте нову`);
        res.skipped.push(f);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [f, sum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`міграція ${f} не застосована: ${(e as Error).message}`);
      }
      res.applied.push(f);
    }
    for (const v of done.keys()) if (!files.includes(v)) throw new Error(`у БД застосована міграція ${v}, якої немає в каталозі (forward-only: файли не видаляють)`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(7325001)").catch(() => undefined);
    await client.end();
  }
  return res;
}
