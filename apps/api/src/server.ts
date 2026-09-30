/**
 * Fastify API (SPEC §42). Слухає 127.0.0.1 (G0-5). Звіт віддається ЛИШЕ з audit_reports: перед відповіддю — Zod-контракт Report + сканер guard по всьому JSON
 * (fail-closed: якщо не пройшов — 503 report_unavailable, тіло звіту не повертається). Артефакти (скриншоти) — лише файли каталогу цього аудиту.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { AiSettingsInput, CreateAuditRequest, Report, type AiCheckResponse } from "@sitelens/schemas";
import { AnthropicProvider, ClaudeCliProvider, OpenAiProvider, ProviderTimeoutError, type LlmProvider, type LlmRequest } from "@sitelens/llm";
import { classifyAiError } from "./ai-errors.js";
import { scanReport } from "@sitelens/reporting";
import {
  AUDIT_ID_RE, EVIDENCE_ID_RE, AiSettingsError, aiSnapshot, reportProvider, deleteAiKey, recordAiCheck, redactKey, resolveEffectiveAi, saveAiSettings, toAiView, type EffectiveAi, Q, auditDir, deleteAuditFully, enqueue, getAudit, getReportRow, humanMessage, insertAudit, newAuditId, progressSteps, txDb, validateSubmittedUrl,
  type AppConfig, type AuditRow,
} from "@sitelens/pipeline";

export interface ApiDeps { cfg: AppConfig; pool: Pool; boss: PgBoss; /** режим LLM з resolveConfig(env) (обчислює точка входу; тести задають явно) */ llmMode?: "live" | "replay" | "none"; /** приймач логів (тести перевіряють, що токен у лог не потрапляє) */ logStream?: NodeJS.WritableStream; /** env для налаштувань AI (типово process.env; тести підставляють SITELENS_SECRETS_DIR) */ env?: Record<string, string | undefined>; /** фабрика провайдера для POST /api/settings/ai/check (тести); undefined → провайдер недоступний */ providerFactory?: (e: EffectiveAi) => LlmProvider | undefined }

const digest = (s: string) => createHash("sha256").update(s).digest();
export const tokenOk = (given: string | undefined, expected: string): boolean => given !== undefined && timingSafeEqual(digest(given), digest(expected));

/**
 * S8 (DEV-80): `<img>` не шле Authorization, тож скриншоти при ACCESS_TOKEN — через короткоживучий підписаний токен `?st=<exp>.<hmac>`:
 * HMAC(ACCESS_TOKEN, «artifact-v1|<auditId>|<exp>»), TTL 10 хв, прив'язаний до ОДНОГО аудиту, приймається лише GET /api/audits/:id/artifacts/*.
 * Сам ACCESS_TOKEN у URL ніколи не потрапляє; токен видається лише за POST /api/audits/:id/artifact-token з Authorization.
 */
export const ARTIFACT_TOKEN_TTL_S = 600;
const artSig = (accessToken: string, auditId: string, exp: number) => createHmac("sha256", accessToken).update(`artifact-v1|${auditId}|${exp}`).digest("hex");
export const signArtifactToken = (accessToken: string, auditId: string, nowMs = Date.now()): { token: string; exp: number } => {
  const exp = Math.floor(nowMs / 1000) + ARTIFACT_TOKEN_TTL_S;
  return { token: `${exp}.${artSig(accessToken, auditId, exp)}`, exp };
};
export const artifactTokenOk = (given: string | undefined, accessToken: string, auditId: string, nowMs = Date.now()): boolean => {
  const m = given === undefined ? null : /^(\d{1,12})\.([0-9a-f]{64})$/.exec(given);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < nowMs) return false;
  return tokenOk(m[2], artSig(accessToken, auditId, exp));
};
const ART_PATH_RE = /^\/api\/audits\/([A-Za-z0-9_]+)\/artifacts\/[^?]*(?:\?(.*))?$/;
const redactUrl = (u: string) => u.replace(/([?&]st=)[^&]*/g, "$1[redacted]");

type ApiErrClass = "unauthorized" | "rate_limited" | "not_found" | "bad_request" | "internal" | "invalid_url" | "report_not_ready" | "report_unavailable" | "ai_settings_unavailable";
const err = (reply: FastifyReply, code: number, cls: ApiErrClass, message: string) => reply.code(code).send({ error: { class: cls, message } });

