"use client";
import { createContext, useContext } from "react";
import type { Report } from "@/lib/types";

export interface ReportCtx {
  report: Report;
  auditId: string;
  artifactsDeleted: boolean;
  openEvidence: (evidenceId: string) => void;
  openFinding: (findingId: string) => void;
}
export const ReportContext = createContext<ReportCtx | null>(null);
export function useReport(): ReportCtx {
  const v = useContext(ReportContext);
  if (!v) throw new Error("useReport: немає ReportContext");
  return v;
}
