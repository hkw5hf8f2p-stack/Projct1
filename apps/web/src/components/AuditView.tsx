"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getReport, getStatus, type ApiFailure } from "@/lib/client";
import { usePrefs } from "@/lib/prefs";
import type { AuditStatus, Report } from "@/lib/types";
import { ErrorView, ProgressView } from "./Progress";
import { ReportShell } from "./ReportShell";
import { TokenPrompt } from "./TokenPrompt";

type View =
  | { k: "loading" }
  | { k: "token"; rejected: boolean }
  | { k: "progress"; status: AuditStatus }
  | { k: "failed"; status: AuditStatus }
  | { k: "gone"; f: ApiFailure }
  | { k: "report_loading"; status: AuditStatus }
  | { k: "report_error"; status: AuditStatus; f: ApiFailure }
  | { k: "bad_schema" }
  | { k: "report"; status: AuditStatus; report: Report };

const POLL_MS = 800;

export function AuditView({ id }: { id: string }) {
  const { t } = usePrefs();
  const [view, setView] = useState<View>({ k: "loading" });
  const tokenTried = useRef(false);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(
    async (signal: { stop: boolean }) => {
      for (;;) {
        const s = await getStatus(id);
        if (signal.stop) return;
        if (!s.ok) {
          if (s.http === 401) {
            setView({ k: "token", rejected: tokenTried.current });
            tokenTried.current = true;
            return;
          }
          if (s.http === 404) {
            setView({ k: "gone", f: s });
            return;
          }
          // тимчасова мережева помилка: лишаємо попередній вигляд і пробуємо ще
          await new Promise((r) => setTimeout(r, POLL_MS * 2));
          if (signal.stop) return;
          continue;
        }
        const st = s.data;
        if (st.status === "failed") return setView({ k: "failed", status: st });
        if (st.status !== "completed") {
          setView({ k: "progress", status: st });
          await new Promise((r) => setTimeout(r, POLL_MS));
          if (signal.stop) return;
          continue;
        }
        setView({ k: "report_loading", status: st });
        const r = await getReport(id);
        if (signal.stop) return;
        if (!r.ok) return setView({ k: "report_error", status: st, f: r });
        if ((r.data as { schema_version?: string }).schema_version !== "sitelens-report/v1") return setView({ k: "bad_schema" });
        return setView({ k: "report", status: st, report: r.data });
      }
    },
    [id],
  );

  useEffect(() => {
    const signal = { stop: false };
    void load(signal);
    return () => {
      signal.stop = true;
    };
  }, [load, nonce]);

  switch (view.k) {
    case "loading":
      return <Skeleton label={t("common.loading")} />;
    case "token":
      return <TokenPrompt rejected={view.rejected && tokenTried.current} onSaved={() => setNonce((n) => n + 1)} />;
    case "progress":
      return <ProgressView status={view.status} />;
    case "failed":
      return <ErrorView cls={view.status.error?.class ?? null} message={view.status.error?.message ?? null} />;
    case "gone":
      return <ErrorView cls={view.f.cls} message={null} />;
    case "report_loading":
      return <Skeleton label={t("report.loading")} testid="report-loading" />;
    case "report_error":
      return (
        <section className="card" role="alert" data-testid="report-unavailable">
          <h1>{t("report.unavailable.title")}</h1>
          <p>{t("report.unavailable.lead")}</p>
          <p className="small muted">
            {t("report.unavailable.detail")}: <span className="mono">{view.f.http} {view.f.cls}</span>
          </p>
          <button type="button" className="btn" onClick={() => setNonce((n) => n + 1)}>
            {t("report.unavailable.retry")}
          </button>
        </section>
      );
    case "bad_schema":
      return (
        <p className="callout callout-danger" role="alert" data-testid="report-bad-schema">
          {t("report.bad_schema")}
        </p>
      );
    case "report":
      return <ReportShell report={view.report} auditId={id} artifactsDeleted={view.status.artifacts_deleted} />;
  }
}

function Skeleton({ label, testid = "audit-loading" }: { label: string; testid?: string }) {
  return (
    <section className="card" aria-busy="true" data-testid={testid}>
      <p role="status">{label}</p>
      <div className="skeleton" />
      <div className="skeleton" style={{ width: "70%" }} />
      <div className="skeleton" style={{ width: "85%" }} />
    </section>
  );
}
