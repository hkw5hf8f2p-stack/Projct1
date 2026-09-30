/**
 * E1 «LLM-лише y/3» по КОЖНІЙ незалежній вибірці відповідей на fixture-shop (S7-B, DEV-88).
 * Одна вибірка = один namespace (s7, s7-e2-run1..3) однієї сесійної моделі (прогін A = «claude-in-session», B = «claude-in-session-b»;
 * 4 + 4 = 8 незалежних наборів відповідей сліпих агентів). Нічого не тюниться під результат. Правило зарахування — `e1LlmAnchored` (SCORING_SPEC §14.2, DEV-90:
 * точна сторінка з EXPECTED.json + категорія + перевірена цитата, прив'язана до якоря засіяного елемента); старе `e1Matches` (§8.1, за категорією) друкується поруч для порівняння;
 * додатково друкується діагностика «майже знайшов» (friction релевантної категорії, відхилений кодом; знахідка іншої категорії на тій самій сторінці), щоб було видно,
 * чи правило зарахування не надто вузьке/широке. Це РОЗПОДІЛ по 8 вибірках однієї моделі-сесії, не міра стабільності живої моделі (⏭️ live).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E1_TABLE, e1, e1LlmAnchored, e1Matches, isLlmOnly, normForMatch, type E1AnchorSpec, type E1AnchoredResult, type VFinding } from "../../packages/scoring/src/index.js";
import { buildRunReport, type LoadedSnapshot, type ValidateMeter } from "./core.js";

export const E1_LLM_DEFECTS = E1_TABLE.filter((d) => !d.deterministic);
/** №1/№3/№4 з fixtures/shop/EXPECTED.json: сторінки, категорії, claim_kind, якорі засіяного елемента (SCORING_SPEC §14.2) */
export function loadE1AnchorSpecs(file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/shop/EXPECTED.json")): E1AnchorSpec[] {
  const exp = JSON.parse(readFileSync(file, "utf8")) as { defects: Array<{ id: number; type: string; pages: string[]; categories: string[]; claim_kind: string | null; anchors?: string[] }> };
  const names = new Map(E1_TABLE.map((d) => [d.id, d.name]));
  return exp.defects.filter((d) => d.type !== "deterministic").map((d) => {
    if (!d.anchors?.length) throw new Error(`EXPECTED.json: дефект №${d.id} без anchors (SCORING_SPEC §14.2)`);
    return { id: d.id, name: names.get(d.id) ?? `#${d.id}`, pages: d.pages, categories: d.categories, claim_kind: d.claim_kind, anchors: d.anchors };
  });
}

export const E1_NAMESPACES = ["s7", "s7-e2-run1", "s7-e2-run2", "s7-e2-run3"] as const;

export interface E1Sample {
  model: string; namespace: string;
  /** y за SCORING_SPEC §14.2 (якір + точна сторінка) — метрика */
  y: number; detected: Record<number, boolean>; by: Record<number, string[]>;
  /** y за старим правилом категорії (§8.1 e1Matches) — лише для порівняння */
  y_category: number; detected_category: Record<number, boolean>;
  anchored: Pick<E1AnchoredResult, "other_page" | "unanchored">;
  /** усі LLM-лише знахідки вибірки (finding_key) */
  llm_findings: string[];
  /** friction, відхилені кодом при integrate, у категорії/на сторінці релевантного дефекту (ознака «майже знайшов»): причина + категорія + сторінка */
  near_miss_rejected: Array<{ defect: number; reason: string; category: string; page: string; /** evidence без лапок, але дослівно є на сторінці (діагностика; у метрику НЕ зараховано) */ bare_verbatim: boolean }>;
  /** знахідки на релевантних сторінках, але в іншій категорії, ніж у E1_TABLE (правило зарахування їх не рахує) */
  near_miss_other_category: Array<{ defect: number; finding_key: string }>;
}
export interface E1Distribution {
  samples: E1Sample[];
  /** розподіл y: y → скільки вибірок */
  histogram: Record<number, number>;
  /** той самий розподіл за старим правилом категорії (порівняння) */
  histogram_category: Record<number, number>;
  per_model: Record<string, { n: number; histogram: Record<number, number> }>;
  /** дефект → у скількох вибірках знайдено */
  frequency: Record<number, { detected: number; of: number }>;
  frequency_category: Record<number, { detected: number; of: number }>;
  /** самоперевірка: вибірка `s7` поточної моделі, відтворена за логічним ключем, дає той самий y, що й основний E1 (хеш-replay) */
  consistency: { model: string; primary_y: number; sample_y: number; ok: boolean } | null;
}