function statusView(a: AuditRow, progress: { pages_captured: number; pages_failed: number; lighthouse_done: number; lighthouse_failed: number; scenarios_done: number; scenarios_total: number }) {
  return {
    id: a.id, status: a.status, input_url: a.input_url, normalized_url: a.normalized_url, language: a.language, llm_mode: a.llm_mode,
    created_at: a.created_at.toISOString(), started_at: a.started_at?.toISOString() ?? null, completed_at: a.completed_at?.toISOString() ?? null,
    stage_status: a.stage_status, progress, steps: progressSteps(a), warnings: a.warnings,
    error: a.error_class ? { class: a.error_class, message: a.error ?? humanMessage(a.error_class, a.language) } : null,
    artifacts_deleted: a.artifacts_deleted_at !== null, artifact_expires_at: a.artifact_expires_at?.toISOString() ?? null,
  };
}

function defaultProviderFactory(e: EffectiveAi): LlmProvider | undefined {
  if (e.kind === "claude_cli") return typeof ClaudeCliProvider === "function" ? new ClaudeCliProvider({ model: e.model || undefined }) : undefined;
  if (e.kind === "anthropic") return new AnthropicProvider({ apiKey: e.api_key ?? "", model: e.model });
  if (e.kind === "openai" || e.kind === "openai_compatible") return new OpenAiProvider({ apiKey: e.api_key || "local-no-key", model: e.model, ...(e.base_url ? { baseUrl: e.base_url } : {}) });
  return undefined;
}

