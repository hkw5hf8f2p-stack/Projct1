"use client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { ConfidenceBadge, PriorityLabel } from "../Badges";
import { Claim } from "../Claim";
import { Disclaimer } from "../Disclaimer";
import { EvidenceRow } from "../EvidenceRow";
import { useReport } from "../ReportContext";

/** Воронка (7 етапів) з накладеними знахідками й сильними сторонами; далі — синтетичні шляхи як докази `journey` */
export function JourneyTab() {
  const { report, openFinding } = useReport();
  const { t } = usePrefs();
  const noLlm = report.audit.llm_mode === "none";
  const fById = new Map(report.findings.map((f) => [f.id, f]));
  const pById = new Map(report.positive_findings.map((p) => [p.id, p]));
  const journeyEv = report.evidence.filter((e) => e.level === "journey" && e.session_id);
  const bySession = new Map<string, typeof journeyEv>();
  for (const e of journeyEv) bySession.set(e.session_id as string, [...(bySession.get(e.session_id as string) ?? []), e]);
  const stage = report.audit.stage_status["browser_sessions"];
  const partial = stage?.status === "failed" || stage?.status === "budget_limited";
  const su = report.site_understanding;
  return (
    <div className="stack" data-testid="journey">
      <h2>{t("journey.title")}</h2>
      <p className="muted">{t("journey.lead")}</p>
      {noLlm && <Disclaimer id="no_llm_mode" tone="warn" />}
      {su && (
        <div className="card">
          <div className="section-label">{t("overview.understanding.journey")}</div>
          <Claim text={su.primary_customer_journey} />
        </div>
      )}
      <ol className="plain funnel" aria-label={t("journey.title")}>
        {report.funnel.map((s) => {
          const fs = s.finding_ids.map((id) => fById.get(id)).filter((f): f is NonNullable<typeof f> => !!f);
          const ps = s.positive_ids.map((id) => pById.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
          return (
            <li key={s.stage} className="funnel-stage" data-testid="funnel-stage" data-stage={s.stage}>
              <h3>{t(`journey.stage.${s.stage}` as Key)}</h3>
              {fs.length === 0 && ps.length === 0 && <p className="muted small">{t("journey.empty_stage")}</p>}
              {fs.length > 0 && (
                <>
                  <div className="section-label">{t("journey.problems")}</div>
                  <ul className="plain stack" style={{ gap: 8 }}>
                    {fs.map((f) => (
                      <li key={f.id} data-testid="funnel-finding">
                        <div className="row">
                          <ConfidenceBadge level={f.confidence.level} />
                          <PriorityLabel value={f.priority.value} />
                        </div>
                        <Claim text={f.title} />
                        <button type="button" className="link-btn small" onClick={() => openFinding(f.id)}>
                          {t("overview.open_finding")}
                          <span className="sr-only"> #{f.rank}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {ps.length > 0 && (
                <>
                  <div className="section-label">{t("journey.strengths")}</div>
                  <ul className="plain stack" style={{ gap: 6 }}>
                    {ps.map((p) => (
                      <li key={p.id}>
                        <Claim text={p.title} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          );
        })}
      </ol>
      <section className="card" aria-labelledby="journey-sessions">
        <h2 id="journey-sessions">{t("journey.sessions")}</h2>
        {partial && (
          <p className="callout callout-warn" role="status" data-testid="journey-partial">
            {t("journey.partial")}
          </p>
        )}
        {noLlm ? (
          <p className="muted">{t("journey.no_llm")}</p>
        ) : bySession.size === 0 ? (
          <p className="muted" data-testid="no-sessions">
            {t("journey.no_sessions")}
          </p>
        ) : (
          <>
            <Disclaimer id="synthetic_single_model_correlated" />
            {[...bySession.entries()].map(([sid, evs]) => (
              <div key={sid} data-testid="session" data-session-id={sid}>
                <div className="section-label">
                  {t("journey.session")} <span className="mono">{sid}</span>
                </div>
                <ul className="plain">
                  {evs.map((e) => (
                    <EvidenceRow key={e.id} ev={e} />
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
