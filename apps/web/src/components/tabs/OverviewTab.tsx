"use client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { Claim, Measured } from "../Claim";
import { ConfidenceBadge, PriorityLabel } from "../Badges";
import { Disclaimer } from "../Disclaimer";
import { useReport } from "../ReportContext";
import { CostPanel } from "./CostPanel";

export function OverviewTab() {
  const { report, openFinding } = useReport();
  const { t } = usePrefs();
  const { executive_summary: es, site_understanding: su, findings, positive_findings } = report;
  const noLlm = report.audit.llm_mode === "none";
  const byId = new Map(findings.map((f) => [f.id, f]));
  const posById = new Map(positive_findings.map((p) => [p.id, p]));
  const top = es.top_problem_ids.map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => !!f);
  const strengths = es.top_strength_ids.map((id) => posById.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  return (
    <div className="stack" data-testid="overview">
      {noLlm && <Disclaimer id="no_llm_mode" tone="warn" title />}
      <Disclaimer id="no_conversion_prediction" />
      <section className="card" aria-labelledby="ov-exec">
        <h2 id="ov-exec">{t("overview.exec.title")}</h2>
        {es.primary_conversion_goal && (
          <>
            <div className="section-label">{t("overview.goal")}</div>
            <Claim text={es.primary_conversion_goal} />
          </>
        )}
        {es.summary && (
          <>
            <div className="section-label">{t("overview.summary")}</div>
            <Claim text={es.summary} />
          </>
        )}
        {noLlm && !es.summary && <p className="muted">{t("overview.no_llm.title")}</p>}
      </section>

      <section className="card" aria-labelledby="ov-problems">
        <h2 id="ov-problems">{t("overview.top_problems")}</h2>
        {top.length === 0 ? (
          <p className="callout callout-ok" role="status" data-testid="no-major-problem">
            <strong>{t("overview.no_problem")}</strong>
            {t("overview.no_problem_detail")}
          </p>
        ) : (
          <>
            <Disclaimer id="priority_is_ranking_index" />
            <ol className="plain stack">
              {top.map((f) => (
                <li key={f.id} className="finding" data-testid="top-problem" data-finding-id={f.id} style={{ marginBottom: 0 }}>
                  <div className="finding-head">
                    <ConfidenceBadge level={f.confidence.level} />
                    <PriorityLabel value={f.priority.value} />
                    <span className="chip">{t(`cat.${f.category}` as Key)}</span>
                  </div>
                  <Claim text={f.title} />
                  <p style={{ marginTop: 6 }}>
                    <button type="button" className="link-btn" onClick={() => openFinding(f.id)} data-testid="open-finding">
                      {t("overview.open_finding")}
                      <span className="sr-only"> #{f.rank}</span>
                    </button>
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="ov-strengths">
        <h2 id="ov-strengths">{t("overview.top_strengths")}</h2>
        {strengths.length === 0 ? (
          <p className="muted">{t("overview.no_strengths")}</p>
        ) : (
          <ul className="plain stack" data-testid="strengths">
            {strengths.map((p) => (
              <li key={p.id} data-testid="strength">
                <Claim text={p.title} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="ov-facts">
        <h2 id="ov-facts">{t("overview.facts")}</h2>
        <div className="grid-2">
          <div className="stat">
            <span className="muted small">{t("overview.pages")}</span>
            <span className="stat-v">
              <Measured cls="OBSERVED">{es.pages_inspected}</Measured>
            </span>
          </div>
          <div className="stat">
            <span className="muted small">{t("overview.tech_status")}</span>
            <span className="stat-v">
              <Measured cls="OBSERVED">{t(`technical.status.${es.technical_status}` as Key)}</Measured>
            </span>
          </div>
          <div className="stat" data-testid="ov-model">
            <span className="muted small">{t("overview.model")}</span>
            <span className="stat-v">
              {report.audit.llm_model ? (
                /* TODO(backend): для claude_cli/openai_compatible llm_provider = null (enum LLM_PROVIDERS без них), а config_json.ai.provider у Report немає — тоді показуємо лише модель */
                <Measured cls="OBSERVED">
                  <span className="mono">{report.audit.llm_provider ? `${report.audit.llm_provider}/${report.audit.llm_model}` : report.audit.llm_model}</span>
                </Measured>
              ) : (
                <span className="muted">{t("overview.model.none")}</span>
              )}
            </span>
          </div>
          {!noLlm && (
            <>
              <div className="stat">
                <span className="muted small">{t("overview.sessions")}</span>
                <span className="stat-v">
                  <Measured cls="SYNTHETIC">{es.synthetic_snapshot_sessions}</Measured>
                </span>
              </div>
              <div className="stat">
                <span className="muted small">{t("overview.journeys")}</span>
                <span className="stat-v">
                  <Measured cls="SYNTHETIC">{es.synthetic_journeys}</Measured>
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      {su ? (
        <section className="card" aria-labelledby="ov-su">
          <h2 id="ov-su">{t("overview.understanding")}</h2>
          <dl className="kv">
            <dt>{t("overview.understanding.what")}</dt>
            <dd>
              <Claim text={su.what_it_sells} />
            </dd>
            <dt>{t("overview.understanding.positioning")}</dt>
            <dd>
              <Claim text={su.positioning} />
            </dd>
            <dt>{t("overview.understanding.price")}</dt>
            <dd>
              <Claim text={su.price_positioning} />
            </dd>
            <dt>{t("overview.understanding.value")}</dt>
            <dd>
              <Claim text={su.core_value_proposition} />
            </dd>
            <dt>{t("overview.understanding.objections")}</dt>
            <dd>
              <ul className="plain stack" style={{ gap: 4 }}>
                {su.likely_objections.map((o, i) => (
                  <li key={i}>
                    <Claim text={o} />
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </section>
      ) : null}
      <CostPanel />
    </div>
  );
}
