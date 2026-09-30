/**
 * Позитивні знахідки §29 у детермінованому режимі (DEV-61): лише предикати над захопленням, без LLM.
 * Позитив — твердження ПРИСУТНОСТІ (ціна видна, кнопка в першому екрані…), а не «детектор мовчить»: мовчання детектора
 * ≠ відсутність дефекту (coverage). Кожен позитив:
 * - має ≥ 1 доказ OBSERVED на кожній сторінці/viewport своєї області;
 * - утримується (withheld), якщо хоч одна сторінка області має неповне захоплення або області немає;
 * - не існує, якщо є проблемна знахідка того самого виміру (узгодженість звіту).
 */
import { createHash } from "node:crypto";
import { CTA_RE, OVERFLOW_MIN_PX, SHIP_RE } from "@sitelens/browser/src/audit/patterns.js";
import type { PageIn, VP } from "./types.js";

export interface PositiveEvidenceDraft {
  id: string;
  page: PageIn;
  vp: VP;
  measurement: Record<string, number | string | boolean | null>;
  excerpt: string | null;
}
export interface PositiveDraft {
  key: string;
  kind: string;
  category: "pricing" | "cta" | "shipping" | "mobile_usability" | "accessibility";
  page_group: string;
  pages: PageIn[];
  evidence: PositiveEvidenceDraft[];
}
export interface PositiveResult { positives: PositiveDraft[]; withheld: Array<{ key: string; reason: string }> }

const evId = (s: string) => "ev_" + createHash("sha256").update("positive|" + s).digest("hex").slice(0, 12);
const VPS: VP[] = ["D", "M"];

interface Spec {
  kind: string;
  category: PositiveDraft["category"];
  page_group: "product" | "*";
  /** проблемні знахідки, що виключають позитив (category|page_group|claim_kind-префікс) */
  conflicts: (key: string) => boolean;
  vps: VP[];
  /** на кожному (сторінка, vp) — вимір, або null (предикат хибний) */
  check: (p: PageIn, vp: VP) => { measurement: PositiveEvidenceDraft["measurement"]; excerpt: string | null } | null;
  /** достатньо одного vp на сторінці (текст доставки) */
  anyVp?: boolean;
}

const SPECS: Spec[] = [
  {
    kind: "price_in_first_viewport", category: "pricing", page_group: "product", vps: VPS,
    conflicts: (k) => k.startsWith("pricing|product|"),
    check: (p, vp) => {
      const c = p.captures[vp];
      if (!c) return null;
      const hit = c.price_candidates.filter((x) => x.in_fv && !x.excluded).sort((a, b) => a.rect.y - b.rect.y)[0];
      return hit ? { measurement: { price_y: Math.round(hit.rect.y), viewport_height: c.height }, excerpt: hit.text ?? null } : null;
    },
  },
  {
    kind: "cta_in_first_viewport", category: "cta", page_group: "product", vps: VPS,
    conflicts: (k) => k.startsWith("cta|product|"),
    check: (p, vp) => {
      const c = p.captures[vp];
      if (!c) return null;
      const hit = c.buttons.filter((b) => b.visible && CTA_RE.test(b.name.trim()) && b.rect.y >= 0 && b.rect.y + b.rect.h <= c.height).sort((a, b) => a.rect.y - b.rect.y)[0];
      return hit ? { measurement: { button_bottom_px: Math.round(hit.rect.y + hit.rect.h), viewport_height: c.height }, excerpt: hit.name } : null;
    },
  },
  {
    kind: "shipping_on_product_page", category: "shipping", page_group: "product", vps: VPS, anyVp: true,
    conflicts: (k) => k.startsWith("shipping|product|"),
    check: (p, vp) => {
      const c = p.captures[vp];
      if (!c) return null;
      const line = c.visible_text.split(/\n+/).find((l) => SHIP_RE.test(l));
      return line ? { measurement: {}, excerpt: line.trim().slice(0, 200) } : null;
    },
  },
  {
    kind: "no_horizontal_overflow", category: "mobile_usability", page_group: "*", vps: ["M"],
    conflicts: (k) => k.startsWith("mobile_usability|") && k.includes("|horizontal_overflow"),
    check: (p, vp) => {
      const c = p.captures[vp];
      if (!c) return null;
      return c.overflow.scroll_width - c.overflow.client_width < OVERFLOW_MIN_PX ? { measurement: { scroll_width: c.overflow.scroll_width, viewport_width: c.width }, excerpt: null } : null;
    },
  },
  {
    kind: "images_have_alt", category: "accessibility", page_group: "*", vps: VPS,
    conflicts: (k) => k.startsWith("accessibility|") && k.includes("|axe:image-alt"),
    check: (p, vp) => {
      const c = p.captures[vp];
      if (!c) return null;
      const imgs = c.images.filter((i) => !i.is_background);
      const withAlt = imgs.filter((i) => typeof i.alt === "string").length;
      return withAlt === imgs.length ? { measurement: { with_alt: withAlt, total: imgs.length }, excerpt: null } : null;
    },
  },
];

export function positiveFindings(pages: readonly PageIn[], findingKeys: readonly string[]): PositiveResult {
  const positives: PositiveDraft[] = [];
  const withheld: PositiveResult["withheld"] = [];
  for (const s of SPECS) {
    const key = `${s.kind}|${s.page_group}`;
    if (findingKeys.some(s.conflicts)) continue; // є проблемна знахідка того самого виміру — позитиву немає (не withheld)
    const scope = pages.filter((p) => (s.page_group === "product" ? p.page_type === "product" : true)).slice().sort((a, b) => (a.path < b.path ? -1 : 1));
    if (scope.length === 0) {
      withheld.push({ key, reason: "no_pages_in_scope" });
      continue;
    }
    const incomplete = scope.flatMap((p) => s.vps.filter((vp) => p.capture[vp]?.capture_complete !== true).map((vp) => `${p.path}:${vp}`));
    if (incomplete.length) {
      withheld.push({ key, reason: `capture_incomplete:${incomplete.join(",")}` });
      continue;
    }
    const ev: PositiveEvidenceDraft[] = [];
    let ok = true;
    for (const p of scope) {
      const hits = s.vps.map((vp) => [vp, s.check(p, vp)] as const).filter(([, r]) => r !== null) as Array<readonly [VP, NonNullable<ReturnType<Spec["check"]>>]>;
      if (s.anyVp ? hits.length === 0 : hits.length !== s.vps.length) {
        ok = false;
        break;
      }
      for (const [vp, r] of s.anyVp ? hits.slice(0, 1) : hits) ev.push({ id: evId(`${key}|${p.path}|${vp}`), page: p, vp, measurement: r.measurement, excerpt: r.excerpt });
    }
    if (!ok) continue; // предикат хибний хоча б на одній сторінці — позитиву немає
    if (s.kind === "images_have_alt" && ev.every((e) => e.measurement["total"] === 0)) {
      withheld.push({ key, reason: "no_content_images" });
      continue;
    }
    positives.push({ key, kind: s.kind, category: s.category, page_group: s.page_group, pages: scope, evidence: ev });
  }
  return { positives, withheld };
}
