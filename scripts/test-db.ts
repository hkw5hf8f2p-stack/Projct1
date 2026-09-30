/** Хелпер тестів: окрема свіжа БД (з міграціями) у тестовому кластері, піднятому vitest-global-setup. */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../packages/db/src/index.js";

export interface FreshDb { url: string; name: string; pool: pg.Pool; drop(): Promise<void> }

export async function freshDatabase(baseUrl: string, opts: { migrate?: boolean } = {}): Promise<FreshDb> {
  const name = "t_" + randomBytes(5).toString("hex");
  const admin = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]+$/, "/postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = baseUrl.replace(/\/[^/]+$/, `/${name}`);
  if (opts.migrate !== false) await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  return {
    url, name, pool,
    async drop() {
      await pool.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]+$/, "/postgres") });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await a.end();
    },
  };
}
