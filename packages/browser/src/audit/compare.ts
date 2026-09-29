/**
 * Порівняння результатів аудиту з EXPECTED.json (схема sitelens-fixture-expected/v1) → зведення PASS/FAIL.
 * Перевірки на кожен детермінований дефект: ≥1 Evidence на кожному очікуваному viewport, VERIFIED-знахідка,
 * artifact_reference відкривається, region у межах скриншота, region ∩ елемент з data-fx (лише тут, не в детекторах).
 * Мутанти: детектор виправленого дефекту мовчить, решта — той самий набір, що на базовій фікстурі.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EvidenceRow, FindingRow, Rect } from "./types.js";
import { findingKey } from "./findings.js";

export interface ExpectedDefect {
  id: number;
  spec_ref: string;
  type: "deterministic" | "llm" | "hybrid";
  pages: string[];
  match: "any";
  viewports: Array<"D" | "M">;
  detector_id: string | null;
  detector_ids?: string[];
  support_detector_id?: string;
  claim_kind: string | null;
  assertion: "presence" | "absence" | null;
  categories: string[];
  page_groups: string[];
  evidence: { type: string; source_class: string; self_confirming: boolean };
  expected_confidence: string | null;
  region_marker: string;
  mutant: string | null;
}
export interface Expected {
  schema: string;
  fixture: string;
  defects: ExpectedDefect[];
  clean: { deterministic_findings_max: number; support_facts_max: number };
}

export interface DefectResult {
  id: number;
  spec_ref: string;
  detector: string | null;
  status: "PASS" | "FAIL" | "SKIP";
  checks: Record<string, boolean>;
  failures: string[];
  evidence_count: number;
  evidence_ids: string[];
}

export const loadExpected = (file: string): Expected => JSON.parse(readFileSync(file, "utf8")) as Expected;

const pngSize = (file: string) => {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export const detectorIdsOf = (d: ExpectedDefect): string[] => d.detector_ids ?? (d.detector_id ? [d.detector_id] : []);

export function matchEvidence(d: ExpectedDefect, evidence: EvidenceRow[]): EvidenceRow[] {
  const ids = detectorIdsOf(d);
  return evidence.filter(
    (e) =>
      ids.includes(e.detector_id) &&
      (d.pages.includes("*") || d.pages.includes(e.page_path)) &&
      (d.categories.includes(e.category)) &&
      (d.page_groups.includes("*") || d.page_groups.includes(e.page_group)) &&
      (d.claim_kind === null || e.claim_kind === d.claim_kind || e.claim_kind.startsWith("axe:")) &&
      (d.assertion === null || e.assertion === d.assertion) &&
      e.type === d.evidence.type &&
      e.source_class === d.evidence.source_class,
  );
}

export function checkDefects(expected: Expected, runDir: string, evidence: EvidenceRow[], findings: FindingRow[]): DefectResult[] {
  const out: DefectResult[] = [];
  for (const d of expected.defects) {
    if (d.type !== "deterministic") {
      out.push({ id: d.id, spec_ref: d.spec_ref, detector: d.support_detector_id ?? null, status: "SKIP", checks: {}, failures: ["LLM/гібрид: deferred to live pass (опорний детектор не входить у 7)"], evidence_count: 0, evidence_ids: [] });
      continue;
    }
    const ms = matchEvidence(d, evidence);
    const checks: Record<string, boolean> = {};
    const failures: string[] = [];
    const set = (k: string, ok: boolean, why: string) => {
      checks[k] = ok;
      if (!ok) failures.push(`${k}: ${why}`);
    };
    set("has_evidence", ms.length >= 1, "жодного Evidence");
    for (const vp of d.viewports) set(`viewport_${vp}`, ms.some((e) => e.viewport === vp), `немає Evidence на ${vp}`);
    const fkeys = new Set(ms.map(findingKey));
    const fs = findings.filter((f) => fkeys.has(f.finding_key) && f.detector_ids.some((x) => detectorIdsOf(d).includes(x)));
    set("verified", d.expected_confidence !== null && fs.some((f) => f.confidence === d.expected_confidence), `confidence ≠ ${d.expected_confidence} (${fs.map((f) => f.confidence).join(",") || "немає знахідки"})`);
    let allFiles = ms.length > 0;
    let allBounds = ms.length > 0;
    let allMarker = ms.length > 0;
    for (const e of ms) {
      const art = path.join(runDir, e.artifact_reference);
      const shot = path.join(runDir, e.screenshot_reference);
      if (!existsSync(art) || !existsSync(shot)) {
        allFiles = false;
        allBounds = false;
        continue;
      }
      const { w, h } = pngSize(shot);
      const r = e.selector_or_region.region;
      const wc = w / e.selector_or_region.dpr;
      const hc = h / e.selector_or_region.dpr;
      if (!(r.x >= 0 && r.y >= 0 && r.x + r.w <= wc + 1 && r.y + r.h <= hc + 1 && r.w > 0 && r.h > 0)) allBounds = false;
      const capFile = path.join(runDir, path.dirname(e.screenshot_reference), "capture.json");
      if (existsSync(capFile)) {
        const cap = JSON.parse(readFileSync(capFile, "utf8")) as { fx_markers?: Record<string, Rect[]> };
        const marks = cap.fx_markers?.[d.region_marker] ?? [];
        if (!marks.some((m) => inter(m, r) > 0)) allMarker = false;
      } else allMarker = false;
    }
    set("artifact_exists", allFiles, "файл artifact_reference/screenshot_reference не існує");
    set("region_in_screenshot", allBounds, "регіон виходить за межі скриншота");
    set("region_intersects_marker", allMarker, `регіон не перетинає елемент data-fx=${d.region_marker}`);
    out.push({ id: d.id, spec_ref: d.spec_ref, detector: detectorIdsOf(d).join("|"), status: failures.length ? "FAIL" : "PASS", checks, failures, evidence_count: ms.length, evidence_ids: ms.map((e) => e.id).sort() });
  }
  return out;
}

/** сигнатура набору для порівнянь: (detector_id, шлях, viewport, селектор); id вже хеш цього + детектор-специфіка */
export const evidenceKey = (e: EvidenceRow): string => `${e.detector_id}|${e.page_path}|${e.viewport}|${e.selector_or_region.selector ?? ""}|${e.id}`;
export const evidenceKeyWithRegion = (e: EvidenceRow): string => `${evidenceKey(e)}|${JSON.stringify(e.selector_or_region.region)}`;

