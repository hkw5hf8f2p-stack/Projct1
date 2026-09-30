"use client";
import Link from "next/link";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { ERROR_CLASSES } from "@/lib/errors";
import { stepViews } from "@/lib/progress";
import type { AuditStatus, StepCounter, StepDetail } from "@/lib/types";

const DOT: Record<string, string> = { done: "✓", failed: "✕", skipped: "–", budget_limited: "!", pending: "·", running: "" };

/** UI-крок → id кроку контракту API (DEV-92) */
const API_STEP: Record<string, string> = { crawl: "discovering_pages", capture: "capturing", technical: "technical_checks", profile: "understanding_offering", lenses: "building_lenses", journeys: "testing_journeys" };
const minutes = (sec: number) => Math.max(1, Math.round(sec / 60));

function Counters({ d, now }: { d: StepDetail; now: number }) {
  const { t } = usePrefs();
  const counters = d.counters.filter((c) => c.total === null || c.total > 0 || c.done > 0);
  if (counters.length === 0) return null;
  const main: StepCounter | undefined = counters.find((c) => c.total !== null && c.total > 0);
  const pct = main && main.total ? Math.min(100, Math.round((main.done / main.total) * 100)) : null;
  const startedMs = d.started_at ? now - Date.parse(d.started_at) : null;
  return (
    <div className="step-progress" data-testid="step-progress">
      <div
        className={`pbar${pct === null ? " pbar-indeterminate" : ""}`}
        role="progressbar"
        aria-label={main ? t(`progress.counter.${main.unit}` as Key) : t("progress.title")}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct !== null ? { "aria-valuenow": pct } : {})}
      >
        <span style={{ width: pct === null ? "35%" : `${pct}%` }} />
      </div>
      <div className="small muted">
        {counters.map((c, i) => (
          <span key={`${c.unit}-${i}`} data-counter={c.unit} data-done={c.done} data-total={c.total ?? ""}>
            {i > 0 ? " · " : ""}
            {c.done}
            {c.total !== null ? ` / ${c.approx ? "≤" : ""}${c.total}` : ""} {t(`progress.counter.${c.unit}` as Key)}
            {c.eta_seconds !== undefined && c.eta_seconds !== null && c.total !== null && c.done < c.total && counters.length > 1 ? ` (${c.eta_seconds < 60 ? t("progress.eta_lt_min") : t("progress.eta", { min: minutes(c.eta_seconds) })})` : ""}
          </span>
        ))}
        {d.eta_seconds !== null ? (
          <span data-testid="step-eta"> · {d.eta_seconds < 60 ? t("progress.eta_lt_min") : t("progress.eta", { min: minutes(d.eta_seconds) })}</span>
        ) : startedMs !== null && startedMs >= 0 ? (
          <span data-testid="step-elapsed"> · {startedMs < 60_000 ? t("progress.working_lt_min") : t("progress.working_for", { min: Math.floor(startedMs / 60_000) })}</span>
        ) : null}
      </div>
    </div>
  );
}

export function ProgressView({ status }: { status: AuditStatus }) {
  const { t } = usePrefs();
  const steps = stepViews(status.stage_status, false, status.status !== "queued");
  const queued = status.status === "queued";
  const anyFailed = steps.some((s) => s.state === "failed");
  const now = Date.now();
  const detail = (id: string) => status.step_details?.find((d) => d.id === API_STEP[id]);
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
      {status.mode === "quick" && (
        <p className="callout callout-info" role="note" data-testid="progress-quick">
          {t("progress.mode_quick")}
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
              {s.state === "running" && detail(s.id) && <Counters d={detail(s.id) as StepDetail} now={now} />}
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
