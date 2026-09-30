"use client";
import Link from "next/link";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { ERROR_CLASSES } from "@/lib/errors";
import { stepViews } from "@/lib/progress";
import type { AuditStatus } from "@/lib/types";

const DOT: Record<string, string> = { done: "✓", failed: "✕", skipped: "–", budget_limited: "!", pending: "·", running: "" };

export function ProgressView({ status }: { status: AuditStatus }) {
  const { t } = usePrefs();
  const steps = stepViews(status.stage_status, false, status.status !== "queued");
  const queued = status.status === "queued";
  const anyFailed = steps.some((s) => s.state === "failed");
  return (
    <section className="card" aria-labelledby="progress-h" data-testid="progress" data-audit-status={status.status}>
      <h1 id="progress-h">{t("progress.title")}</h1>
      <p className="muted">
        {t("progress.for")}: <span className="mono">{status.normalized_url}</span>
      </p>
      <p aria-live="polite" data-testid="progress-summary">
        {queued ? t("progress.queued") : t("progress.running")}
      </p>
      {anyFailed && (
        <p className="callout callout-warn" role="status" data-testid="progress-partial">
          {t("progress.partial")}
        </p>
      )}
      {status.llm_mode === "none" && (
        <p className="callout callout-info" role="note">
          {t("progress.no_llm_note")}
        </p>
      )}
      <ol className="plain steps" aria-label={t("progress.title")}>
        {steps.map((s, i) => (
          <li key={s.id} className={`step step-${s.state}`} data-step={s.id} data-state={s.state}>
            <span className="step-dot" aria-hidden="true">
              {s.state === "running" ? <span className="spinner" /> : DOT[s.state] ?? i + 1}
            </span>
            <div>
              <strong>{t(s.label)}</strong>
              <div className="small muted">
                {t(`progress.state.${s.state}` as Key)}
                {s.reason ? ` · ${t("progress.reason")}: ${s.reason}` : ""}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ErrorView({ cls, message }: { cls: string | null; message: string | null }) {
  const { t } = usePrefs();
  const known = cls && (ERROR_CLASSES as readonly string[]).includes(cls);
  const label = cls ? (known ? t(`error.${cls}` as Key) : cls === "not_found" ? t("error.not_found") : cls === "unauthorized" ? t("error.unauthorized") : t("error.unknown")) : t("error.unknown");
  return (
    <section className="card" role="alert" aria-labelledby="err-h" data-testid="audit-error" data-error-class={cls ?? "unknown"}>
      <h1 id="err-h">{t("error.title")}</h1>
      <p className="callout callout-danger">
        <strong>{label}</strong>
        {cls && (
          <span className="small">
            {t("error.class")}: <span className="mono">{cls}</span>
          </span>
        )}
      </p>
      {message && <p className="muted small">{message}</p>}
      <p>{t("error.no_fabrication")}</p>
      <Link href="/" className="btn">
        {t("error.retry")}
      </Link>
    </section>
  );
}
