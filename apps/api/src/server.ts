/** Fastify API S2 (SPEC §42). Слухає 127.0.0.1 (G0-5); не повертає LLM-тексту (у S2 його немає) — guard звіту підключається в S4. */
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { CreateAuditRequest } from "@sitelens/schemas";
import {
  AUDIT_ID_RE, EVIDENCE_ID_RE, Q, deleteAuditFully, enqueue, getAudit, humanMessage, insertAudit, newAuditId, txDb, validateSubmittedUrl,
  type AppConfig, type AuditRow,
} from "@sitelens/pipeline";

export interface ApiDeps { cfg: AppConfig; pool: Pool; boss: PgBoss }

const digest = (s: string) => createHash("sha256").update(s).digest();
export const tokenOk = (given: string | undefined, expected: string): boolean => given !== undefined && timingSafeEqual(digest(given), digest(expected));

type ApiErrClass = "unauthorized" | "rate_limited" | "not_found" | "bad_request" | "internal" | "invalid_url";
const err = (reply: FastifyReply, code: number, cls: ApiErrClass, message: string) => reply.code(code).send({ error: { class: cls, message } });

function llmModeFor(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): "live" | "replay" | "none" {
  const p = cfg.llmProvider;
  if (!p || p === "none") return "none";
  if (p === "replay") return "replay";
  if (p === "anthropic") return env["ANTHROPIC_API_KEY"] ? "live" : "none";
  if (p === "openai") return env["OPENAI_API_KEY"] ? "live" : "none";
  return "none";
}

