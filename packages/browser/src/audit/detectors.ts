/**
 * Детермінований модуль детекторів S1a (D3): №2 shipping_depth, №5 cta_below_fold, №6 axe:button-name|link-name|label,
 * №7 horizontal_overflow, №8 oversized_image, №9 axe:image-alt, №10 price_first_viewport. Чисті функції над даними
 * захоплення: без часу, без LLM, без назв і селекторів фікстури й без її службових міток (planning/eval/fixture-defect-map.md).
 * Твердження відсутності (№2, №10) — за DEV-17/DEV-19 (map §4); №5 при відкритому банері — ET-INC.
 */
import { evidenceId } from "../evidence.js";
import { CTA_RE, OVERFLOW_MIN_PX, PRODUCT_PATH_RE, SHIP_PATH_RE, SHIP_RE, SIZE_THRESHOLD_BYTES, CTA_VIS_THRESHOLD } from "./patterns.js";
import type { EvidenceRow, PageType, Rect, ViewportCapture, VP, EvidenceType, SourceClass } from "./types.js";

export interface DetectInput {
  url: string;
  path: string;
  page_type: PageType;
  page_group: string;
  D: ViewportCapture;
  M: ViewportCapture;
}

const is2xx = (c: ViewportCapture) => c.completeness.http_status !== null && c.completeness.http_status >= 200 && c.completeness.http_status < 300;
const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** Тип сторінки за map §1 (пріоритет category над «h1+CTA» — DEV-26). */
export function classifyPageType(c: ViewportCapture): PageType {
  let path = "/";
  try {
    path = new URL(c.final_url).pathname;
  } catch {
    /* лишаємо / */
  }
  if (c.jsonld_types.some((t) => /^product$/i.test(t))) return "product";
  if (PRODUCT_PATH_RE.test(path)) return "product";
  if (productLinkTargets(c).size >= 3) return "category";
  if (c.h1_count === 1 && c.interactive.some((i) => CTA_RE.test(i.name.trim()))) return "product";
  return "unknown";
}
export function productLinkTargets(c: ViewportCapture): Set<string> {
  const out = new Set<string>();
  for (const l of c.links) {
    if (!l.visible || !sameOrigin(l.abs, c.final_url)) continue;
    try {
      const u = new URL(l.abs);
      if (PRODUCT_PATH_RE.test(u.pathname)) out.add(u.origin + u.pathname.replace(/\/$/, ""));
    } catch {
      /* ignore */
    }
  }
  return out;
}

export const pageGroupOf = (type: PageType, p: string): string => (type === "unknown" ? p.replace(/(.)\/$/, "$1") : type);

interface Mk {
  input: DetectInput;
  cap: ViewportCapture;
  detector_id: string;
  claim_kind: string;
  category: string;
  type: EvidenceType;
  source_class: SourceClass;
  assertion: "presence" | "absence";
  selector?: string;
  region: Rect;
  artifact_reference: string;
  screenshot_reference: string;
  description: string;
  excerpt?: string;
  measurement: Record<string, unknown>;
  self_confirming: boolean;
  capture_complete: boolean;
  incomplete_reasons?: string[];
  idExtra?: string;
}

function mk(m: Mk): EvidenceRow {
  const c = m.cap.completeness;
  return {
    id: evidenceId(m.detector_id, m.input.path, m.cap.vp, m.selector ?? "", m.idExtra ?? ""),
    type: m.type,
    source_class: m.source_class,
    page_url: m.input.url,
    page_path: m.input.path,
    page_type: m.input.page_type,
    page_group: m.input.page_group,
    category: m.category,
    description: m.description,
    artifact_reference: m.artifact_reference,
    screenshot_reference: m.screenshot_reference,
    selector_or_region: { ...(m.selector ? { selector: m.selector } : {}), region: m.region, dpr: m.cap.dpr, coord: "css_px_document" },
    ...(m.excerpt ? { excerpt: m.excerpt.slice(0, 300) } : {}),
    detector_id: m.detector_id,
    claim_kind: m.claim_kind,
    assertion: m.assertion,
    viewport: m.cap.vp,
    measurement: m.measurement,
    self_confirming: m.self_confirming,
    capture_complete: m.capture_complete,
    ...(m.incomplete_reasons && m.incomplete_reasons.length ? { incomplete_reasons: m.incomplete_reasons } : {}),
    capture_context: {
      banner_state: c.banner_state,
      banner_actions: m.cap.banner.actions,
      blocked_requests_count: c.blocked_requests_count,
      js_error_count: c.js_error_count,
      scroll_completed: c.scroll_completed,
      layout_stable: c.layout_stable,
      http_status: c.http_status,
    },
  };
}

