"use client";
import { useState } from "react";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import type { Finding } from "@/lib/types";
import { ConfidenceBadge, PriorityLabel } from "./Badges";
import { Claim } from "./Claim";
import { EvidenceRow } from "./EvidenceRow";
import { useReport } from "./ReportContext";
import { SyntheticCountView } from "./SyntheticCountView";

export function FindingCard({ f, defaultOpen = false, highlight = false }: { f: Finding; defaultOpen?: boolean; highlight?: boolean }) {
  const { report } = useReport();
  const { t } = usePrefs();
  const [open, setOpen] = useState(defaultOpen);
  const evById = new Map(report.evidence.map((e) => [e.id, e]));
  const evs = f.evidence_ids.map((id) => evById.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const syn = f.synthetic;
  return (
    <article id={`finding-${f.id}`} tabIndex={-1} className="finding" data-testid="finding" data-finding-id={f.id} data-confidence={f.confidence.level} data-priority={f.priority.value} data-category={f.category} style={highlight ? { outline: "3px solid var(--focus)" } : undefined} aria-labelledby={`finding-${f.id}-h`}>
      <div className="finding-head">
        <span className="chip mono" aria-label={`rank ${f.rank}`}>
          #{f.rank}
        </span>
        <ConfidenceBadge level={f.confidence.level} />
        <PriorityLabel value={f.priority.value} />
        <span className="chip">{t(`cat.${f.category}` as Key)}</span>
        <span className="chip small">{t(`journey.stage.${f.funnel.stage}` as Key)}</span>
      </div>
      <h3 id={`finding-${f.id}-h`}>
        <Claim text={f.title} />
      </h3>
      <div className="section-label">{t("findings.problem")}</div>
      <Claim text={f.problem} />
      {f.why_it_matters && (
        <>
          <div className="section-label">{t("findings.why")}</div>
          <Claim text={f.why_it_matters} />
        </>
      )}
      {f.recommendation ? (
        <>
          <div className="section-label">{t("findings.change")}</div>
          <Claim text={f.recommendation.recommended_change} />
          <div className="section-label">{t("findings.validate")}</div>
          <Claim text={f.recommendation.how_to_validate} />
        </>
      ) : (
        <p className="small muted">{t("findings.no_recommendation")}</p>
      )}
      {f.confidence.contradiction && (
        <p className="callout callout-warn small" style={{ marginTop: 10 }} data-testid="contradiction">
          {t("findings.contradiction")}
        </p>
      )}
      <div className="row small muted" style={{ marginTop: 10 }}>
        <span>{t("findings.pages_count", { n: f.page_count })}</span>
        <span className="mono">{f.pages.map((p) => p.path).join(" · ")}</span>
        <span>{t("findings.evidence_count", { n: f.evidence_ids.length })}</span>
      </div>
      <div className="disclosure">
        <button type="button" className="link-btn" aria-expanded={open} aria-controls={`finding-${f.id}-more`} onClick={() => setOpen(!open)} data-testid="toggle-details">
          {open ? t("findings.collapse") : t("findings.expand")}
        </button>
        {open && (
          <div id={`finding-${f.id}-more`} className="stack" style={{ marginTop: 10 }} data-testid="finding-details">
            <div>
              <div className="section-label">{t("findings.evidence")}</div>
              <ul className="plain">
                {evs.map((e) => (
                  <EvidenceRow key={e.id} ev={e} />
                ))}
              </ul>
            </div>
            <div>
              <div className="section-label">{t("findings.synthetic")}</div>
              <ul className="plain stack" style={{ gap: 6 }}>
                {syn.lens_coverage && (
                  <li>
                    <SyntheticCountView count={syn.lens_coverage} label="findings.synthetic.lens" />
                  </li>
                )}
                {syn.session_frequency && (
                  <li>
                    <SyntheticCountView count={syn.session_frequency} label="findings.synthetic.session" />
                  </li>
                )}
                {syn.task_coverage && (
                  <li>
                    <SyntheticCountView count={syn.task_coverage} label="findings.synthetic.task" />
                  </li>
                )}
              </ul>
              <p className="small muted">{syn.in_priority ? t("findings.synthetic.in_priority") : t("findings.synthetic.not_in_priority")}</p>
            </div>
            <div>
              <div className="section-label">{t("priority.components")}</div>
              <dl className="kv small">
                {f.priority.components.map((c) => (
                  <div key={c.name} style={{ display: "contents" }}>
                    <dt>{t(`priority.component.${c.name}` as Key)}</dt>
                    <dd>{c.applicable && c.value !== null ? `${t("priority.value")} ${c.value.toFixed(2)} · ${t("priority.weight")} ${c.effective_weight.toFixed(2)}` : t("priority.na")}</dd>
                  </div>
                ))}
                {f.priority.cap && (
                  <div style={{ display: "contents" }}>
                    <dt>{t("priority.cap")}</dt>
                    <dd>
                      {t("priority.uncapped")}: {f.priority.uncapped} → {f.priority.cap.value}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
