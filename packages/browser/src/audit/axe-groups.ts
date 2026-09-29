/**
 * Групування axe-знахідок (критик S1a §3, задача 4): (rule, page_group, компонент/селекторна сигнатура) → одна знахідка з `instances`
 * і повним переліком evidence_ids (докази не губляться: кожен вузол лишається окремим Evidence). Сигнатура — нормалізований селектор
 * (без nth-*, без числових суфіксів id, хвіст з ≤ 3 компонентів) + для color-contrast пара кольорів з failureSummary.
 */
import type { EvidenceRow } from "./types.js";

const NTH = /:(nth-child|nth-of-type|nth-last-child|nth-last-of-type)\([^)]*\)/g;

export function normalizeSelector(target: string): string {
  const t = target.replace(NTH, "").replace(/:(first|last)-(child|of-type)/g, "").replace(/#([\w-]*?)[-_]?\d+\b/g, "#$1-N").replace(/\s+/g, " ").trim();
  const parts = t.split(/\s*>\s*/).filter(Boolean);
  const tail = parts.slice(-3).join(" > ");
  return tail || t;
}

export function contrastPair(failureSummary: string): string | null {
  const fg = /foreground color:\s*(#[0-9a-f]{3,8})/i.exec(failureSummary)?.[1];
  const bg = /background color:\s*(#[0-9a-f]{3,8})/i.exec(failureSummary)?.[1];
  return fg && bg ? `${fg.toLowerCase()}/${bg.toLowerCase()}` : null;
}

/** компонент = орієнтир/тег вузла (footer/a, header/span, main/img), а без нього — нормалізований селектор; для color-contrast + пара кольорів */
export function componentSignature(rule: string, target: string, failureSummary: string, landmark?: string | null, tag?: string | null): string {
  const sel = landmark && tag ? `${landmark}/${tag}` : normalizeSelector(target);
  const pair = rule === "color-contrast" ? contrastPair(failureSummary) : null;
  return pair ? `${sel} [${pair}]` : sel;
}

const TEMPLATE_LANDMARKS = new Set(["header", "nav", "footer"]);
/** page_group знахідки для axe-групи: шаблонний компонент (header/nav/footer), що повторюється в ≥ 2 групах сторінок, — одна знахідка на сайт ("*") */
export const findingPageGroup = (e: EvidenceRow): string => String(e.measurement["finding_page_group"] ?? e.page_group);

/** позначає шаблонні axe-компоненти, що повторюються на ≥ 2 групах сторінок (доказ лишається за своєю сторінкою; змінюється лише ключ групи) */
export function assignAxeScopes(evidence: EvidenceRow[]): void {
  const by = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    if (e.type !== "axe" || !TEMPLATE_LANDMARKS.has(String(e.measurement["component_landmark"] ?? ""))) continue;
    const k = `${e.claim_kind}|${String(e.measurement["component_signature"] ?? "")}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(e);
  }
  for (const list of by.values()) if (new Set(list.map((e) => e.page_group)).size >= 2) for (const e of list) e.measurement["finding_page_group"] = "*";
}

export interface AxeGroup {
  rule: string;
  page_group: string;
  component: string;
  instances: number;
  impact: string | null;
  viewports: string[];
  pages: string[];
  examples: Array<{ evidence_id: string; page: string; viewport: string; selector: string; excerpt: string }>;
  evidence_ids: string[];
}

export function groupAxe(evidence: EvidenceRow[]): AxeGroup[] {
  const by = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    if (e.type !== "axe") continue;
    const k = `${e.claim_kind}|${findingPageGroup(e)}|${String(e.measurement["component_signature"] ?? "")}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(e);
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, list]) => {
      const first = list[0]!;
      return {
        rule: String(first.measurement["rule"] ?? first.claim_kind.replace(/^axe:/, "")),
        page_group: findingPageGroup(first),
        component: String(first.measurement["component_signature"] ?? ""),
        instances: list.length,
        impact: (first.measurement["impact"] as string | null) ?? null,
        viewports: [...new Set(list.map((e) => e.viewport))].sort(),
        pages: [...new Set(list.map((e) => e.page_path))].sort(),
        examples: list.slice(0, 3).map((e) => ({ evidence_id: e.id, page: e.page_path, viewport: e.viewport, selector: e.selector_or_region.selector ?? "", excerpt: (e.excerpt ?? "").slice(0, 160) })),
        evidence_ids: list.map((e) => e.id).sort(),
      };
    });
}
