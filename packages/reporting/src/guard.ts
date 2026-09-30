/**
 * Report guard на рівні звіту (SPEC §33, S4 кр. 4 і 7): (а) сканер по JSON звіту — усі текстові поля;
 * (б) guard LLM-текстів перед збиранням із регенераціями (≤ 2) і видаленням речень; (в) синхронний захист у buildReport.
 * Правила — `@sitelens/llm` (guards/report-guard.ts). Межі слів лише Unicode-класами (G0-26; лінт-правило на цей файл).
 */
import { collectTexts, renderText, type TemplatedText } from "@sitelens/schemas";
import { GUARD_VERSION, dropViolatingSentences, guardText, guardWithRegeneration, type GuardedField, type Issue } from "@sitelens/llm";
import type { LlmResults, LlmText } from "./types.js";

export { GUARD_VERSION };

/** ключі, значення яких — не проза (посилання, ідентифікатори, цитати сайту, виміри) */
const SKIP_KEYS = new Set([
  "excerpt", "measurement", "params", "page_url", "input_url", "normalized_url", "url", "artifact_reference", "screenshot_reference", "selector", "path", "page_path",
  "ptr", "id", "template_id", "detector_id", "claim_kind", "finding_key", "key", "domain", "llm_model", "llm_provider", "schema_version", "scoring_version", "version",
]);
const SKIP_KEY_RE = /(?:_id|_ids|_at|_url)$/;

export interface ScanViolation { ptr: string; kind: "template" | "rendered" | "field" | "unrenderable"; rule_ids: string[]; sample: string }
export interface ScanResult { clean: boolean; fields_checked: number; violations: ScanViolation[] }

const fieldFor = (ptr: string): GuardedField => (ptr.startsWith("/lenses") ? "lens_description" : ptr.startsWith("/site_understanding") ? "site_profile" : "finding_text");
const isProse = (s: string): boolean => /\s/.test(s) && /\p{L}{2}/u.test(s) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/**
 * Сканер JSON звіту: кожен TemplatedText (шаблон — структурно + лексично; показаний текст — лексично) і кожен інший
 * прозовий рядок (лексично). Цитати сайту (`excerpt`) і виміри (`measurement`) не скануються (SCORING_SPEC §7.5).
 */
