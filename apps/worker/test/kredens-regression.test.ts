/**
 * Регресія першого живого аудиту власника (kredens.com.ua, claude_cli, 30.09.2026): звіт «зовсім незрозумілий» (DEV-96…DEV-98).
 * Вхід — санітизована структура реального звіту (`fixtures/kredens-live/kredens-min.json`): сторінки з неповним захопленням
 * (blocked_requests, failed_critical_requests, layout_unstable), групи axe, прогони Lighthouse, скелети SYNTHETIC-доказів.
 * Той самий кодовий шлях, що й worker: integrateSessions → llmResultsFromSessions → buildReport (+ lighthouseMetricEvidenceRow).
 * Числа «до» — з реального звіту (поле `before` фікстури); «після» — з цього прогону. Якість моделі тут НЕ перевіряється (⏭️ живий пас).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Evidence, Report, maskNumberSpans, tierOf, type Evidence as EvidenceT } from "@sitelens/schemas";
import { CATEGORY_TEXT, buildReport, integrateSessions, llmResultsFromSessions, scanReport, type AuditArtifacts, type LlmText, type PageIn, type SessionResultIn } from "@sitelens/reporting";
import { lighthouseMetricEvidenceRow } from "../src/jobs/lighthouse.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
interface Fx {
  origin: string; language: "uk" | "en";
  pages: Array<{ path: string; page_type: PageIn["page_type"]; incomplete_reasons: string[] }>;
  axe_groups: Array<{ rule: string; impact: string; page_group: string; component: string; instances: number; pages: string[]; viewports: Array<"D" | "M"> }>;
  lighthouse_runs: Array<{ page_url: string; form_factor: "desktop" | "mobile"; status: "done" | "failed"; scores: { performance: number | null; accessibility: number | null; best_practices: number | null; seo: number | null }; metrics: { lcp_ms: number | null; tbt_ms: number | null; cls: number | null; fcp_ms: number | null } }>;
  synthetic_evidence: Array<{ id: string; type: string; page_path: string; session_id: string; lens_id: string; task_id: string; level: "snapshot" | "journey"; excerpt: string | null; category: string; claim_kind: string }>;
  before: { evidence_total: number; evidence_fallback: number; findings: number; title_generic: number; non_synthetic_evidence: number; axe_groups_with_finding: number };
}
const FX = JSON.parse(readFileSync(path.join(ROOT, "fixtures/kredens-live/kredens-min.json"), "utf8")) as Fx;
const hid = (...p: string[]) => "ev_" + createHash("sha256").update(p.join("|")).digest("hex").slice(0, 12);
const ctxIncomplete = { banner_state: "none" as const, banner_actions: [], blocked_requests_count: 5, js_error_count: 0, scroll_completed: true, layout_stable: false, http_status: 200 };

function pages(): PageIn[] {
  return FX.pages.map((p) => {
    const quotes = FX.synthetic_evidence.filter((e) => e.page_path === p.path && e.excerpt).map((e) => e.excerpt as string);
    const cap = { width: 1440, height: 1000, buttons: [], price_candidates: [], visible_text: [`Сторінка ${p.path}`, ...quotes].join("\n"), overflow: { client_width: 1440, scroll_width: 1440 }, images: [] };
    const shot = `pages${p.path.replace(/\//g, "-")}/1440x1000/viewport.png`;
    return {
      id: "pg" + createHash("sha256").update(p.path).digest("hex").slice(0, 8), url: new URL(p.path, FX.origin).href, path: p.path, page_type: p.page_type, page_type_reason: null,
      capture: { D: { capture_complete: false, incomplete_reasons: p.incomplete_reasons }, M: { capture_complete: false, incomplete_reasons: p.incomplete_reasons } },
      viewport: { D: { w: 1440, h: 1000 }, M: { w: 390, h: 844 } }, captures: { D: cap, M: { ...cap, width: 390, height: 844 } }, screenshot: { D: shot },
    };
  });
}

/** axe-доказ як його пише detectAxe на живому сайті: BENCHMARKED, self_confirming, але capture_complete=false (сторонні запити заблоковано) */
function axeEvidence(ps: PageIn[]): EvidenceT[] {
  const out: EvidenceT[] = [];
  for (const g of FX.axe_groups) {
    for (let i = 0; i < g.instances; i++) {
      const pth = g.pages[i % g.pages.length]!;
      const p = ps.find((x) => x.path === pth)!;
      const vp = g.viewports[i % g.viewports.length]!;
      out.push(Evidence.parse({
        id: hid("axe", g.rule, g.page_group, g.component, String(i)), type: "axe", source_class: "BENCHMARKED", page_url: p.url, page_path: p.path, page_type: p.page_type,
        page_group: p.page_type === "product" || p.page_type === "category" ? p.page_type : p.path, category: "accessibility",
        description: `axe ${g.rule}`, artifact_reference: `pages/${p.id}/axe.json`, screenshot_reference: p.screenshot.D, selector_or_region: { selector: `main .el${i}`, region: { x: 0, y: 0, w: 10, h: 10 } },
        detector_id: `axe:${g.rule}`, claim_kind: `axe:${g.rule}`, assertion: "presence", viewport: vp,
        measurement: { rule: g.rule, impact: g.impact, component_signature: g.component, finding_page_group: g.page_group },
        self_confirming: true, capture_complete: false, incomplete_reasons: p.capture.D!.incomplete_reasons, capture_context: ctxIncomplete,
      }));
    }
  }
  return out;
}

