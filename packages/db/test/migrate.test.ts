/** Міграції: forward-only, на ПОРОЖНІЙ БД кожного прогону; негативні контролі (зміна застосованого файлу, зникнення файлу, збій у транзакції). */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR } from "../src/index.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";

let cluster: TestCluster;
const tmpDirs: string[] = [];
const copyMigrations = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "sl-mig-"));
  tmpDirs.push(d);
  cpSync(MIGRATIONS_DIR, d, { recursive: true });
  return d;
};
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

beforeAll(async () => {
  cluster = await startTestCluster(); // гучно падає, якщо embedded-postgres не стартує (напр. під root)
}, 90_000);
afterAll(async () => cluster?.stop());

describe("тестовий кластер (охоронець)", () => {
  it("embedded-postgres піднято, міграції застосовано з порожньої БД цього прогону", () => {
    expect(cluster.applied).toEqual(["001_init.sql", "002_pipeline.sql", "003_report.sql"]);
  });
});

describe("migrate()", () => {
  let db: FreshDb;
  beforeAll(async () => {
    db = await freshDatabase(cluster.url, { migrate: false });
  });
  afterAll(async () => db?.drop());

  it("порожня БД → застосовує всі файли за порядком; повтор → нічого не застосовує", async () => {
    const a = await migrate(db.url);
    expect(a.applied).toEqual(["001_init.sql", "002_pipeline.sql", "003_report.sql"]);
    const b = await migrate(db.url);
    expect(b.applied).toEqual([]);
    expect(b.skipped).toEqual(a.applied);
  });

  it("схема: очікувані таблиці/колонки S2 є; заборонених (market share, TAM, uplift) немає", async () => {
    const cols = (await db.pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'")).rows as Array<{ table_name: string; column_name: string }>;
    const has = (t: string, c: string) => cols.some((x) => x.table_name === t && x.column_name === c);
    for (const [t, c] of [["audit_runs", "language"], ["audit_runs", "tokens_input"], ["audit_runs", "error_class"], ["audit_runs", "warnings"], ["audit_jobs", "job_key"], ["page_artifacts", "technical_json"], ["evidence", "artifact_reference"]] as const)
      expect(has(t, c), `${t}.${c}`).toBe(true);
    const forbidden = cols.filter((x) => /market_?share|(^|_)tam($|_)|uplift|revenue/i.test(x.column_name));
    expect(forbidden).toEqual([]);
    // калібрування (§59) — лише документ, таблиць немає
    const tables = new Set(cols.map((x) => x.table_name));
    for (const t of ["real_segments", "realsegment", "experiments", "experiment_results", "real_session_metrics"]) expect(tables.has(t)).toBe(false);
  });

  it("CHECK-и працюють: невідомий статус і failed без error_class відхиляються; повна вставка ок", async () => {
    const ins = (id: string, status: string, ec: string | null, err: string | null) =>
      db.pool.query("INSERT INTO audit_runs (id, input_url, normalized_url, domain, status, llm_mode, error, error_class, completed_at) VALUES ($1,'http://a.b/','http://a.b/','a.b',$2,'none',$3,$4, CASE WHEN $2 IN ('completed','failed') THEN now() END)", [id, status, err, ec]);
    await expect(ins("aud_0000000000000001", "weird", null, null)).rejects.toThrow(/chk_audit_runs_status/);
    await expect(ins("aud_0000000000000002", "failed", null, "x")).rejects.toThrow(/chk_audit_runs_failed_class/);
    await expect(ins("aud_0000000000000003", "failed", "not_a_class", "x")).rejects.toThrow(/chk_audit_runs_error_class/);
    await ins("aud_0000000000000004", "failed", "dns_failure", "x");
    await ins("aud_0000000000000005", "queued", null, null);
  });

  it("зміна застосованого файлу → відмова (forward-only), БД не псується", async () => {
    const d = copyMigrations();
    const fresh = await freshDatabase(cluster.url, { migrate: false });
    try {
      await migrate(fresh.url, d);
      writeFileSync(path.join(d, "001_init.sql"), readFileSync(path.join(d, "001_init.sql"), "utf8") + "\n-- tamper\n");
      await expect(migrate(fresh.url, d)).rejects.toThrow(/змінена після застосування/);
    } finally {
      await fresh.drop();
    }
  });

  it("зникнення застосованого файлу → відмова", async () => {
    const d = copyMigrations();
    const fresh = await freshDatabase(cluster.url, { migrate: false });
    try {
      await migrate(fresh.url, d);
      rmSync(path.join(d, "002_pipeline.sql"));
      await expect(migrate(fresh.url, d)).rejects.toThrow(/якої немає в каталозі/);
    } finally {
      await fresh.drop();
    }
  });

  it("збійна міграція відкочується цілком (транзакція) і не записується", async () => {
    const d = copyMigrations();
    writeFileSync(path.join(d, "003_bad.sql"), "CREATE TABLE half_done (id int);\nINSERT INTO nonexistent_table VALUES (1);\n");
    const fresh = await freshDatabase(cluster.url, { migrate: false });
    try {
      await expect(migrate(fresh.url, d)).rejects.toThrow(/003_bad\.sql не застосована/);
      const t = await fresh.pool.query("SELECT to_regclass('half_done') AS t");
      expect(t.rows[0].t).toBeNull();
      const v = await fresh.pool.query("SELECT version FROM schema_migrations ORDER BY version");
      expect(v.rows.map((r) => r.version)).toEqual(["001_init.sql", "002_pipeline.sql", "003_report.sql"]);
    } finally {
      await fresh.drop();
    }
  });
});
