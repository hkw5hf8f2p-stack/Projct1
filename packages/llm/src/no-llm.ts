import { readFileSync } from "node:fs";
import path from "node:path";

/** Банер режиму без LLM (G0-2, DEV-11): показується в звіті, доки синтетичний аналіз не виконувався */
export const NO_LLM_BANNER = { uk: "Синтетичний аналіз не виконувався: LLM-провайдер не налаштовано. Нижче лише детерміновані знахідки.", en: "Synthetic analysis was not run: no LLM provider is configured. Only deterministic findings are shown." } as const;

export interface DeterministicFinding { finding_key: string; category: string; confidence: string; evidence_families: string[]; evidence_ids: string[] }

/**
 * Каркас «звіту без LLM» для критерію 8: лише детерміновані знахідки S1a (родина F-DET/F-SUP/F-BRW, без SYNTHETIC/INFERRED) + банер.
 * Повний звіт (S4/S5) — поза S3; тут доводиться, що режим none не потребує жодного LLM-вмісту.
 */
export function buildNoLlmReportStub(artifactsDir: string, lang: "uk" | "en"): { banner: string; findings: DeterministicFinding[]; excluded_non_deterministic: number } {
  const all = JSON.parse(readFileSync(path.join(artifactsDir, "findings.json"), "utf8")) as DeterministicFinding[];
  const det = all.filter((f) => f.evidence_families.every((x) => x === "F-DET" || x === "F-SUP" || x === "F-BRW"));
  return { banner: NO_LLM_BANNER[lang], findings: det, excluded_non_deterministic: all.length - det.length };
}