export interface MutantResult {
  mutant: string;
  defect: number;
  detector_silent: boolean;
  fixed_detector_evidence: number;
  others_identical: boolean;
  others_baseline: number;
  others_mutant: number;
  diff_added: string[];
  diff_removed: string[];
  region_diffs: number;
  status: "PASS" | "FAIL";
}

export function checkMutant(d: ExpectedDefect, baseline: EvidenceRow[], mutant: EvidenceRow[]): MutantResult {
  const ids = detectorIdsOf(d);
  const fixed = mutant.filter((e) => ids.includes(e.detector_id));
  const baseOthers = baseline.filter((e) => !ids.includes(e.detector_id));
  const mutOthers = mutant.filter((e) => !ids.includes(e.detector_id));
  const bk = new Set(baseOthers.map(evidenceKey));
  const mk = new Set(mutOthers.map(evidenceKey));
  const added = [...mk].filter((k) => !bk.has(k)).sort();
  const removed = [...bk].filter((k) => !mk.has(k)).sort();
  const bkr = new Set(baseOthers.map(evidenceKeyWithRegion));
  const regionDiffs = mutOthers.filter((e) => !bkr.has(evidenceKeyWithRegion(e))).length;
  const identical = added.length === 0 && removed.length === 0;
  return {
    mutant: d.mutant ?? "",
    defect: d.id,
    detector_silent: fixed.length === 0,
    fixed_detector_evidence: fixed.length,
    others_identical: identical,
    others_baseline: baseOthers.length,
    others_mutant: mutOthers.length,
    diff_added: added,
    diff_removed: removed,
    region_diffs: regionDiffs,
    status: fixed.length === 0 && identical ? "PASS" : "FAIL",
  };
}
