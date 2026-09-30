"use client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { Measured } from "../Claim";
import { Disclaimer } from "../Disclaimer";
import { useReport } from "../ReportContext";
import { CostPanel } from "./CostPanel";

const SCORES = ["performance", "accessibility", "best_practices", "seo"] as const;
const METRICS = ["lcp_ms", "tbt_ms", "cls", "fcp_ms"] as const;

export function TechnicalTab() {
  const { report, openFinding } = useReport();
  const { t } = usePrefs();
  const tech = report.technical;
  const lh = tech.lighthouse;
  const ax = tech.accessibility;
  const cov = report.coverage;
  const fmt = (v: number | null) => (v === null ? "—" : String(v));
  return (
    <div className="stack" data-testid="technical">
      <h2>{t("technical.title")}</h2>
      <Disclaimer id="automated_a11y_not_wcag_audit" title />
      <p>
        {t("technical.status")}: <Measured cls="OBSERVED">{t(`technical.status.${tech.status}` as Key)}</Measured>
      </p>
      {tech.status !== "ok" && (
        <p className="callout callout-warn" role="status" data-testid="technical-partial">
          {t("technical.partial")}
        </p>
      )}

      <section className="card" aria-labelledby="t-lh" data-testid="lighthouse" data-status={lh.status}>
        <h3 id="t-lh">{t("technical.lighthouse")}</h3>
        <p>
          {t("technical.status")}: <Measured cls="OBSERVED">{t(`technical.lighthouse.status.${lh.status}` as Key)}</Measured>
          {lh.reason && (
            <span className="small muted">
              {" "}
              · {t("progress.reason")}: <span className="mono">{lh.reason}</span>
            </span>
          )}
        </p>
        <p className="small muted">{t("technical.lighthouse.note")}</p>
        {lh.runs.length === 0 ? (
          <p className="muted">{t("technical.lighthouse.empty")}</p>
        ) : (
          <ul className="plain grid-2">
            {lh.runs.map((r, i) => (
              <li key={i} className="stat" data-testid="lh-run">
                <strong className="mono">{new URL(r.page_url).pathname}</strong>
                <span className="small">{t(`technical.form_factor.${r.form_factor}` as Key)}</span>
                {r.status === "failed" ? (
                  <span className="callout callout-danger small">{t("technical.lighthouse.run.failed")}</span>
                ) : (
                  <dl className="kv small">
                    {SCORES.map((s) => (
                      <div key={s} style={{ display: "contents" }}>
                        <dt>{t(`technical.score.${s}` as Key)}</dt>
                        <dd>
                          <Measured cls="OBSERVED">{r.scores[s] === null ? "—" : t("technical.score.value", { n: r.scores[s] as number })}</Measured>
                        </dd>
                      </div>
                    ))}
                    {METRICS.map((m) => (
                      <div key={m} style={{ display: "contents" }}>
                        <dt>{t(`technical.metric.${m}` as Key)}</dt>
                        <dd>
                          <Measured cls="OBSERVED">{fmt(r.metrics[m])}</Measured>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="t-ax" data-testid="axe">
        <h3 id="t-ax">{t("technical.a11y")}</h3>
        <p className="small muted">
          {t("technical.a11y.engine")}: <span className="mono">{ax.engine}{ax.version ? ` ${ax.version}` : ""}</span>
        </p>
        {ax.groups.length === 0 ? (
          <p className="callout callout-ok" role="status">
            {t("technical.a11y.empty")}
          </p>
        ) : (
          <ul className="plain stack">
            {ax.groups.map((g, i) => (
              <li key={i} className="stat" data-testid="axe-group">
                <div className="row">
                  <strong className="mono">{g.rule}</strong>
                  <span className="chip">{t(`technical.impact.${g.impact ?? "none"}` as Key)}</span>
                </div>
                <div className="small">
                  <Measured cls="OBSERVED" label={t("technical.a11y.instances")}>
                    {g.instances}
                  </Measured>
                </div>
                <div className="small muted">
                  {t("technical.a11y.pages")}: <span className="mono">{g.pages.join(" · ")}</span>
                </div>
                <div className="small muted">
                  {t("technical.a11y.viewports")}: {g.viewports.map((v) => t(`evidence.viewport.${v}` as Key)).join(", ") || "—"}
                  {g.component ? <> · <span className="mono">{g.component}</span></> : null}
                </div>
                <div className="small">
                  {g.finding_id ? (
                    <button type="button" className="link-btn" onClick={() => openFinding(g.finding_id as string)}>
                      {t("technical.a11y.finding")} → {t("overview.open_finding")}
                    </button>
                  ) : (
                    <span className="muted">{t("technical.a11y.no_finding")}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="t-cov" data-testid="coverage">
        <h3 id="t-cov">{t("technical.coverage")}</h3>
        <div className="section-label">{t("technical.coverage.pages")}</div>
        <ul className="plain stack" style={{ gap: 6 }}>
          {cov.pages.map((p) => (
            <li key={p.url} className="small">
              <span className="mono">{p.path}</span> <span className="chip">{p.page_type}</span>{" "}
              <Measured cls="OBSERVED" label={t("technical.coverage.desktop")}>
                {p.capture_complete.D === null ? "—" : p.capture_complete.D ? t("technical.coverage.complete") : t("technical.coverage.incomplete")}
              </Measured>{" "}
              <Measured cls="OBSERVED" label={t("technical.coverage.mobile")}>
                {p.capture_complete.M === null ? "—" : p.capture_complete.M ? t("technical.coverage.complete") : t("technical.coverage.incomplete")}
              </Measured>
            </li>
          ))}
        </ul>
        <div className="section-label">{t("technical.coverage.withheld")}</div>
        {cov.withheld_findings.length === 0 ? (
          <p className="muted small">{t("technical.coverage.none")}</p>
        ) : (
          <ul className="plain stack" style={{ gap: 4 }}>
            {cov.withheld_findings.map((w) => (
              <li key={w.finding_key} className="small">
                <span className="mono">{w.finding_key}</span> · {t("technical.coverage.reason")}: <span className="mono">{w.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <CostPanel />
    </div>
  );
}
