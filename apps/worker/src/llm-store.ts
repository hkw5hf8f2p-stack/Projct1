/**
 * Збереження виходів LLM-етапів у БД (site_profiles, customer_tasks, behavioral_lenses, scenarios, synthetic_sessions, llm_calls) і зворотне читання.
 * Кожен етап пишеться в ОДНІЙ транзакції разом зі станом етапу й лічильником токенів (повтор після kill -9 не дублює й не подвоює токени).
 */
import type { Pool, PoolClient } from "pg";
import { POLES, sha256, type CallRecord, type LlmClient, type PageInput, type SiteProfileCore, type StageResult, loadPagesFromArtifacts } from "@sitelens/llm";
import { addUsage, auditDir, insertLlmCalls, setStage, type LlmCallRow } from "@sitelens/pipeline";
import { BehavioralLens, LENS_VARIABLES, Task, type Evidence } from "@sitelens/schemas";
import { integrateSessions, type LlmResults, type LlmText, type SessionResultIn } from "@sitelens/reporting";
import type { AuditArtifacts } from "@sitelens/reporting";
import { materializePages } from "./artifacts.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** PageInput сторінки прямо з рядка БД (як loadPagesFromArtifacts, але без читання pages.json) + скриншот першого вікна потрібного пристрою (D4: t0 = перше вікно, не full-page) */
export function pageInputFromRow(dir: string, r: Record<string, unknown>, device: "desktop" | "mobile" = "desktop"): { page: PageInput; viewportHeight: number | null; imageRel: string | null } {
  const md = (r["metadata_json"] ?? {}) as { meta_description?: string; headings?: Array<{ text: string }> };
  const tj = (r["technical_json"] ?? {}) as { screenshots?: Record<string, { viewport?: { file?: string } }>; viewports?: Record<string, [number, number, number]> };
  const vp = device === "mobile" ? "M" : "D";
  const rel = tj.screenshots?.[vp]?.viewport?.file ?? null;
  const abs = rel ? path.join(dir, rel) : null;
  const image = abs && existsSync(abs) ? { type: "image" as const, media_type: "image/png" as const, sha256: sha256(readFileSync(abs)), path: abs, label: `${r["id"]} first viewport ${vp}` } : null;
  const links = (r["links_json"] as Array<{ text: string; visible: boolean }>) ?? [];
  return {
    page: {
      id: r["id"] as string, url: r["url"] as string, page_type: r["page_type"] as string, title: (r["title"] as string | null) ?? "", meta_description: md.meta_description ?? "",
      headings: (md.headings ?? []).map((h) => h.text), visible_text: (r["visible_text"] as string | null) ?? "", link_texts: links.filter((l) => l.visible).map((l) => l.text).filter(Boolean), image,
    },
    viewportHeight: tj.viewports?.[vp]?.[1] ?? null, imageRel: image ? rel : null,
  };
}

export async function loadPageInputs(pool: Pool, artifactDir: string, auditId: string): Promise<PageInput[]> {
  await materializePages(pool, artifactDir, auditId);
  return loadPagesFromArtifacts(auditDir(artifactDir, auditId));
}

export const callRows = (client: LlmClient, calls: readonly CallRecord[], auditId: string): LlmCallRow[] =>
  calls.map((r) => {
    const x = client.toLlmCall(r, auditId, r.stage as never);
    return { id: x.id, stage: x.stage, prompt_version: x.prompt_version, provider: x.provider, model: x.model, request_hash: x.request_hash, response_json: x.response_json, status: x.status, error: x.error, input_tokens: x.input_tokens, output_tokens: x.output_tokens, latency_ms: x.latency_ms };
  });

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const v = await fn(c);
    await c.query("COMMIT");
    return v;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** llm_calls + токени + провайдер/модель/версія промпту (§35) для набору викликів; викликається всередині транзакції етапу/сценарію */
export async function recordCalls(c: PoolClient, client: LlmClient, auditId: string, tag: string, calls: readonly CallRecord[]): Promise<string[]> {
  const ids = await insertLlmCalls(c, auditId, tag, callRows(client, calls, auditId));
  const first = calls[0];
  await addUsage(c, auditId, {
    input: calls.reduce((a, r) => a + r.input_tokens, 0), output: calls.reduce((a, r) => a + r.output_tokens, 0),
    provider: first ? (first.provider === "anthropic" || first.provider === "openai" ? first.provider : "replay") : null, model: first?.model ?? null, prompt_version: first?.prompt_id ?? null,
  });
  return ids;
}

/** етап закінчено: (done → write) + llm_calls + токени + стан етапу — атомарно */
export async function commitStage(pool: Pool, auditId: string, client: LlmClient, stage: string, res: StageResult<unknown>, write?: (c: PoolClient, callIds: string[]) => Promise<void>, after?: (c: PoolClient) => Promise<void>): Promise<void> {
  await withTx(pool, async (c) => {
    const ids = await recordCalls(c, client, auditId, stage, res.calls);
    if (res.status === "done" && write) await write(c, ids);
    const reason = res.reason ?? (res.flags.length ? res.flags.join(", ").slice(0, 300) : undefined);
    // DEV-81: `awaiting_session_model` (транспорт session) не входить у схему stage_status → в БД `skipped` із причиною «awaiting_session_model: …» (не done, не completed)
    const dbStatus = res.status === "awaiting_session_model" ? "skipped" : res.status;
    await setStage(c, auditId, stage, dbStatus, res.status === "done" ? reason : reason ?? "етап не виконано");
    if (after) await after(c);
  });
}

