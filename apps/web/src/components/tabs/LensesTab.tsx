"use client";
import { usePrefs } from "@/lib/prefs";
import { Claim } from "../Claim";
import { Disclaimer } from "../Disclaimer";
import { useReport } from "../ReportContext";

/** Лінзи — синтетичні перспективи, не сегменти й не люди; жодних відсотків поруч (SPEC §28, G0-9) */
export function LensesTab() {
  const { report } = useReport();
  const { t } = usePrefs();
  const lensesObj = report.lenses;
  const noLlm = report.audit.llm_mode === "none";
  const stage = report.audit.stage_status["lenses"];
  const items = lensesObj?.items ?? [];
  const lensById = new Map(items.map((l) => [l.id, l]));
  const partial = stage?.status === "failed" || stage?.status === "budget_limited";
  return (
    <div className="stack" data-testid="lenses">
      <h2>{t("lenses.title")}</h2>
      <Disclaimer id="lenses_not_population_shares" title />
      {noLlm && <Disclaimer id="no_llm_mode" tone="warn" />}
      {items.length === 0 ? (
        <section className="card" data-testid="lenses-empty" role="status">
          <h3>{t("lenses.empty.title")}</h3>
          <p className="muted">{noLlm ? t("lenses.no_llm") : t("lenses.empty.detail")}</p>
          {stage?.reason && (
            <p className="small muted">
              {t("progress.reason")}: <span className="mono">{stage.reason}</span>
            </p>
          )}
        </section>
      ) : (
        <>
          {partial && (
            <p className="callout callout-warn" role="status" data-testid="lenses-partial">
              {t("lenses.partial")}
            </p>
          )}
          <ul className="plain grid-2" aria-label={t("lenses.title")}>
            {items.map((l) => (
              <li key={l.id} className="card" data-testid="lens" data-lens-id={l.id} style={{ marginBottom: 0 }}>
                <h3>
                  <Claim text={l.name} />
                </h3>
                <Claim text={l.description} />
                {l.poles.length > 0 && (
                  <p className="small muted" style={{ marginTop: 8 }}>
                    {t("lenses.poles")}: <span className="mono">{l.poles.join(", ")}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
          {report.coverage.pole_unmet.length > 0 && (
            <section className="card" data-testid="pole-unmet">
              <h3>{t("lenses.pole_unmet")}</h3>
              <ul className="plain stack" style={{ gap: 4 }}>
                {report.coverage.pole_unmet.map((p) => {
                  const near = p.nearest_lens_id ? lensById.get(p.nearest_lens_id) : null;
                  return (
                    <li key={p.pole}>
                      <span className="chip mono">{p.pole}</span> {near ? <>{t("lenses.nearest")}: <Claim text={near.name} inline /></> : t("lenses.none_nearest")}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
