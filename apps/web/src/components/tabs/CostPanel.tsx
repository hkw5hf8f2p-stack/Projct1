"use client";
import { usePrefs } from "@/lib/prefs";
import { Measured } from "../Claim";
import { useReport } from "../ReportContext";

/** E4/G0-24: токени — OBSERVED; $ лише з датою прайсу з контракту (`budget.cost.price_date`), інакше суму не показуємо */
export function CostPanel() {
  const { report } = useReport();
  const { t } = usePrefs();
  const b = report.budget;
  const limited = Object.values(report.audit.stage_status).some((s) => s?.status === "budget_limited");
  return (
    <section className="card" aria-labelledby="cost-h" data-testid="cost-panel">
      <h2 id="cost-h">{t("cost.title")}</h2>
      {limited && (
        <p className="callout callout-warn" role="status" data-testid="budget-limited">
          {t("cost.budget_limited")}
        </p>
      )}
      <ul className="plain stack" style={{ gap: 6 }}>
        <li>
          <Measured cls="OBSERVED" label={t("cost.tokens_used")}>
            {b.used_tokens}
          </Measured>
        </li>
        <li>
          <Measured cls="OBSERVED" label={t("cost.tokens_max")}>
            {b.max_audit_tokens}
          </Measured>
        </li>
        <li>
          <Measured cls="OBSERVED" label={t("cost.tokens_billed")}>
            {b.billed_tokens}
          </Measured>
        </li>
        <li>
          <Measured cls="OBSERVED" label={t("cost.tokens_cache")}>
            {b.cache_read_tokens}
          </Measured>
        </li>
        <li>
          <Measured cls="OBSERVED" label={t("cost.calls")}>
            {b.llm_calls}
          </Measured>
        </li>
        <li data-testid="cost-money">
          {b.cost && b.cost.price_date ? (
            <Measured cls="OBSERVED" label={t("cost.money")}>
              ${b.cost.amount} {t("cost.money_as_of", { date: b.cost.price_date, source: b.cost.price_source })}
            </Measured>
          ) : (
            <span className="muted small">{t("cost.money_none")}</span>
          )}
        </li>
      </ul>
      <p className="small muted">{t("cost.observed_note")}</p>
    </section>
  );
}