const CHECK_REQ: LlmRequest = {
  stage: "site_profile", prompt_id: "settings-check", system: "Respond with the JSON object only.",
  content: [{ type: "text", text: 'Return {"ok": true}.' }],
  output: { name: "ok_check", description: "connectivity check", json_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
  sampling: { max_tokens: 32 }, logical_key: { prompt_id: "settings-check" },
};

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const { cfg, pool, boss } = deps;
  const aiEnv = deps.env ?? process.env;
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info", redact: ["req.headers.authorization", 'req.headers["x-access-token"]', "req.headers.cookie"],
      serializers: { req: (r: { method: string; url: string; headers: Record<string, unknown> }) => ({ method: r.method, url: redactUrl(r.url), headers: r.headers }) }, ...(deps.logStream ? { stream: deps.logStream } : {}) },
    bodyLimit: 8 * 1024,
    trustProxy: false,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!cfg.accessToken || req.url === "/api/health" || req.url.startsWith("/api/health?")) return;
    if (req.method === "GET") {
      const am = ART_PATH_RE.exec(req.url);
      const st = am?.[2] ? new URLSearchParams(am[2]).get("st") ?? undefined : undefined;
      if (am && st !== undefined && artifactTokenOk(st, cfg.accessToken, am[1]!)) return; // лише скриншоти цього аудиту (DEV-80)
    }
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

  // ---- BYO AI: налаштування інсталяції (без облікових записів). Ключ у відповідях НІКОЛИ не повертається; під onRequest-токеном, як усе API.
  const aiErr = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AiSettingsError) {
      if (e.code === "invalid_input") return err(reply, 400, "bad_request", e.message);
      return err(reply, 503, "ai_settings_unavailable", e.message);
    }
    throw e;
  };
  const aiView = () => toAiView(resolveEffectiveAi(aiEnv));
  app.get("/api/settings/ai", async (_req, reply) => { try { return reply.header("Cache-Control", "no-store").send(aiView()); } catch (e) { return aiErr(reply, e); } });
  app.put("/api/settings/ai", async (req, reply) => {
    const b = AiSettingsInput.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: { class: "bad_request", message: "Некоректні налаштування AI", issues: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.code === "custom" ? i.message : `некоректне значення (${i.code})` })) } });
    try { saveAiSettings(b.data, aiEnv); return reply.header("Cache-Control", "no-store").send(aiView()); } catch (e) { return aiErr(reply, e); }
  });
  app.delete("/api/settings/ai/key", async (_req, reply) => { try { deleteAiKey(aiEnv); return reply.header("Cache-Control", "no-store").send(aiView()); } catch (e) { return aiErr(reply, e); } });
  app.post("/api/settings/ai/check", async (_req, reply): Promise<AiCheckResponse | FastifyReply> => {
    let eff: EffectiveAi;
    try { eff = resolveEffectiveAi(aiEnv); } catch (e) { return aiErr(reply, e); }
    const t0 = Date.now();
    const fin = (r: Omit<AiCheckResponse, "latency_ms">): AiCheckResponse => {
      const out: AiCheckResponse = { ...r, latency_ms: Date.now() - t0 };
      if (eff.source === "ui") { try { recordAiCheck({ ok: out.ok, at: new Date().toISOString(), ...(out.error_class ? { error_class: out.error_class } : {}), ...(out.model_reported ? { model_reported: out.model_reported } : {}) }, aiEnv); } catch { /* last_check — зручність, не критично */ } }
      return out;
    };
    if (eff.kind === "none") return fin({ ok: false, error_class: "no_provider" });
    if ((eff.kind === "anthropic" || eff.kind === "openai") && !eff.api_key) return fin({ ok: false, error_class: "no_key" });
    let provider: LlmProvider | undefined;
    try { provider = (deps.providerFactory ?? defaultProviderFactory)(eff); } catch { provider = undefined; }
    if (!provider) return fin({ ok: false, error_class: "provider_not_available" });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const r = await Promise.race([provider.complete(CHECK_REQ, { signal: ac.signal }), new Promise<never>((_, rej) => { ac.signal.addEventListener("abort", () => rej(new ProviderTimeoutError("check timeout"))); })]);
      return fin({ ok: true, model_reported: r.model });
    } catch (e) {
      req_log(reply, e, eff.api_key, eff.kind);
      return fin({ ok: false, error_class: classifyAiError(e, eff.kind) });
    } finally { clearTimeout(timer); }
  });
  const req_log = (reply: FastifyReply, e: unknown, key: string | undefined, kind: EffectiveAi["kind"]) => reply.log.warn({ msg: "ai check failed", class: classifyAiError(e, kind), detail: redactKey((e as Error).message ?? "", key).slice(0, 200) }, "ai check failed");

  app.get("/api/health", async () => ({ ok: true, db: (await pool.query("SELECT 1 AS ok")).rows[0].ok === 1 }));

  app.post("/api/audits", async (req, reply) => {
    const body = CreateAuditRequest.safeParse(req.body);
    if (!body.success) return err(reply, 400, "bad_request", 'Очікується JSON {"url": "https://…"}');
    const language = body.data.language ?? "uk";
    const chk = validateSubmittedUrl(body.data.url, cfg);
    if (!chk.ok) return err(reply, 400, "invalid_url", humanMessage("invalid_url", language, chk.reason));

    let eff: EffectiveAi | null = null;
    try { eff = resolveEffectiveAi(aiEnv); } catch (e) { return aiErr(reply, e); }
    const snap = eff.source === "ui" ? aiSnapshot(eff) : null;
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
        id, input_url: body.data.url.trim(), normalized_url: chk.url, domain: chk.domain, language, llm_mode: snap ? (snap.kind === "none" ? "none" : "live") : deps.llmMode ?? "none", ttl_days: cfg.artifactTtlDays,
        config_json: { max_pages: cfg.maxPages, max_depth: cfg.maxDepth, max_products: cfg.maxProducts, fixture: chk.fixture, lighthouse: cfg.lighthouse, ...(snap ? { ai: snap } : {}) },
      });
      // BYO AI: знімок провайдера+моделі (без ключа) — звіт показує, чим зроблено; зміна налаштувань під час аудиту на нього не діє
      if (snap && snap.kind !== "none") await c.query("UPDATE audit_runs SET llm_provider = $2, llm_model = $3 WHERE id = $1", [id, reportProvider(snap.provider, snap.kind), snap.model]);
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
                (SELECT count(*) FROM audit_jobs WHERE audit_run_id = $1 AND kind = 'lighthouse' AND status = 'failed')::int AS lighthouse_failed,
                (SELECT count(*) FROM audit_jobs WHERE audit_run_id = $1 AND kind IN ('snapshot','browser'))::int AS scenarios_done,
                COALESCE((SELECT jsonb_array_length(config_json->'expected_scenarios') FROM audit_runs WHERE id = $1), 0)::int AS scenarios_total`,
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
        `SELECT p.id, p.url, p.page_type, p.page_type_reason, p.title, p.http_status, p.desktop_screenshot, p.mobile_screenshot, p.technical_json->'capture_error' AS capture_error, COALESCE(p.technical_json->'egress_denied', '[]'::jsonb) AS egress_denied,
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
        capture_ok: r.capture_error === null, capture_error: r.capture_error, egress_denied: r.egress_denied, evidence_count: r.evidence_count,
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

  // GET /api/audits/:id/report — звіт за контрактом Report (DEV-65). Не готовий → 409; заблоковано guard/контрактом → 503; ніколи не «сирий» вміст.
  app.get<{ Params: { id: string } }>("/api/audits/:id/report", async (req, reply) => {
    const a = await loadAudit(req.params.id, reply);
    if (!a) return reply;
    if (a.status !== "completed" && a.status !== "failed") return err(reply, 409, "report_not_ready", "Звіт ще не готовий: аудит виконується");
    if (a.status === "failed") return err(reply, 404, "not_found", "Аудит завершився помилкою: звіту немає");
    const row = await getReportRow(pool, a.id);
    if (!row) return err(reply, 503, "report_unavailable", "Звіт недоступний: його не створено або заблоковано перевіркою (fail-closed)");
    const parsed = Report.safeParse(row.report);
    if (!parsed.success) {
      req.log.error({ audit: a.id, issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join("/")}: ${i.message}`) }, "збережений звіт не проходить контракт — не віддається");
      return err(reply, 503, "report_unavailable", "Звіт недоступний: збережений звіт не проходить перевірку контракту");
    }
    const scan = scanReport(parsed.data);
    if (!scan.clean) {
      req.log.error({ audit: a.id, violations: scan.violations.slice(0, 3).map((v) => ({ ptr: v.ptr, kind: v.kind, rules: v.rule_ids })) }, "guard-скан звіту знайшов порушення — не віддається");
      return err(reply, 503, "report_unavailable", "Звіт недоступний: він не пройшов перевірку guard (fail-closed)");
    }
    return reply.header("Cache-Control", "no-store").send(parsed.data);
  });

  // GET /api/audits/:id/artifacts/<шлях відносно каталогу аудиту> — скриншоти/регіони доказів. Лише файли ЦЬОГО аудиту; будь-який вихід за каталог → 404.
  app.get<{ Params: { id: string; "*": string } }>("/api/audits/:id/artifacts/*", async (req, reply) => {
    const a = await loadAudit(req.params.id, reply);
    if (!a) return reply;
    const nf = () => err(reply, 404, "not_found", "Артефакт не знайдено");
    if (a.artifacts_deleted_at !== null) return err(reply, 404, "not_found", "Артефакти цього аудиту видалено (TTL)");
    const ref = req.params["*"] ?? "";
    const seg = ref.split("/");
    // список дозволеного, а не заборонного: сегменти [A-Za-z0-9._-], без «.»/«..»/порожніх, без NUL/\; лише відомі розширення
    if (ref.length === 0 || ref.length > 300 || !seg.every((x) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(x))) return nf();
    const ext = path.extname(ref).toLowerCase();
    const type = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json" } as Record<string, string>)[ext];
    if (!type) return nf();
    const root = auditDir(cfg.artifactDir, a.id);
    const full = path.resolve(root, ref);
    if (!full.startsWith(root + path.sep)) return nf();
    try {
      const st = await lstat(full);
      if (!st.isFile()) return nf(); // символічні посилання й каталоги не віддаємо
      const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
      if (!realFull.startsWith(realRoot + path.sep)) return nf();
    } catch {
      return nf();
    }
    return reply.header("Content-Type", type).header("Cache-Control", "private, max-age=3600").header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'; sandbox").send(createReadStream(full));
  });

  // DEV-80: видає короткоживучий токен для `<img src=…?st=…>`; вимагає повноцінної автентифікації (onRequest). Без ACCESS_TOKEN токен не потрібен → null.
  app.post<{ Params: { id: string } }>("/api/audits/:id/artifact-token", async (req, reply) => {
    const a = await loadAudit(req.params.id, reply);
    if (!a) return reply;
    if (!cfg.accessToken) return reply.header("Cache-Control", "no-store").send({ token: null, expires_at: null });
    const { token, exp } = signArtifactToken(cfg.accessToken, a.id);
    return reply.header("Cache-Control", "no-store").send({ token, expires_at: new Date(exp * 1000).toISOString() });
  });

  app.delete<{ Params: { id: string } }>("/api/audits/:id", async (req, reply) => {
    if (!AUDIT_ID_RE.test(req.params.id)) return err(reply, 404, "not_found", "Аудит не знайдено");
    const rep = await deleteAuditFully(pool, cfg.artifactDir, req.params.id);
    if (!rep.existed) return err(reply, 404, "not_found", "Аудит не знайдено");
    return { deleted: true, auditId: rep.audit_id, files_removed: rep.files_removed, queue_jobs_removed: rep.queue_jobs_removed };
  });

  return app;
}
