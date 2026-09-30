/**
 * GET /api/audits/:id/report і GET /api/audits/:id/artifacts/* (S4, DEV-65, DEV-68) на справжньому PostgreSQL (fastify.inject).
 * Кожна перевірка має контроль: звіт із «+12 % конверсії» не віддається (503); path traversal заблоковано — і «наївна» реалізація на тих самих входах ВИТІКАЄ (вхід реальний).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Report, type Report as ReportT } from "@sitelens/schemas";
import { exampleReport } from "../../../packages/reporting/src/testing/example-report.js";
import { auditDir, completeAudit, createBoss, failAudit, insertAudit, loadConfig, newAuditId, saveReport, startBoss } from "@sitelens/pipeline";
import { buildServer } from "../src/server.js";
import { freshDatabase, startTestCluster, type FreshDb, type TestCluster } from "../../../scripts/test-db.js";

process.env["LOG_LEVEL"] = "silent";
let cluster: TestCluster;
const art = mkdtempSync(path.join(os.tmpdir(), "sl-api-rep-"));
let db: FreshDb;
let boss: PgBoss;
let app: FastifyInstance;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SECRET = Buffer.from("TOP-SECRET-OTHER-AUDIT-BYTES");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const mk = async (state: "queued" | "completed" | "failed"): Promise<string> => {
  const id = newAuditId();
  await insertAudit(db.pool, { id, input_url: "https://example.com/", normalized_url: "https://example.com/", domain: "example.com", language: "uk", llm_mode: "none", ttl_days: 30, config_json: {} });
  if (state === "completed") await completeAudit(db.pool, id);
  if (state === "failed") await failAudit(db.pool, id, "timeout", "Сайт не відповів");
  return id;
};
const store = async (id: string, report: unknown) => saveReport(db.pool, id, { report, sha256: sha(JSON.stringify(report)), schema_version: "x", scoring_version: "y", guard_version: null, guard_events: 0, rejected: [], generated_at: new Date().toISOString() });
const get = (url: string) => app.inject({ method: "GET", url });

let A: string, B: string;
beforeAll(async () => {
  cluster = await startTestCluster();
  db = await freshDatabase(cluster.url);
  boss = createBoss(db.url, { supervise: false, max: 3 });
  await startBoss(boss);
  const cfg = loadConfig({ DATABASE_URL: db.url, ARTIFACT_DIR: art } as NodeJS.ProcessEnv);
  app = await buildServer({ cfg, pool: db.pool, boss, llmMode: "none" });
  A = await mk("completed");
  B = await mk("completed");
  const a = auditDir(art, A), b = auditDir(art, B);
  mkdirSync(path.join(a, "pages/index/1440x1000"), { recursive: true });
  mkdirSync(path.join(b, "pages/x"), { recursive: true });
  writeFileSync(path.join(a, "pages/index/1440x1000/viewport.png"), PNG);
  writeFileSync(path.join(a, "pages/index/notes.txt"), "not served");
  writeFileSync(path.join(a, "pages/index/.hidden.png"), PNG);
  writeFileSync(path.join(a, "pages/index/lighthouse-desktop.json"), '{"ok":true}');
  writeFileSync(path.join(b, "pages/x/secret.png"), SECRET);
  writeFileSync(path.join(art, "outside.png"), SECRET);
  symlinkSync(path.join(art, "outside.png"), path.join(a, "pages/evil.png"));
  symlinkSync(b, path.join(a, "pages/linkdir"));
});
afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false, close: true }).catch(() => undefined);
  await db?.drop();
  await cluster?.stop();
  rmSync(art, { recursive: true, force: true });
});

describe("GET /api/audits/:id/report", () => {
  it("невідомий і некоректний id → 404; аудит виконується → 409 report_not_ready; failed → 404; завершений без звіту → 503 report_unavailable", async () => {
    expect((await get("/api/audits/aud_0000000000000000/report")).statusCode).toBe(404);
    expect((await get("/api/audits/not-an-id/report")).statusCode).toBe(404);
    const q = await mk("queued");
    const r = await get(`/api/audits/${q}/report`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.class).toBe("report_not_ready");
    expect((await get(`/api/audits/${await mk("failed")}/report`)).statusCode).toBe(404);
    const c = await mk("completed");
    const r2 = await get(`/api/audits/${c}/report`);
    expect(r2.statusCode).toBe(503);
    expect(r2.json().error.class).toBe("report_unavailable");
  });

  it("збережений валідний звіт → 200, JSON проходить Report і дорівнює збереженому; no-store", async () => {
    const id = await mk("completed");
    const rep = exampleReport();
    await store(id, rep);
    const r = await get(`/api/audits/${id}/report`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const parsed = Report.parse(r.json());
    expect(parsed.findings.length).toBe(rep.findings.length);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(Report.parse(rep)));
  });

  it("fail-closed: звіт, що не проходить контракт, і звіт із забороненим твердженням НЕ віддаються (503), тіло не містить тексту порушення", async () => {
    const good = JSON.parse(JSON.stringify(exampleReport())) as ReportT;
    const c1 = await mk("completed");
    await store(c1, { ...good, findings: "не масив" });
    const r1 = await get(`/api/audits/${c1}/report`);
    expect(r1.statusCode).toBe(503);
    const c2 = await mk("completed");
    const bad = JSON.parse(JSON.stringify(good)) as ReportT;
    (bad.findings[0]!.problem as { template: string }).template = "Виправлення підніме конверсію на +12 %.";
    await store(c2, bad);
    const r2 = await get(`/api/audits/${c2}/report`);
    expect(r2.statusCode).toBe(503);
    expect(r2.body).not.toContain("12 %");
    // контроль: ТОЙ САМИЙ звіт без порушення віддається
    const c3 = await mk("completed");
    await store(c3, good);
    expect((await get(`/api/audits/${c3}/report`)).statusCode).toBe(200);
  });
});

describe("GET /api/audits/:id/artifacts/* (лише файли цього аудиту; path traversal заборонено)", () => {
  const url = (id: string, ref: string) => `/api/audits/${id}/artifacts/${ref}`;

  it("валідний скриншот → 200, байти збігаються, image/png, nosniff, CSP sandbox; json дозволено, txt — ні", async () => {
    const r = await get(url(A, "pages/index/1440x1000/viewport.png"));
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(sha(r.rawPayload)).toBe(sha(PNG));
    expect((await get(url(A, "pages/index/lighthouse-desktop.json"))).headers["content-type"]).toBe("application/json");
    expect((await get(url(A, "pages/index/notes.txt"))).statusCode).toBe(404);
  });

  const ATTACKS: Array<[string, string]> = [
    ["../B (чужий аудит)", `../${"B"}/pages/x/secret.png`],
    ["%2e%2e/ (кодований)", `%2e%2e/${"B"}/pages/x/secret.png`],
    ["..%2f (кодований слеш)", `..%2f${"B"}%2fpages%2fx%2fsecret.png`],
    ["всередині шляху pages/../..", `pages/../../${"B"}/pages/x/secret.png`],
    ["вихід із ARTIFACT_DIR", "%2e%2e%2f%2e%2e%2foutside.png"],
    ["зворотний слеш", "pages\\..\\..\\outside.png"],
    ["абсолютний шлях", "/etc/passwd"],
    ["подвійний слеш", "//etc/passwd"],
    ["NUL-байт", "pages/index/1440x1000/viewport.png%00.txt"],
    ["символічне посилання на файл поза каталогом", "pages/evil.png"],
    ["символічне посилання на каталог чужого аудиту", "pages/linkdir/pages/x/secret.png"],
    ["каталог", "pages/index"],
    ["прихований файл", "pages/index/.hidden.png"],
    ["крапка-сегмент", "pages/./index/1440x1000/viewport.png"],
    ["порожній сегмент", "pages//index/1440x1000/viewport.png"],
    ["дозволене розширення в невідомому місці", "pages/index/1440x1000/nope.png"],
    ["дуже довгий шлях", "a/".repeat(200) + "x.png"],
  ];
  for (const [name, ref] of ATTACKS) {
    it(`заборонено: ${name} → 404, вмісту чужого файлу немає у відповіді`, async () => {
      const r = await get(url(A, ref));
      expect(r.statusCode, `${ref} → ${r.statusCode}`).toBe(404);
      expect(r.rawPayload.includes(SECRET)).toBe(false);
    });
  }

  it("файл іншого аудиту доступний лише під його власним id (A не бачить pages/x/secret.png, B бачить)", async () => {
    expect((await get(url(A, "pages/x/secret.png"))).statusCode).toBe(404);
    const r = await get(url(B, "pages/x/secret.png"));
    expect(r.statusCode).toBe(200);
    expect(sha(r.rawPayload)).toBe(sha(SECRET));
  });

  it("контроль: НАЇВНА реалізація (path.join без перевірки) на тих самих входах ВИТІКАЄ — атаки реальні, тест умів би впасти", () => {
    const naive = (id: string, ref: string) => { try { return readFileSync(path.join(auditDir(art, id), decodeURIComponent(ref))); } catch { return null; } };
    expect(naive(A, `../${"B"}/pages/x/secret.png`)?.equals(SECRET)).toBe(true);
    expect(naive(A, "%2e%2e%2f%2e%2e%2foutside.png")?.equals(SECRET)).toBe(true);
    expect(naive(A, "pages/evil.png")?.equals(SECRET)).toBe(true); // symlink: навіть «нормалізований» шлях без realpath
  });

  it("невідомий аудит → 404; TTL-видалені артефакти → 404 із поясненням", async () => {
    expect((await get(url("aud_0000000000000000", "pages/index/1440x1000/viewport.png"))).statusCode).toBe(404);
    const d = await mk("completed");
    mkdirSync(path.join(auditDir(art, d), "pages"), { recursive: true });
    writeFileSync(path.join(auditDir(art, d), "pages/a.png"), PNG);
    expect((await get(url(d, "pages/a.png"))).statusCode).toBe(200);
    await db.pool.query("UPDATE audit_runs SET artifacts_deleted_at = now() WHERE id = $1", [d]);
    const r = await get(url(d, "pages/a.png"));
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toContain("TTL");
  });
});