/** усі моделі сесії, що мають записи в кеші хоча б одного з namespace (незалежні набори відповідей) */
export function discoverSessionModels(root: string): string[] {
  const out = new Set<string>();
  for (const ns of E1_NAMESPACES) {
    const dir = path.join(root, "cache", ns);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const e = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { provider?: string; model?: string; request_summary?: { logical_key?: { page_url?: string } } };
      // лише записи fixture-shop (сторінки магазину); injection/E3 мають інші сторінки й не змінюють множину моделей
      if (e.provider === "session" && e.model) out.add(e.model);
    }
  }
  return [...out].sort();
}

/** діагностика: evidence відхилене, хоча без обгорток дослівно є на сторінці (після DEV-90 таких має не бути, крім надто коротких) */
function bareVerbatim(shop: LoadedSnapshot, pagePath: string, evidence: string): boolean {
  const page = shop.art.pages.find((p) => p.path === pagePath);
  if (!page) return false;
  const corpus = normForMatch(Object.values(page.captures).map((c) => c?.visible_text ?? "").join("\n"));
  const e = normForMatch(evidence.replace(/^\s*["«“]|["»”]\s*$/gu, ""));
  return e.length >= 3 && !/^not_found\s*:/i.test(e) && corpus.includes(e);
}
const pageGroupsOf = (d: (typeof E1_TABLE)[number]): readonly string[] => d.pageGroups;

export async function runE1Samples(o: { specs: readonly E1AnchorSpec[]; shop: LoadedSnapshot; root: string; models: readonly string[]; meter: ValidateMeter; max_audit_tokens: number; primary?: { model: string; y: number } }): Promise<E1Distribution> {
  const samples: E1Sample[] = [];
  for (const model of o.models) {
    for (const ns of E1_NAMESPACES) {
      const run = await buildRunReport(o.shop, `e1-sample-${model}-${ns}`, {
        spec: { kind: "honest" }, cache_mode: "use", max_audit_tokens: o.max_audit_tokens, meter: o.meter, ablate: true,
        session: { root: o.root, model, phase: "replay", by_logical_key: true, namespace: ns, scenario: "fixture-shop" },
      });
      const res = e1(run.findings);
      const anc = e1LlmAnchored(o.specs, run.findings);
      const detected: Record<number, boolean> = {}; const by: Record<number, string[]> = {}; const detected_category: Record<number, boolean> = {};
      for (const d of anc.detected) { detected[d.id] = d.detected; by[d.id] = d.by; }
      for (const d of res.detected) if (!d.deterministic) detected_category[d.id] = d.detected;
      const llmFindings = run.findings.filter(isLlmOnly);
      const near_miss_rejected: E1Sample["near_miss_rejected"] = [];
      for (const r of run.rejections) {
        const ses = run.eval.sessions.find((x) => x.session_id === r.session_id); const fr = ses?.frictions[r.index];
        if (!fr) continue;
        const pth = new URL(fr.page_url).pathname;
        for (const d of E1_LLM_DEFECTS) if (d.categories.includes(fr.category) && (pageGroupsOf(d).length === 0 || pageGroupsOf(d).some((g) => g === "/" ? pth === "/" : true))) near_miss_rejected.push({ defect: d.id, reason: r.reason, category: fr.category, page: pth, bare_verbatim: bareVerbatim(o.shop, pth, fr.evidence) });
      }
      const near_miss_other_category: E1Sample["near_miss_other_category"] = [];
      for (const f of llmFindings) for (const d of E1_LLM_DEFECTS) {
        if (detected_category[d.id]) continue;
        const onPage = d.pageGroups.length === 0 || d.pageGroups.includes(f.page_group);
        if (onPage && !e1Matches(d, f as VFinding)) near_miss_other_category.push({ defect: d.id, finding_key: f.finding_key });
      }
      samples.push({ model, namespace: ns, y: anc.y, detected, by, y_category: res.llm.y, detected_category, anchored: { other_page: anc.other_page, unanchored: anc.unanchored }, llm_findings: llmFindings.map((f) => f.finding_key).sort(), near_miss_rejected, near_miss_other_category });
    }
  }
  const histogram: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const histogram_category: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const per_model: E1Distribution["per_model"] = {};
  for (const s of samples) {
    histogram[s.y] = (histogram[s.y] ?? 0) + 1;
    histogram_category[s.y_category] = (histogram_category[s.y_category] ?? 0) + 1;
    const pm = (per_model[s.model] ??= { n: 0, histogram: { 0: 0, 1: 0, 2: 0, 3: 0 } });
    pm.n++; pm.histogram[s.y] = (pm.histogram[s.y] ?? 0) + 1;
  }
  const frequency: E1Distribution["frequency"] = {};
  const frequency_category: E1Distribution["frequency"] = {};
  for (const d of E1_LLM_DEFECTS) {
    frequency[d.id] = { detected: samples.filter((s) => s.detected[d.id]).length, of: samples.length };
    frequency_category[d.id] = { detected: samples.filter((s) => s.detected_category[d.id]).length, of: samples.length };
  }
  const p = o.primary;
  const ps = p ? samples.find((s) => s.model === p.model && s.namespace === "s7") : undefined;
  return { samples, histogram, histogram_category, per_model, frequency, frequency_category, consistency: p && ps ? { model: p.model, primary_y: p.y, sample_y: ps.y, ok: p.y === ps.y } : null };
}