function lighthouseEvidence(ps: PageIn[]): EvidenceT[] {
  return FX.lighthouse_runs.flatMap((r) => {
    const p = ps.find((x) => x.url === r.page_url || x.path === new URL(r.page_url).pathname)!;
    const lhEv = { id: hid("lh", r.page_url, r.form_factor), page_url: r.page_url, viewport: r.form_factor, artifact_reference: `pages/${p.id}/lighthouse-${r.form_factor}.json`,
      data: { category: "performance", score_100: r.scores.performance, metrics: { "largest-contentful-paint": r.metrics.lcp_ms, "total-blocking-time": r.metrics.tbt_ms } } };
    const row = lighthouseMetricEvidenceRow(lhEv as never, p.id, { page_type: p.page_type, path: p.path });
    return row ? [Evidence.parse(row)] : [];
  });
}

const LABEL = (c: string) => (CATEGORY_TEXT[c]?.label.uk ?? c).toLowerCase();
function sessions(ps: PageIn[]): SessionResultIn[] {
  const by = new Map<string, SessionResultIn>();
  for (const e of FX.synthetic_evidence) {
    const s = by.get(e.session_id) ?? { session_id: e.session_id, lens_id: e.lens_id, task_id: e.task_id, level: e.level, success: "partial" as const, frictions: [], pages_seen: [] };
    const url = ps.find((p) => p.path === e.page_path)!.url;
    // цитата сайту — з реального звіту; для доказів без цитати текст моделі в звіті втрачено → текст інженера (NOT_FOUND із числом, як пише модель)
    const evidence = e.excerpt ? `"${e.excerpt}"` : `NOT_FOUND: на сторінці немає відповіді на питання лінзи щодо «${LABEL(e.category)}» (шукала серед 12 сторінок)`;
    s.frictions.push({ category: e.category as never, severity: "medium", evidence, page_url: url, claim_kind: e.claim_kind });
    s.pages_seen.push(e.page_path);
    by.set(e.session_id, s);
  }
  return [...by.values()];
}

const T = (text: string): LlmText => ({ text, source_class: "INFERRED", prompt_id: "site-profile-v1", guard_status: "pending" });