export function scanReport(report: unknown): ScanResult {
  const violations: ScanViolation[] = [];
  let checked = 0;
  const lang = ((report as { audit?: { language?: string } } | null)?.audit?.language === "en" ? "en" : "uk") as "uk" | "en";
  const texts = collectTexts(report);
  const textPtrs = new Set(texts.map((t) => t.ptr));
  for (const { ptr, text } of texts) {
    checked++;
    const f = fieldFor(ptr);
    const g = guardText(text.template, { field: f });
    if (!g.ok) violations.push({ ptr, kind: "template", rule_ids: g.rule_ids, sample: text.template.slice(0, 80) });
    let shown: string | null = null;
    try { shown = renderText(text, report, lang); } catch (e) { violations.push({ ptr, kind: "unrenderable", rule_ids: ["unrenderable"], sample: String((e as Error).message).slice(0, 80) }); }
    if (shown !== null) {
      const r = guardText(shown, { field: f, structural: false });
      if (!r.ok) violations.push({ ptr, kind: "rendered", rule_ids: r.rule_ids, sample: shown.slice(0, 80) });
    }
  }
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (v: unknown, ptr: string) => {
    if (textPtrs.has(ptr)) return;
    if (typeof v === "string") {
      if (!isProse(v)) return;
      checked++;
      const g = guardText(v, { field: fieldFor(ptr), structural: false });
      if (!g.ok) violations.push({ ptr, kind: "field", rule_ids: g.rule_ids, sample: v.slice(0, 80) });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`));
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (SKIP_KEYS.has(k) || SKIP_KEY_RE.test(k)) continue;
        walk(x, `${ptr}/${esc(k)}`);
      }
    }
  };
  walk(report, "");
  return { clean: violations.length === 0, fields_checked: checked, violations };
}

// ---------------------------------------------------------------- синхронний захист LLM-тексту (buildReport)
export interface GuardedLlm { text: string | null; status: TemplatedText["guard"]["status"]; attempts: number; rule_ids: string[]; sentences_removed: number }
/** без регенерації: порушні речення видаляються; порожній результат → null (кодовий шаблон) */
export function guardLlmTextSync(t: LlmText, field: GuardedField): GuardedLlm {
  const g = guardText(t.text, { field, structural: false });
  const prior = t.guard_status === "regenerated" || t.guard_status === "sentences_removed" ? t.guard_status : "passed";
  if (g.ok) return { text: t.text, status: prior, attempts: t.guard_attempts ?? 0, rule_ids: t.guard_rule_ids ?? [], sentences_removed: 0 };
  const d = dropViolatingSentences(t.text, { field, structural: false });
  return { text: d.text.length ? d.text : null, status: "sentences_removed", attempts: t.guard_attempts ?? 0, rule_ids: [...new Set([...(t.guard_rule_ids ?? []), ...g.rule_ids])], sentences_removed: Math.max(1, d.removed) };
}

// ---------------------------------------------------------------- guard з регенерацією (до buildReport)
export type RegenerateText = (info: { where: string; text: LlmText; issues: Issue[]; attempt: number }) => Promise<string | null>;
export interface GuardRunStats { fields_checked: number; regenerated: number; sentences_removed: number; dropped: number; rule_ids: string[] }

/**
 * Проганяє ВСІ LLM-тексти результатів: guard → до 2 регенерацій → видалення речень (SPEC §33). Повертає копію з проставленими
 * guard_status/guard_attempts/guard_rule_ids; текст, що повністю видалено, лишається порожнім і буде замінений кодовим шаблоном.
 */
export async function guardLlmResults(llm: LlmResults, opts: { regenerate?: RegenerateText } = {}): Promise<{ llm: LlmResults; stats: GuardRunStats }> {
  const stats: GuardRunStats = { fields_checked: 0, regenerated: 0, sentences_removed: 0, dropped: 0, rule_ids: [] };
  const one = async (t: LlmText, where: string, field: GuardedField): Promise<LlmText> => {
    stats.fields_checked++;
    const r = await guardWithRegeneration(t.text, { field }, opts.regenerate ? (issues, attempt) => (opts.regenerate as RegenerateText)({ where, text: t, issues, attempt }) : undefined);
    if (r.status === "regenerated") stats.regenerated++;
    if (r.status === "sentences_removed") { stats.sentences_removed += r.sentences_removed; if (r.text === null) stats.dropped++; }
    stats.rule_ids.push(...r.rule_ids);
    return { ...t, text: r.text ?? "", guard_status: r.status, guard_attempts: r.attempts, guard_rule_ids: r.rule_ids };
  };
  const out: LlmResults = { ...llm };
  out.evidence_text = Object.fromEntries(await Promise.all(Object.entries(llm.evidence_text).map(async ([k, v]) => [k, await one(v, `evidence:${k}`, "finding_text")] as const)));
  out.finding_texts = Object.fromEntries(await Promise.all(Object.entries(llm.finding_texts).map(async ([k, parts]) => [k, Object.fromEntries(await Promise.all(Object.entries(parts).map(async ([p, v]) => [p, await one(v as LlmText, `finding:${k}:${p}`, "finding_text")] as const)))] as const))) as LlmResults["finding_texts"];
  out.primary_conversion_goal = llm.primary_conversion_goal ? await one(llm.primary_conversion_goal, "executive:primary_conversion_goal", "finding_text") : null;
  out.summary = llm.summary ? await one(llm.summary, "executive:summary", "finding_text") : null;
  out.lenses = await Promise.all(llm.lenses.map(async (l) => ({ ...l, name: await one(l.name, `lens:${l.id}:name`, "lens_description"), description: await one(l.description, `lens:${l.id}:description`, "lens_description") })));
  if (llm.site_understanding) {
    const su = llm.site_understanding;
    out.site_understanding = {
      what_it_sells: await one(su.what_it_sells, "site_understanding:what_it_sells", "site_profile"),
      positioning: await one(su.positioning, "site_understanding:positioning", "site_profile"),
      price_positioning: await one(su.price_positioning, "site_understanding:price_positioning", "site_profile"),
      core_value_proposition: await one(su.core_value_proposition, "site_understanding:core_value_proposition", "site_profile"),
      primary_customer_journey: await one(su.primary_customer_journey, "site_understanding:primary_customer_journey", "site_profile"),
      likely_objections: await Promise.all(su.likely_objections.map((o, i) => one(o, `site_understanding:objection:${i}`, "site_profile"))),
    };
  }
  stats.rule_ids = [...new Set(stats.rule_ids)].sort();
  return { llm: out, stats };
}
