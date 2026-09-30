"use client";
import { useState } from "react";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { EvidenceRow } from "../EvidenceRow";
import { useReport } from "../ReportContext";

const CLASSES = ["OBSERVED", "BENCHMARKED", "INFERRED", "SYNTHETIC"] as const;
const POLARITIES = ["problem", "positive", "counter"] as const;

export function EvidenceTab() {
  const { report } = useReport();
  const { t } = usePrefs();
  const [cls, setCls] = useState("");
  const [pol, setPol] = useState("");
  const all = report.evidence;
  const shown = all.filter((e) => (!cls || e.source_class === cls) && (!pol || e.polarity === pol));
  return (
    <div className="stack" data-testid="evidence">
      <h2>{t("evidence.title")}</h2>
      <p className="muted">{t("evidence.lead")}</p>
      {all.length === 0 ? (
        <p className="callout callout-info" role="status" data-testid="evidence-empty">
          {t("evidence.empty")}
        </p>
      ) : (
        <>
          <form className="card" onSubmit={(e) => e.preventDefault()}>
            <div className="filters">
              <div className="field">
                <label htmlFor="ev-class">{t("evidence.filter.class")}</label>
                <select id="ev-class" value={cls} onChange={(e) => setCls(e.target.value)} data-testid="ev-filter-class">
                  <option value="">{t("findings.filter.all")}</option>
                  {CLASSES.filter((c) => all.some((e) => e.source_class === c)).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ev-pol">{t("evidence.filter.polarity")}</label>
                <select id="ev-pol" value={pol} onChange={(e) => setPol(e.target.value)} data-testid="ev-filter-polarity">
                  <option value="">{t("findings.filter.all")}</option>
                  {POLARITIES.filter((p) => all.some((e) => e.polarity === p)).map((p) => (
                    <option key={p} value={p}>
                      {t(`evidence.polarity.${p}` as Key)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p role="status" style={{ marginTop: 10 }} data-testid="evidence-count">
              {t("evidence.showing", { shown: shown.length, total: all.length })}
            </p>
          </form>
          {shown.length === 0 ? (
            <p className="callout callout-info" role="status">
              {t("evidence.none_match")}
            </p>
          ) : (
            <ul className="plain card">
              {shown.map((e) => (
                <EvidenceRow key={e.id} ev={e} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