function build() {
  const ps = pages();
  const integ = integrateSessions({ sessions: sessions(ps), pages: ps }, { lang: "uk" });
  const llm = llmResultsFromSessions(integ, { mode: "live", provider: "claude_cli", model: "claude-opus-5-5", prompt_versions: ["snapshot-evaluator-v1", "browser-agent-v1"], llm_calls: 74, used_tokens: 1_652_554 });
  // site-profile-v1 з числами (типово для живої моделі): раніше — «НЕВІДОМО» (текст відхилено цілком)
  llm.site_understanding = {
    what_it_sells: T("Спешелті-кава власного обсмаження (понад 20 сортів) і аксесуари для заварювання"), positioning: T("Інтернет-магазин спешелті-кави від львівської мережі кав'ярень"),
    price_positioning: T("Середній і преміальний сегмент: пачка 250 г від 300 грн"), core_value_proposition: T("Свіжообсмажена кава з власної ростерії"),
    primary_customer_journey: T("Онлайн-купівля кави через «Купити зараз»"), likely_objections: [T("Складна фахова термінологія")],
  };
  const art: AuditArtifacts = {
    audit: { id: "aud_kredensregress1", input_url: FX.origin, normalized_url: FX.origin, domain: new URL(FX.origin).hostname, language: "uk", status: "completed", created_at: "2026-09-30T09:12:09.500Z", completed_at: "2026-09-30T09:32:14.026Z", snapshot_at: "2026-09-30T09:21:33.955Z", stage_status: {} },
    pages: ps, evidence: [...axeEvidence(ps), ...lighthouseEvidence(ps)], coverage: [], axe_version: "4.13.0",
    axe_groups: FX.axe_groups.map((g) => ({ rule: g.rule, page_group: g.page_group, component: g.component, instances: g.instances, impact: g.impact, viewports: g.viewports, pages: g.pages })),
    lighthouse: { status: "done", reason: null, runs: FX.lighthouse_runs },
  };
  return { ...buildReport(art, llm, { generated_at: "2026-09-30T10:00:00.000Z" }), integ };
}

describe("kredens (живий аудит власника): регресія DEV-96…DEV-98", () => {
  const { report, integ } = build();
  const synth = report.evidence.filter((e) => e.source_class === "SYNTHETIC");
  const fallback = synth.filter((e) => e.description.template_id === "evidence.llm.fallback").length;
  const nonSyn = report.evidence.filter((e) => e.source_class !== "SYNTHETIC").length;
  const generic = report.findings.filter((f) => f.title.template_id === "finding.title.generic").length;
  const after = { evidence_synthetic: synth.length, evidence_fallback: fallback, findings: report.findings.length, title_generic: generic, non_synthetic_evidence: nonSyn,
    axe_groups_with_finding: report.technical.accessibility.groups.filter((g) => g.finding_id).length, axe_groups: report.technical.accessibility.groups.length };

  it("звіт валідний за контрактом і сканер guard чистий", () => {
    expect(Report.safeParse(report).success).toBe(true);
    expect(scanReport(report).clean, JSON.stringify(scanReport(report).violations.slice(0, 3))).toBe(true);
    console.log("kredens до:", JSON.stringify(FX.before), "\nkredens після:", JSON.stringify(after));
  });

  it("дефект 1: жоден SYNTHETIC-доказ не має опису-заглушки evidence.llm.fallback (було 98/98)", () => {
    expect(FX.before.evidence_fallback).toBe(98);
    expect(synth.length).toBeGreaterThan(50);
    expect(fallback).toBe(0);
    // NOT_FOUND-текст моделі дійшов до звіту з замаскованим числом (а не відкинутий числовим правилом)
    expect(synth.some((e) => e.description.origin === "llm" && e.description.template.startsWith("Не знайдено:") && e.description.template.includes("…"))).toBe(true);
    // цитата без коментаря — шаблон коду з цитатою сайту
    expect(synth.some((e) => e.description.template_id === "evidence.synthetic.quote")).toBe(true);
    expect(Object.keys(integ.evidence_text).length).toBeGreaterThan(0);
  });

  it("дефект 2: заголовки не generic — зі спостереження лінз або категорія+цитата; дія — за категорією (було 27/28 generic)", () => {
    expect(generic).toBe(0);
    for (const f of report.findings.filter((x) => x.category !== "accessibility" && x.category !== "performance")) {
      expect(f.recommendation?.recommended_change.template_id, f.finding_key).not.toBe("finding.change.generic");
      expect(f.problem.template_id, f.finding_key).not.toBe("finding.problem.generic");
    }
  });

  it("дефект 3: serious axe → VERIFIED-знахідка з BENCHMARKED-доказами попри неповне захоплення; Lighthouse LCP > порогу → VERIFIED performance", () => {
    expect(FX.before.non_synthetic_evidence).toBe(0);
    expect(nonSyn).toBeGreaterThan(0);
    for (const g of report.technical.accessibility.groups.filter((x) => x.impact === "serious" || x.impact === "critical")) {
      expect(g.finding_id, `${g.rule} ${g.component}`).not.toBeNull();
      expect(report.findings.find((f) => f.id === g.finding_id)?.confidence.level).toBe("VERIFIED");
    }
    const perf = report.findings.find((f) => f.claim_kind === "lighthouse_metric_poor");
    expect(perf?.confidence.level).toBe("VERIFIED");
    expect(perf?.pages.map((p) => p.path)).toEqual(["/"]); // LCP 3502 мс > 2500; інші прогони (644/2114 мс) — без знахідки
    const run = report.technical.lighthouse.runs.find((r) => r.page_url === FX.origin)!;
    expect(run.evidence_id).not.toBeNull();
    expect(report.technical.lighthouse.runs.filter((r) => r.evidence_id).length).toBe(1);
  });

  it("дефект 4: site_understanding з числами → текст моделі з «…», а не НЕВІДОМО", () => {
    const su = report.site_understanding!;
    expect(su.what_it_sells.origin).toBe("llm");
    expect(su.what_it_sells.template).toContain("…");
    expect(su.price_positioning.origin).toBe("llm");
    expect(su.price_positioning.template).toBe("Середній і преміальний сегмент: пачка … г від … грн");
  });
});