export const fmtHist = (h: Record<number, number>): string => [0, 1, 2, 3].map((k) => `${k}/3 ×${h[k] ?? 0}`).join(", ");
export function formatE1Distribution(d: E1Distribution): string[] {
  const names = new Map(E1_LLM_DEFECTS.map((x) => [x.id, x.name]));
  const freq = (f: E1Distribution["frequency"]) => E1_LLM_DEFECTS.map((x) => `№${x.id} ${names.get(x.id)} ${f[x.id]?.detected}/${f[x.id]?.of}`).join("; ");
  const out = [
    `E1 LLM-лише y/3 (SCORING_SPEC §14.2: точна сторінка EXPECTED + категорія + цитата з якорем засіяного елемента) по ${d.samples.length} незалежних вибірках fixture-shop (namespace s7 + s7-e2-run1..3 × моделі ${Object.keys(d.per_model).join(", ")}): розподіл ${fmtHist(d.histogram)}`,
    ...Object.entries(d.per_model).map(([m, v]) => `  ${m}: ${fmtHist(v.histogram)} (n=${v.n})`),
    `  частота виявлення: ${freq(d.frequency)}`,
    `  для порівняння — старе правило категорії (§8.1 e1Matches, ті самі звіти): ${fmtHist(d.histogram_category)}; частота ${freq(d.frequency_category)}`,
    ...d.samples.map((s) => `  ${s.model} ${s.namespace}: y=${s.y}/3 [${E1_LLM_DEFECTS.map((x) => `№${x.id}${s.detected[x.id] ? "✓" : "·"}`).join(" ")}] (за категорією ${s.y_category}/3; прив'язано, але інша сторінка ${s.anchored.other_page.length}; потрібна сторінка без прив'язки ${s.anchored.unanchored.length}) LLM-знахідок ${s.llm_findings.length}${s.near_miss_rejected.length ? `; відхилено кодом у релевантній категорії ${s.near_miss_rejected.length} (${[...new Set(s.near_miss_rejected.map((r) => r.reason))].sort().map((k) => `${k} ${s.near_miss_rejected.filter((r) => r.reason === k).length}`).join(", ")}; без обгорток дослівно на сторінці ${s.near_miss_rejected.filter((r) => r.bare_verbatim).length})` : ""}${s.near_miss_other_category.length ? `; на релевантній сторінці в іншій категорії ${s.near_miss_other_category.length}` : ""}`),
  ];
  if (d.consistency) out.push(`  самоперевірка: ${d.consistency.model} s7 за логічним ключем y=${d.consistency.sample_y} vs основний E1 y=${d.consistency.primary_y} → ${d.consistency.ok ? "збігається" : "РОЗБІЖНІСТЬ"}`);
  return out;
}