const fitsViewport = (r: Rect, c: ViewportCapture) => r.x >= 0 && r.y >= 0 && r.x + r.w <= c.width && r.y + r.h <= c.height;
const shotFor = (r: Rect, c: ViewportCapture) => (fitsViewport(r, c) ? c.screenshots.viewport.file : c.screenshots.fullpage.file);

// ------------------------------------------------------------------------------------------------ №2
export function detectShippingDepth(inp: DetectInput): EvidenceRow[] {
  if (inp.page_type !== "product") return [];
  const { D, M } = inp;
  // утримання повністю (map §4 п.3)
  for (const c of [D, M]) if (!is2xx(c) || !c.completeness.navigation_completed || c.completeness.visible_text_length < 200) return [];
  const caps = [D, M];
  const d0 = caps.some((c) => c.text_nodes.some((n) => SHIP_RE.test(n.t)) || c.images.some((i) => i.alt && SHIP_RE.test(i.alt)));
  const d1 = caps.some((c) =>
    c.links.some((l) => {
      if (!l.visible || !sameOrigin(l.abs, c.final_url)) return false;
      let p = "";
      try {
        p = new URL(l.abs).pathname;
      } catch {
        /* ignore */
      }
      return SHIP_RE.test(l.name) || SHIP_RE.test(l.text) || SHIP_PATH_RE.test(p);
    }),
  );
  if (d0 || d1) return [];
  const reasons = [...new Set([...D.completeness.incomplete_reasons, ...M.completeness.incomplete_reasons])].sort();
  const complete = reasons.length === 0;
  const linkTexts = [...new Set(M.links.filter((l) => l.visible).map((l) => l.name || l.text).filter(Boolean))];
  const region: Rect = { x: 0, y: 0, w: Math.max(M.width, M.overflow.scroll_width), h: M.overflow.scroll_height };
  return [
    mk({
      input: inp,
      cap: M,
      detector_id: "shipping_depth",
      claim_kind: "deep_link_only",
      category: "shipping",
      type: "dom",
      source_class: "OBSERVED",
      assertion: "absence",
      region,
      artifact_reference: M.screenshots.fullpage.file,
      screenshot_reference: M.screenshots.fullpage.file,
      description: `На сторінці продукту немає видимого тексту про доставку й посилання на неї (перевірено D і M): інформація про доставку — щонайменше за 2 кліки.${complete ? "" : " Можлива неповнота захоплення."}`,
      excerpt: `Видимі посилання сторінки: ${linkTexts.join(" | ")}`,
      measurement: { d0, d1, union_of: ["D", "M"], depth_clicks: null, shipping_found_via: null },
      self_confirming: complete,
      capture_complete: complete,
      incomplete_reasons: reasons,
    }),
  ];
}