describe("правила, що можуть впасти (позитив + негатив)", () => {
  it("tierOf: presence + неповне захоплення → ET-DET; absence + неповне → не ET-DET (DEV-19 не послаблено)", () => {
    const base = { id: "ev_0123456789ab", type: "axe", source_class: "BENCHMARKED", page_url: "https://x.test/", description: "d", artifact_reference: "a", selector_or_region: { selector: "main" },
      detector_id: "axe:color-contrast", claim_kind: "axe:color-contrast", category: "accessibility", assertion: "presence", viewport: "D", self_confirming: true, capture_complete: false, incomplete_reasons: ["blocked_requests:5"], capture_context: ctxIncomplete };
    expect(tierOf(Evidence.parse(base))).toBe("ET-DET");
    const abs = { ...base, type: "dom", source_class: "OBSERVED", detector_id: "shipping_depth", claim_kind: "deep_link_only", category: "shipping", assertion: "absence", self_confirming: false };
    expect(tierOf(Evidence.parse(abs))).toBe("ET-INC");
  });
  it("маскування чисел: цифри → «…»; речення з % або числівником-словом видаляється; нічого не лишилось → null", () => {
    expect(maskNumberSpans("Нова Пошта — від 65 ₴, або безкоштовно від 700 ₴.")?.text).toBe("Нова Пошта — від … ₴, або безкоштовно від … ₴.");
    expect(maskNumberSpans("Ціна 300 грн. Це дасть +12 % конверсії.")?.text).toBe("Ціна … грн.");
    expect(maskNumberSpans("Sales will double after this fix.")).toBeNull();
    expect(maskNumberSpans("Половина лінз не бачить різниці")).toBeNull();
  });
  it("Lighthouse-метрика: LCP/TBT у межах «добре» → доказу немає; гірше → BENCHMARKED self_confirming", () => {
    const mk = (lcp: number, tbt: number) => lighthouseMetricEvidenceRow({ id: "ev_aaaaaaaaaaaa", page_url: "https://x.test/p", viewport: "mobile", artifact_reference: "a.json", data: { category: "performance", score_100: 80, metrics: { "largest-contentful-paint": lcp, "total-blocking-time": tbt } } } as never, "p1", { page_type: "product", path: "/p" });
    expect(mk(2400, 150)).toBeNull();
    const bad = mk(2600.4, 150)!;
    expect(bad).toMatchObject({ source_class: "BENCHMARKED", self_confirming: true, claim_kind: "lighthouse_metric_poor", page_group: "product", viewport: "M", measurement: { lcp_ms: 2600, lcp_over: true, tbt_over: false } });
    expect(Evidence.safeParse(bad).success).toBe(true);
    expect(mk(1000, 250)?.measurement).toMatchObject({ tbt_over: true, lcp_over: false });
  });
});
