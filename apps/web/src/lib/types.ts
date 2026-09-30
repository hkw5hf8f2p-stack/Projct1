/** Типи контракту звіту — лише type-import (стираються при збиранні), тож zod у клієнтський бандл не потрапляє. */
import type { Report as ReportT, ReportEvidence as EvidenceT, ReportFinding as FindingT, PositiveFinding as PositiveT, TemplatedText as TextT } from "@sitelens/schemas";

export type Report = ReportT;
export type Finding = FindingT;
export type Evidence = EvidenceT;
export type Positive = PositiveT;
export type TemplatedText = TextT;
export type SourceClass = Evidence["source_class"];
export type Confidence = Finding["confidence"]["level"];

/** Дзеркало `AuditStatusResponse` (packages/schemas/src/api.ts); відповідність перевіряє тест на фікстурах */
export interface AuditStatus {
  id: string;
  status: "queued" | "crawling" | "profiling" | "generating_lenses" | "running_scenarios" | "aggregating" | "completed" | "failed";
  input_url: string;
  normalized_url: string;
  language: "uk" | "en";
  llm_mode: "live" | "replay" | "none";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  stage_status: Record<string, unknown>;
  progress: { pages_captured: number; pages_failed: number; lighthouse_done: number; lighthouse_failed: number };
  warnings: Array<{ stage: string; page_url?: string; class?: string; message: string }>;
  error: { class: string; message: string } | null;
  artifacts_deleted: boolean;
  artifact_expires_at: string | null;
}