// ------------------------------------------------------------------------------------------------ №5
export function detectCtaBelowFold(inp: DetectInput): EvidenceRow[] {
  if (inp.page_type !== "product") return [];
  const out: EvidenceRow[] = [];
  for (const c of [inp.D, inp.M]) {
    if (!c.completeness.layout_stable) continue;
    const cands = c.interactive.filter((i) => CTA_RE.test(i.name.trim()));
    if (cands.length === 0) continue;
    const maxVis = Math.max(...cands.map((i) => i.vis));
    if (maxVis >= CTA_VIS_THRESHOLD) continue;
    const best = [...cands].sort((a, b) => b.vis - a.vis || a.rect.y - b.rect.y || a.selector.localeCompare(b.selector))[0]!;
    const bannerOpen = c.completeness.banner_state === "open";
    out.push(
      mk({
        input: inp,
        cap: c,
        detector_id: "cta_below_fold",
        claim_kind: "below_fold",
        category: "cta",
        type: "dom",
        source_class: "OBSERVED",
        assertion: "presence",
        selector: best.selector,
        region: best.rect,
        artifact_reference: c.screenshots.fullpage.file,
        screenshot_reference: c.screenshots.fullpage.file,
        description: `Основна кнопка «${best.name}» лежить нижче першого вікна: верхній край на ${best.rect.y}px при висоті вікна ${c.height}px.${bannerOpen ? " Можлива неповнота захоплення (банер відкритий)." : ""}`,
        excerpt: `${best.name} — ${best.selector}`,
        measurement: { top_px: best.rect.y, vh: c.height, vis: best.vis, candidates: cands.length },
        self_confirming: !bannerOpen,
        capture_complete: !bannerOpen,
        incomplete_reasons: bannerOpen ? ["banner_open"] : [],
      }),
    );
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ №6, №9 (і решта правил axe)
export function detectAxe(inp: DetectInput): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  for (const c of [inp.D, inp.M]) {
    for (const v of c.axe.violations) {
      for (const n of v.nodes) {
        const region: Rect = n.rect && n.rect.w * n.rect.h > 0 ? n.rect : { x: 0, y: 0, w: c.width, h: c.height };
        out.push(
          mk({
            input: inp,
            cap: c,
            detector_id: `axe:${v.id}`,
            claim_kind: `axe:${v.id}`,
            category: "accessibility",
            type: "axe",
            source_class: "BENCHMARKED",
            assertion: "presence",
            selector: n.target,
            region,
            artifact_reference: c.files.axe,
            screenshot_reference: shotFor(region, c),
            description: `${v.help} (${v.impact ?? "n/a"}). ${n.failureSummary.split("\n").slice(0, 2).join(" ").trim()}`,
            excerpt: `${n.target} — ${n.html} — ${n.failureSummary}`,
            measurement: { rule: v.id, impact: v.impact, helpUrl: v.helpUrl, axe_version: c.axe.version, nodes_in_rule: v.nodes.length },
            self_confirming: true,
            capture_complete: c.completeness.capture_complete,
            incomplete_reasons: c.completeness.incomplete_reasons,
          }),
        );
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ №7
export function detectHorizontalOverflow(inp: DetectInput): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  for (const c of [inp.D, inp.M]) {
    if (!c.completeness.layout_stable) continue;
    const overflowPx = c.overflow.scroll_width - c.width;
    if (overflowPx < OVERFLOW_MIN_PX) continue;
    const first = c.overflow.offenders[0];
    const region: Rect = first ? first.rect : { x: c.width, y: 0, w: overflowPx, h: c.overflow.scroll_height };
    out.push(
      mk({
        input: inp,
        cap: c,
        detector_id: "horizontal_overflow",
        claim_kind: "horizontal_overflow",
        category: "mobile_usability",
        type: "dom",
        source_class: "OBSERVED",
        assertion: "presence",
        selector: first?.selector ?? "html",
        region,
        artifact_reference: c.screenshots.fullpage.file,
        screenshot_reference: c.screenshots.fullpage.file,
        description: `Сторінка прокручується вбік на ${c.width}px: scrollWidth ${c.overflow.scroll_width}px, надлишок ${overflowPx}px.`,
        excerpt: c.overflow.offenders.map((o) => o.selector).join(" | "),
        measurement: { scroll_width: c.overflow.scroll_width, overflow_px: overflowPx, offenders: c.overflow.offenders.map((o) => ({ selector: o.selector, right: o.right })) },
        self_confirming: true,
        capture_complete: c.completeness.capture_complete,
        incomplete_reasons: c.completeness.incomplete_reasons,
      }),
    );
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ №8
export function detectOversizedImage(inp: DetectInput): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  for (const c of [inp.D, inp.M]) {
    for (const row of c.requests) {
      if (row.blocked || !row.content_type?.startsWith("image/") || row.content_type === "image/svg+xml") continue;
      if (row.status !== 200 || row.body_bytes === null || row.body_bytes < SIZE_THRESHOLD_BYTES) continue;
      const img = c.images.find((i) => i.current_src === row.url);
      if (!img) continue; // завантажене, але не відмальоване
      const dpr = c.dpr;
      const oversize = img.natural_w && img.rect.w && img.rect.h ? (img.natural_w * img.natural_h) / (img.rect.w * img.rect.h * dpr * dpr) : null;
      out.push(
        mk({
          input: inp,
          cap: c,
          detector_id: "oversized_image",
          claim_kind: "oversized_image",
          category: "performance",
          type: "dom",
          source_class: "OBSERVED",
          assertion: "presence",
          selector: img.selector,
          region: img.rect,
          artifact_reference: c.files.network,
          screenshot_reference: shotFor(img.rect, c),
          description: `Зображення важить ${(row.body_bytes / 1024).toFixed(0)} КБ (поріг ${SIZE_THRESHOLD_BYTES / 1024} КБ) і відмальоване ${img.rect.w}×${img.rect.h}px при природному ${img.natural_w}×${img.natural_h}px.`,
          excerpt: `${row.url} — ${row.body_bytes} B — natural ${img.natural_w}×${img.natural_h}, rendered ${img.rect.w}×${img.rect.h}`,
          measurement: { body_bytes: row.body_bytes, natural_w: img.natural_w, natural_h: img.natural_h, rendered_w: img.rect.w, rendered_h: img.rect.h, oversize_ratio: oversize === null ? null : Math.round(oversize * 100) / 100 },
          self_confirming: true,
          capture_complete: c.completeness.capture_complete,
          incomplete_reasons: c.completeness.incomplete_reasons,
          idExtra: new URL(row.url).pathname,
        }),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ №10
export function detectPriceFirstViewport(inp: DetectInput): EvidenceRow[] {
  if (inp.page_type !== "product" && inp.page_type !== "category") return [];
  const out: EvidenceRow[] = [];
  for (const c of [inp.D, inp.M]) {
    const comp = c.completeness;
    if (!is2xx(c) || !comp.navigation_completed || comp.visible_text_length < 200 || !comp.layout_stable) continue; // утримання (map §4 п.3)
    const real = c.price_candidates.filter((p) => !p.excluded);
    if (real.some((p) => p.in_fv)) continue;
    const firstY = real.length ? Math.min(...real.map((p) => p.rect.y)) : null;
    const reasons = comp.incomplete_reasons;
    const complete = reasons.length === 0;
    out.push(
      mk({
        input: inp,
        cap: c,
        detector_id: "price_first_viewport",
        claim_kind: "not_in_first_viewport",
        category: "pricing",
        type: "screenshot",
        source_class: "OBSERVED",
        assertion: "absence",
        region: { x: 0, y: 0, w: c.width, h: c.height },
        artifact_reference: c.screenshots.viewport.file,
        screenshot_reference: c.screenshots.viewport.file,
        description: `У першому вікні ${c.width}×${c.height} немає ціни${firstY === null ? " (на сторінці її не знайдено взагалі)" : ` (перша ціна на ${firstY}px)`}.${complete ? "" : " Можлива неповнота захоплення."}`,
        excerpt: c.fv_text,
        measurement: { first_price_y: firstY, price_depth_clicks: null, price_candidates: real.length },
        self_confirming: complete,
        capture_complete: complete,
        incomplete_reasons: reasons,
      }),
    );
  }
  return out;
}

export function detectAll(inp: DetectInput): EvidenceRow[] {
  const all = [
    ...detectShippingDepth(inp),
    ...detectCtaBelowFold(inp),
    ...detectAxe(inp),
    ...detectHorizontalOverflow(inp),
    ...detectOversizedImage(inp),
    ...detectPriceFirstViewport(inp),
  ];
  return all.sort((a, b) => a.detector_id.localeCompare(b.detector_id) || a.page_path.localeCompare(b.page_path) || a.viewport.localeCompare(b.viewport) || (a.selector_or_region.selector ?? "").localeCompare(b.selector_or_region.selector ?? ""));
}

export type { VP };