// ---------------------------------------------------------------- читання збережених виходів
export async function loadProfile(pool: Pool, auditId: string): Promise<SiteProfileCore | null> {
  const r = (await pool.query("SELECT * FROM site_profiles WHERE audit_run_id = $1", [auditId])).rows[0];
  if (!r) return null;
  const { audit_run_id: _a, prompt_version: _p, llm_call_id: _l, ...core } = r;
  void _a; void _p; void _l;
  return core as SiteProfileCore;
}
export async function loadTasks(pool: Pool, auditId: string): Promise<Task[]> {
  const rows = (await pool.query("SELECT * FROM customer_tasks WHERE audit_run_id = $1 ORDER BY task_id", [auditId])).rows;
  return rows.map((r) => Task.parse({ task_id: r.task_id, audit_run_id: auditId, name: r.name, goal: r.goal, success_conditions: r.success_conditions, failure_conditions: r.failure_conditions, recommended_start_page: r.recommended_start_page, max_actions: r.max_actions, task_type: r.task_type, is_primary_goal: r.is_primary_goal }));
}
export async function loadLenses(pool: Pool, auditId: string): Promise<BehavioralLens[]> {
  const rows = (await pool.query("SELECT * FROM behavioral_lenses WHERE audit_run_id = $1 ORDER BY id", [auditId])).rows;
  return rows.map((r) => BehavioralLens.parse({ id: r.id, audit_run_id: auditId, name: r.name, description: r.description, ...Object.fromEntries(LENS_VARIABLES.map((k) => [k, r[k]])), primary_goal: r.primary_goal, likely_questions: r.likely_questions, likely_objections: r.likely_objections }));
}

// ---------------------------------------------------------------- запис виходів
export async function writeProfile(c: PoolClient, auditId: string, p: SiteProfileCore, promptId: string, callId: string | undefined): Promise<void> {
  await c.query(
    `INSERT INTO site_profiles (audit_run_id, business_type, offering_summary, primary_products, price_positioning, primary_conversion_goal, secondary_conversion_goals, site_language, apparent_geography, brand_tone,
       key_value_propositions, trust_signals, purchase_objections, domain_terminology, confidence_notes, prompt_version, llm_call_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (audit_run_id) DO UPDATE SET business_type = EXCLUDED.business_type, offering_summary = EXCLUDED.offering_summary, primary_products = EXCLUDED.primary_products, price_positioning = EXCLUDED.price_positioning,
       primary_conversion_goal = EXCLUDED.primary_conversion_goal, secondary_conversion_goals = EXCLUDED.secondary_conversion_goals, site_language = EXCLUDED.site_language, apparent_geography = EXCLUDED.apparent_geography,
       brand_tone = EXCLUDED.brand_tone, key_value_propositions = EXCLUDED.key_value_propositions, trust_signals = EXCLUDED.trust_signals, purchase_objections = EXCLUDED.purchase_objections,
       domain_terminology = EXCLUDED.domain_terminology, confidence_notes = EXCLUDED.confidence_notes, prompt_version = EXCLUDED.prompt_version, llm_call_id = EXCLUDED.llm_call_id`,
    [auditId, p.business_type, p.offering_summary, p.primary_products, p.price_positioning, p.primary_conversion_goal, p.secondary_conversion_goals, p.site_language, p.apparent_geography, p.brand_tone,
      p.key_value_propositions, p.trust_signals, p.purchase_objections, p.domain_terminology, p.confidence_notes, promptId, callId ?? null],
  );
}
export async function writeTasks(c: PoolClient, auditId: string, tasks: readonly Task[]): Promise<void> {
  for (const t of tasks) {
    await c.query(
      `INSERT INTO customer_tasks (audit_run_id, task_id, name, goal, success_conditions, failure_conditions, recommended_start_page, max_actions, task_type, is_primary_goal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (audit_run_id, task_id) DO NOTHING`,
      [auditId, t.task_id, t.name, t.goal, t.success_conditions, t.failure_conditions, t.recommended_start_page, t.max_actions, t.task_type, t.is_primary_goal ?? false],
    );
  }
}
export async function writeLenses(c: PoolClient, auditId: string, lenses: readonly BehavioralLens[], promptId: string, callId: string | undefined): Promise<void> {
  for (const l of lenses) {
    await c.query(
      `INSERT INTO behavioral_lenses (audit_run_id, id, name, description, ${LENS_VARIABLES.join(", ")}, primary_goal, likely_questions, likely_objections, prompt_version, llm_call_id)
       VALUES ($1,$2,$3,$4,${LENS_VARIABLES.map((_, i) => `$${i + 5}`).join(",")},$15,$16,$17,$18,$19) ON CONFLICT (audit_run_id, id) DO NOTHING`,
      [auditId, l.id, l.name, l.description, ...LENS_VARIABLES.map((k) => l[k]), l.primary_goal, l.likely_questions, l.likely_objections, promptId, callId ?? null],
    );
  }
}
export async function writeScenarios(c: PoolClient, auditId: string, rows: ReadonlyArray<{ id: string; lens_id: string; task_id: string; level: string; relevance: number; device: string | null }>): Promise<void> {
  for (const s of rows) {
    await c.query("INSERT INTO scenarios (audit_run_id, id, lens_id, task_id, level, relevance, selected, device) VALUES ($1,$2,$3,$4,$5,$6,true,$7) ON CONFLICT (audit_run_id, id) DO NOTHING", [auditId, s.id, s.lens_id, s.task_id, s.level, s.relevance, s.device]);
  }
}