function statusView(a: AuditRow, progress: { pages_captured: number; pages_failed: number; lighthouse_done: number; lighthouse_failed: number }) {
  return {
    id: a.id, status: a.status, input_url: a.input_url, normalized_url: a.normalized_url, language: a.language, llm_mode: a.llm_mode,
    created_at: a.created_at.toISOString(), started_at: a.started_at?.toISOString() ?? null, completed_at: a.completed_at?.toISOString() ?? null,
    stage_status: a.stage_status, progress, warnings: a.warnings,
    error: a.error_class ? { class: a.error_class, message: a.error ?? humanMessage(a.error_class, a.language) } : null,
    artifacts_deleted: a.artifacts_deleted_at !== null, artifact_expires_at: a.artifact_expires_at?.toISOString() ?? null,
  };
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const { cfg, pool, boss } = deps;
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info", redact: ["req.headers.authorization", 'req.headers["x-access-token"]', "req.headers.cookie"] },
    bodyLimit: 8 * 1024,
    trustProxy: false,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!cfg.accessToken || req.url === "/api/health" || req.url.startsWith("/api/health?")) return;
    const h = req.headers.authorization;
    const given = (typeof h === "string" && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : undefined) ?? (typeof req.headers["x-access-token"] === "string" ? req.headers["x-access-token"] : undefined);
    if (!tokenOk(given, cfg.accessToken)) return err(reply, 401, "unauthorized", "Потрібен ACCESS_TOKEN (Authorization: Bearer …)");
  });

  app.setErrorHandler((e: Error, req, reply) => {
    const status = (e as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) return err(reply, status, "bad_request", "Некоректний запит");
    req.log.error({ err: { message: e.message } }, "internal error");
    return err(reply, 500, "internal", "Внутрішня помилка сервера");
  });
  app.setNotFoundHandler((_req, reply) => err(reply, 404, "not_found", "Не знайдено"));

  app.get("/api/health", async () => ({ ok: true, db: (await pool.query("SELECT 1 AS ok")).rows[0].ok === 1 }));

  app.post("/api/audits", async (req, reply) => {
    const body = CreateAuditRequest.safeParse(req.body);
    if (!body.success) return err(reply, 400, "bad_request", 'Очікується JSON {"url": "https://…"}');
    const language = body.data.language ?? "uk";
    const chk = validateSubmittedUrl(body.data.url, cfg);
    if (!chk.ok) return err(reply, 400, "invalid_url", humanMessage("invalid_url", language, chk.reason));

    const id = newAuditId();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(7325002)"); // лічильники ліміту без гонок між паралельними POST
      // B2: ліміт аудитів/год — лише коли ACCESS_TOKEN задано; лічильник у БД переживає рестарт API
      if (cfg.accessToken) {
        const n = Number((await c.query("SELECT count(*) AS n FROM audit_runs WHERE created_at > now() - interval '1 hour'")).rows[0].n);
        if (n >= cfg.rateLimitPerHour) {
          await c.query("ROLLBACK");
          reply.header("Retry-After", "3600");
          return err(reply, 429, "rate_limited", `Перевищено ліміт ${cfg.rateLimitPerHour} аудитів на годину`);
        }
      }
      // DEV-18: ≤ 5 аудитів на сайт за добу (чужі сайти). Локальні фікстури не обмежуємо.
      if (!chk.fixture) {
        const n = Number((await c.query("SELECT count(*) AS n FROM audit_runs WHERE domain = $1 AND created_at > now() - interval '1 day'", [chk.domain])).rows[0].n);
        if (n >= cfg.domainLimitPerDay) {
          await c.query("ROLLBACK");
          reply.header("Retry-After", "86400");
          return err(reply, 429, "rate_limited", `Не більше ${cfg.domainLimitPerDay} аудитів на один сайт за добу (етика звернень, DEV-18)`);
        }
      }
      await insertAudit(c, {
        id, input_url: body.data.url.trim(), normalized_url: chk.url, domain: chk.domain, language, llm_mode: llmModeFor(cfg), ttl_days: cfg.artifactTtlDays,
        config_json: { max_pages: cfg.maxPages, max_depth: cfg.maxDepth, max_products: cfg.maxProducts, fixture: chk.fixture, lighthouse: cfg.lighthouse },
      });
      // §55.13: аудит і його перша задача з'являються ОДНОЧАСНО (одна транзакція) — kill -9 API посередині не лишає «сироту»
      await enqueue(boss, Q.crawl, { auditRunId: id }, { db: txDb(c) });
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return reply.code(202).header("Location", `/api/audits/${id}`).send({ auditId: id });
  });

  const loadAudit = async (id: string, reply: FastifyReply): Promise<AuditRow | null> => {
    if (!AUDIT_ID_RE.test(id)) {
      await err(reply, 404, "not_found", "Аудит не знайдено");
      return null;
    }
    const a = await getAudit(pool, id);
    if (!a) {
      await err(reply, 404, "not_found", "Аудит не знайдено");
      return null;
    }
    return a;
  };

  app.get<{ Params: { id: string } }>("/api/audits/:id", async (req, reply) => {
    const a = await loadAudit(req.params.id, reply);
    if (!a) return reply;
    const p = (
      await pool.query(
        `SELECT (SELECT count(*) FROM page_artifacts WHERE audit_run_id = $1 AND NOT (technical_json ? 'capture_error'))::int AS pages_captured,
                (SELECT count(*) FROM page_artifacts WHERE audit_run_id = $1 AND technical_json ? 'capture_error')::int AS pages_failed,
                (SELECT count(*) FROM audit_jobs WHERE audit_run_id = $1 AND kind = 'lighthouse' AND status = 'done')::int AS lighthouse_done,
                (SELECT count(*) FROM audit_jobs WHERE audit_run_id = $1 AND kind = 'lighthouse' AND status = 'failed')::int AS lighthouse_failed`,
        [a.id],
      )
    ).rows[0];
    return statusView(a, p);
  });

  app.get<{ Params: { id: string } }>("/api/audits/:id/pages", async (req, reply) => {
    const a = await loadAudit(req.params.id, reply);
    if (!a) return reply;
    const rows = (
      await pool.query(
        `SELECT p.id, p.url, p.page_type, p.page_type_reason, p.title, p.http_status, p.desktop_screenshot, p.mobile_screenshot, p.technical_json->'capture_error' AS capture_error,
                (SELECT count(*) FROM evidence e WHERE e.audit_run_id = p.audit_run_id AND e.page_url = p.url)::int AS evidence_count
         FROM page_artifacts p WHERE p.audit_run_id = $1 ORDER BY p.created_at, p.id`,
        [a.id],
      )
    ).rows;
    const gone = a.artifacts_deleted_at !== null;
    return {
      auditId: a.id, artifacts_deleted: gone,
      pages: rows.map((r) => ({
        id: r.id, url: r.url, page_type: r.page_type, page_type_reason: r.page_type_reason, title: r.title, http_status: r.http_status,
        screenshots: gone ? null : { desktop: r.desktop_screenshot, mobile: r.mobile_screenshot },
        capture_ok: r.capture_error === null, capture_error: r.capture_error, evidence_count: r.evidence_count,
      })),
    };
  });

  app.get<{ Params: { id: string; evidenceId: string } }>("/api/audits/:id/evidence/:evidenceId", async (req, reply) => {
    const a = await loadAudit(req.params.id, reply);
    if (!a) return reply;
    if (!EVIDENCE_ID_RE.test(req.params.evidenceId)) return err(reply, 404, "not_found", "Доказ не знайдено");
    const r = (await pool.query("SELECT * FROM evidence WHERE audit_run_id = $1 AND id = $2", [a.id, req.params.evidenceId])).rows[0];
    if (!r) return err(reply, 404, "not_found", "Доказ не знайдено");
    const { audit_run_id: _a, ...rest } = r;
    void _a;
    return { auditId: a.id, evidence: { ...rest, created_at: rest.created_at.toISOString() }, artifacts_deleted: a.artifacts_deleted_at !== null };
  });

  app.delete<{ Params: { id: string } }>("/api/audits/:id", async (req, reply) => {
    if (!AUDIT_ID_RE.test(req.params.id)) return err(reply, 404, "not_found", "Аудит не знайдено");
    const rep = await deleteAuditFully(pool, cfg.artifactDir, req.params.id);
    if (!rep.existed) return err(reply, 404, "not_found", "Аудит не знайдено");
    return { deleted: true, auditId: rep.audit_id, files_removed: rep.files_removed, queue_jobs_removed: rep.queue_jobs_removed };
  });

  return app;
}
