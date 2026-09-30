/**
 * DEV-98: тексти знахідок від моделі на живому шляху worker — finding-aggregator-v1 (заголовок, проблема, чому) →
 * recommendation-v1 (дія, перевірка), по одній групі за раз у порядку рангу, з бюджетом E4 (той самий rt.llm і залишок).
 * Кожна група — окрема транзакція: рядок finding_texts + llm_calls + токени (повтор після kill -9 не викликає модель вдруге).
 * Лише групи, для яких у коду немає конкретного шаблону детектора (axe / FINDING_TEMPLATES) — інакше текст дає код.
 * Збій моделі/replay-промах не валить аудит: група лишається з кодовим текстом (buildReport → DEV-98 fallback).
 */
import { maskNumberSpans, numberViolations } from "@sitelens/schemas";
import { writeFindingTexts, type FindingGroupIn } from "@sitelens/llm";
import { detectorTemplateKey, type AuditArtifacts, type LlmResults } from "@sitelens/reporting";
import type { AuditRow } from "@sitelens/pipeline";
import type { ScoredFinding } from "@sitelens/scoring";
import { recordCalls, withTx, writeFindingTextRow } from "./llm-store.js";
import type { Runtime } from "./runtime.js";

/** максимум груп з LLM-текстом на аудит (у порядку рангу); решта — кодові шаблони. Не ліміт бюджету, а стеля кількості викликів. */
export const FINDING_TEXT_MAX = { full: 12, quick: 5 } as const;

/** та сама межа, що в buildReport: axe і групи з детермінованим доказом + шаблоном детектора — текст дає код */
export const needsLlmText = (f: { claim_kind: string; evidence_ids: readonly string[] }, detIds: ReadonlySet<string>): boolean => !f.claim_kind.startsWith("axe:") && detectorTemplateKey(f, (id) => detIds.has(id)) === null;

const clean = (t: string): string | null => {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (numberViolations(s, true).length === 0) return s;
  return maskNumberSpans(s)?.text ?? null;
};

/** група для промпту: факти — спостереження лінз і описи детекторів (числа замасковано), цитати — дослівні excerpt */
export function groupOf(f: ScoredFinding, art: AuditArtifacts, llm: LlmResults): FindingGroupIn {
  const byId = new Map([...art.evidence, ...llm.evidence].map((e) => [e.id, e]));
  const facts: string[] = [];
  const quotes: string[] = [];
  for (const id of f.evidence_ids) {
    const e = byId.get(id);
    if (!e) continue;
    const t = llm.evidence_text[id]?.text ?? (e.source_class === "OBSERVED" || e.source_class === "BENCHMARKED" ? e.description : null);
    const c = t ? clean(t) : null;
    if (c && !facts.includes(c)) facts.push(c.slice(0, 300));
    if (e.excerpt && !quotes.includes(e.excerpt)) quotes.push(e.excerpt.slice(0, 200));
  }
  return { finding_key: f.finding_key, category: f.category, page_group: f.page_group, claim_kind: f.claim_kind, pages: f.pages.map((p) => p.path), facts: facts.slice(0, 8), quotes: quotes.slice(0, 6) };
}

export interface FindingTextRun { eligible: number; attempted: number; supported: number; not_supported: number; failed: number; budget_limited: boolean; skipped_existing: number }

export async function runFindingTexts(rt: Runtime, audit: AuditRow, art: AuditArtifacts, llm: LlmResults, findings: readonly ScoredFinding[]): Promise<FindingTextRun> {
  const cap = audit.config_json["mode"] === "quick" ? FINDING_TEXT_MAX.quick : FINDING_TEXT_MAX.full;
  const detIds = new Set(art.evidence.map((e) => e.id));
  const eligible = findings.filter((f) => needsLlmText(f, detIds)).sort((a, b) => a.rank - b.rank).slice(0, cap);
  const run: FindingTextRun = { eligible: eligible.length, attempted: 0, supported: 0, not_supported: 0, failed: 0, budget_limited: false, skipped_existing: 0 };
  if (eligible.length === 0) return run;
  const have = new Set((await rt.pool.query("SELECT finding_key FROM finding_texts WHERE audit_run_id = $1", [audit.id])).rows.map((r) => r.finding_key as string));
  const todo = eligible.filter((f) => !have.has(f.finding_key));
  run.skipped_existing = eligible.length - todo.length;
  if (todo.length === 0) return run;
  let h: Awaited<ReturnType<Runtime["llm"]>>;
  try { h = await rt.llm(audit); } catch (e) { rt.log("warn", "finding texts: LLM недоступна", { audit: audit.id, err: String((e as Error).message).slice(0, 200) }); run.failed = todo.length; return run; }
  if (h.client.mode === "none") return run;
  const ctx = { audit_run_id: audit.id, client: h.client, language: audit.language };
  for (const f of todo) {
    run.attempted++;
    let res: Awaited<ReturnType<typeof writeFindingTexts>>;
    const before = h.client.records.length;
    try {
      res = await writeFindingTexts(ctx, [groupOf(f, art, llm)]);
    } catch (e) {
      // ReplayMiss / провайдер / мережа: група лишається з кодовим текстом, аудит іде далі; уже зроблені виклики — у лічильник E4
      const partial = h.client.records.slice(before);
      if (partial.length) await withTx(rt.pool, (c) => recordCalls(c, h.client, audit.id, "aggregate", partial));
      run.failed++;
      rt.log("warn", "finding texts: виклик не вдався, кодовий шаблон", { audit: audit.id, key: f.finding_key, err: String((e as Error).message).slice(0, 200) });
      continue;
    }
    await withTx(rt.pool, async (c) => {
      const ids = res.calls.length ? await recordCalls(c, h.client, audit.id, "aggregate", res.calls) : [];
      const out = res.output;
      if (res.status !== "done" || !out) return;
      const t = out.texts[f.finding_key];
      if (t) await writeFindingTextRow(c, audit.id, f.finding_key, { status: "supported", ...t, prompt_versions: t.prompt_ids, llm_call_ids: ids });
      else if (out.not_supported.includes(f.finding_key)) await writeFindingTextRow(c, audit.id, f.finding_key, { status: "not_supported", prompt_versions: ["finding-aggregator-v1"], llm_call_ids: ids });
    });
    if (res.status === "budget_limited") { run.budget_limited = true; break; }
    if (res.status !== "done" || !res.output) { run.failed++; continue; }
    if (res.output.texts[f.finding_key]) run.supported++; else run.not_supported++;
  }
  return run;
}