// ---------------------------------------------------------------- LlmResults для звіту
export async function loadSessions(pool: Pool, auditId: string): Promise<SessionResultIn[]> {
  const rows = (await pool.query("SELECT * FROM synthetic_sessions WHERE audit_run_id = $1 AND status = 'done' ORDER BY session_id", [auditId])).rows;
  return rows.map((r) => ({ session_id: r.session_id, lens_id: r.lens_id, task_id: r.task_id, level: r.level, success: r.success, frictions: r.frictions, pages_seen: r.pages_seen }));
}

const text = (t: string, sc: LlmText["source_class"], prompt: string): LlmText => ({ text: t, source_class: sc, prompt_id: prompt, guard_status: "pending" });

/**
 * Вхід buildReport з БД для режимів live/replay: докази SYNTHETIC (integrateSessions: §23, цитата звіряється з текстом сторінки), сесії, профіль, лінзи, бюджет.
 * Тексти знахідок від LLM (finding-aggregator/recommendation) тут НЕ підключено: звіт бере кодові шаблони (живий пас, OQ-1 — неперевірено).
 */
export async function llmResultsFromDb(pool: Pool, auditId: string, art: AuditArtifacts, audit: { llm_mode: "live" | "replay" | "none"; llm_provider: string | null; llm_model: string | null }): Promise<{ llm: LlmResults; rejected: ReturnType<typeof integrateSessions>["rejected"] } | null> {
  if (audit.llm_mode === "none") return null;
  const sessions = await loadSessions(pool, auditId);
  const integ = integrateSessions({ sessions, pages: art.pages });
  const profile = await loadProfile(pool, auditId);
  const lenses = await loadLenses(pool, auditId);
  const calls = (await pool.query("SELECT prompt_version, status, input_tokens, output_tokens FROM llm_calls WHERE audit_run_id = $1", [auditId])).rows;
  const sum = (f: (r: { status: string; input_tokens: number | null; output_tokens: number | null }) => boolean) => calls.filter(f).reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
  const PR = "site-profile-v1";
  const su = profile
    ? {
        what_it_sells: text(profile.offering_summary, "INFERRED", PR), positioning: text(profile.business_type, "INFERRED", PR), price_positioning: text(profile.price_positioning, "INFERRED", PR),
        core_value_proposition: text(profile.key_value_propositions[0] ?? profile.offering_summary, "INFERRED", PR), primary_customer_journey: text(profile.primary_conversion_goal, "INFERRED", PR),
        likely_objections: profile.purchase_objections.slice(0, 5).map((o) => text(o, "INFERRED", PR)),
      }
    : null;
  const provider = (audit.llm_provider === "anthropic" || audit.llm_provider === "openai" || audit.llm_provider === "replay" ? audit.llm_provider : "replay") as LlmResults["provider"];
  const llm: LlmResults = {
    mode: audit.llm_mode === "live" ? "live" : "replay", provider, model: audit.llm_model ?? "unknown",
    prompt_versions: [...new Set(calls.map((r) => r.prompt_version as string))].sort(),
    evidence: integ.evidence as Evidence[], evidence_text: {}, sessions: integ.sessions, finding_texts: {}, site_understanding: su,
    primary_conversion_goal: profile ? text(profile.primary_conversion_goal, "INFERRED", PR) : null, summary: null,
    lenses: lenses.map((l) => ({ id: l.id, name: text(l.name, "SYNTHETIC", "lens-generator-v1"), description: text(l.description, "SYNTHETIC", "lens-generator-v1"), poles: POLES.filter((p) => p.pred(l)).map((p) => p.id) })),
    pole_unmet: POLES.filter((p) => !lenses.some((l) => p.pred(l))).map((p) => ({ pole: p.id, nearest_lens_id: null })),
    budget: {
      max_audit_tokens: Number(process.env["MAX_AUDIT_TOKENS"] ?? 1_650_000), used_tokens: sum(() => true), billed_tokens: sum((r) => r.status === "ok"), cache_read_tokens: sum((r) => r.status === "cached"),
      llm_calls: calls.length, cost: null,
    },
  };
  return { llm, rejected: integ.rejected };
}
