/** F3: TTL-прибирання й видалення аудиту цілком — перевірка файловою системою, таблицями БД і чергою pg-boss (100 %). Плюс негативні контролі. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditDir, auditRowCounts, deleteAuditFully, sweepExpiredArtifacts, treeStats } from "../src/artifacts.js";
import { createBoss, enqueue, Q, startBoss } from "../src/queue.js";
import { addWarning, insertAudit, insertEvidence, upsertJob, upsertPage } from "../src/repo.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";
import type { PgBoss } from "pg-boss";

let cluster: TestCluster;
const art = mkdtempSync(path.join(os.tmpdir(), "sl-art-"));
let db: FreshDb;
let boss: PgBoss;
const outside = path.join(art, "..", `outside-${process.pid}.txt`);

const ev = (page_url: string, id: string) => ({ id, type: "dom", source_class: "OBSERVED", page_url, description: "d", artifact_reference: "pages/index/x.json", selector_or_region: { region: { x: 0, y: 0, w: 1, h: 1 } }, detector_id: "d", claim_kind: "horizontal_overflow", assertion: "presence", viewport: "D", category: "mobile_usability", self_confirming: true, capture_complete: true, capture_context: { banner_state: "none", banner_actions: [], blocked_requests_count: 0, js_error_count: 0, scroll_completed: true, layout_stable: true, http_status: 200 } });

async function seedAudit(id: string, o: { expires: string; status?: "completed" | "queued" }) {
  await insertAudit(db.pool, { id, input_url: "http://x.test/", normalized_url: "http://x.test/", domain: "x.test", language: "uk", llm_mode: "none", ttl_days: 30, config_json: {} });
  await db.pool.query("UPDATE audit_runs SET artifact_expires_at = $2::timestamptz, status = $3, completed_at = CASE WHEN $3 = 'completed' THEN now() END WHERE id = $1", [id, o.expires, o.status ?? "completed"]);
  await upsertPage(db.pool, id, { id: "index", url: "http://x.test/", page_type: "homepage", page_type_reason: null, title: "t", http_status: 200, desktop_screenshot: "pages/index/d.png", mobile_screenshot: null, dom_text: null, aria_snapshot: null, visible_text: "v", metadata_json: {}, links_json: [], technical_json: {} });
  await insertEvidence(db.pool, id, [ev("http://x.test/", "ev_" + id.slice(-12))]);
  await upsertJob(db.pool, { audit_run_id: id, job_key: "capture:index", kind: "capture", page_url: "http://x.test/", status: "done", error_class: null, error: null, result_json: {} });
  await addWarning(db.pool, id, { stage: "lighthouse", message: "w" });
  await enqueue(boss, Q.crawl, { auditRunId: id });
  const dir = auditDir(art, id);
  mkdirSync(path.join(dir, "pages/index/1440x1000"), { recursive: true });
  writeFileSync(path.join(dir, "pages/index/1440x1000/fullpage.png"), "PNG");
  writeFileSync(path.join(dir, "evidence.json"), "[]");
}
const jobsFor = async (id: string) => Number((await db.pool.query("SELECT count(*) AS n FROM pgboss.job WHERE data->>'auditRunId' = $1", [id])).rows[0].n);

beforeAll(async () => {
  cluster = await startTestCluster();
  db = await freshDatabase(cluster.url);
  boss = createBoss(db.url, { supervise: false, max: 2 });
  await startBoss(boss);
  writeFileSync(outside, "НЕ ЧІПАТИ");
});
afterAll(async () => {
  await boss?.stop({ graceful: false, close: true }).catch(() => undefined);
  await db?.drop();
  await cluster?.stop();
  rmSync(art, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

describe("TTL", () => {
  it("прострочений (підроблена дата) видаляється, свіжий і незавершений — ні; повтор — no-op", async () => {
    await seedAudit("aud_aaaaaaaaaaaaaaa1", { expires: "2020-01-01T00:00:00Z" });
    await seedAudit("aud_aaaaaaaaaaaaaaa2", { expires: "2099-01-01T00:00:00Z" });
    await seedAudit("aud_aaaaaaaaaaaaaaa3", { expires: "2020-01-01T00:00:00Z", status: "queued" }); // прострочений, але ще виконується
    const beforeFresh = treeStats(auditDir(art, "aud_aaaaaaaaaaaaaaa2"));
    expect(treeStats(auditDir(art, "aud_aaaaaaaaaaaaaaa1")).files).toBe(2);

    const rep = await sweepExpiredArtifacts(db.pool, art, new Date("2026-09-30T00:00:00Z"));
    expect(rep.expired.map((e) => e.audit_id)).toEqual(["aud_aaaaaaaaaaaaaaa1"]);
    expect(existsSync(auditDir(art, "aud_aaaaaaaaaaaaaaa1"))).toBe(false); // файли зникли
    expect(treeStats(auditDir(art, "aud_aaaaaaaaaaaaaaa2"))).toEqual(beforeFresh); // свіжий — байт у байт
    expect(existsSync(auditDir(art, "aud_aaaaaaaaaaaaaaa3"))).toBe(true); // незавершений не чіпаємо
    const r = (await db.pool.query("SELECT id, artifacts_deleted_at IS NOT NULL AS gone FROM audit_runs WHERE id LIKE 'aud_aaaaaaaaaaaaaaa%' ORDER BY id")).rows;
    expect(r.map((x) => x.gone)).toEqual([true, false, false]);
    expect((await sweepExpiredArtifacts(db.pool, art, new Date("2026-09-30T00:00:00Z"))).expired).toEqual([]);
  });
});

describe("deleteAuditFully", () => {
  it("100 % файлів, рядків усіх таблиць і задач черги видалено; сусідній аудит цілий; повтор — existed=false", async () => {
    await seedAudit("aud_bbbbbbbbbbbbbbb1", { expires: "2099-01-01T00:00:00Z" });
    await seedAudit("aud_bbbbbbbbbbbbbbb2", { expires: "2099-01-01T00:00:00Z" });
    const before = await auditRowCounts(db.pool, "aud_bbbbbbbbbbbbbbb1");
    expect(before["page_artifacts"]).toBe(1);
    expect(before["evidence"]).toBe(1);
    expect(before["audit_jobs"]).toBe(1);
    expect(await jobsFor("aud_bbbbbbbbbbbbbbb1")).toBe(1);
    const otherBefore = await auditRowCounts(db.pool, "aud_bbbbbbbbbbbbbbb2");

    const rep = await deleteAuditFully(db.pool, art, "aud_bbbbbbbbbbbbbbb1");
    expect(rep).toMatchObject({ existed: true, files_removed: 2, queue_jobs_removed: 1 });
    expect(existsSync(auditDir(art, "aud_bbbbbbbbbbbbbbb1"))).toBe(false);
    expect((await db.pool.query("SELECT count(*) AS n FROM audit_runs WHERE id = 'aud_bbbbbbbbbbbbbbb1'")).rows[0].n).toBe("0");
    expect(Object.values(await auditRowCounts(db.pool, "aud_bbbbbbbbbbbbbbb1")).every((n) => n === 0)).toBe(true);
    expect(await jobsFor("aud_bbbbbbbbbbbbbbb1")).toBe(0);
    // сусід
    expect(await auditRowCounts(db.pool, "aud_bbbbbbbbbbbbbbb2")).toEqual(otherBefore);
    expect(await jobsFor("aud_bbbbbbbbbbbbbbb2")).toBe(1);
    expect(existsSync(path.join(auditDir(art, "aud_bbbbbbbbbbbbbbb2"), "evidence.json"))).toBe(true);
    expect((await deleteAuditFully(db.pool, art, "aud_bbbbbbbbbbbbbbb1")).existed).toBe(false);
  });

  it("симлінк усередині каталогу аудиту не веде до видалення цілі поза ним", async () => {
    await seedAudit("aud_ccccccccccccccc1", { expires: "2099-01-01T00:00:00Z" });
    symlinkSync(outside, path.join(auditDir(art, "aud_ccccccccccccccc1"), "link.txt"));
    await deleteAuditFully(db.pool, art, "aud_ccccccccccccccc1");
    expect(existsSync(auditDir(art, "aud_ccccccccccccccc1"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("НЕ ЧІПАТИ");
  });

  it("небезпечні id відхиляються до будь-якої дії з ФС", () => {
    for (const bad of ["../etc", "aud_../../x", "", "aud_ZZZ", "/tmp"]) expect(() => auditDir(art, bad)).toThrow(/некоректний auditId/);
  });
});
