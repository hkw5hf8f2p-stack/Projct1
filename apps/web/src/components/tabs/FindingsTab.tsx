"use client";
import { useMemo, useState } from "react";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import { useUrlParams } from "@/lib/urlstate";
import type { Finding, Positive } from "@/lib/types";
import { ConfidenceBadge } from "../Badges";
import { Claim } from "../Claim";
import { Disclaimer } from "../Disclaimer";
import { EvidenceRow } from "../EvidenceRow";
import { FindingCard } from "../FindingCard";
import { useReport } from "../ReportContext";

const FILTERS = ["device", "page", "confidence", "category", "lens", "task"] as const;
type FilterId = (typeof FILTERS)[number];
const CONFS = ["VERIFIED", "STRONG_HYPOTHESIS", "HYPOTHESIS"] as const;

function PositiveCard({ p }: { p: Positive }) {
  const { report } = useReport();
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  const evs = p.evidence_ids.map((id) => report.evidence.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <li className="finding" data-testid="positive" data-positive-id={p.id}>
      <div className="finding-head">
        <ConfidenceBadge level={p.confidence} />
        <span className="chip">{t(`cat.${p.category}` as Key)}</span>
      </div>
      <h3>
        <Claim text={p.title} />
      </h3>
      {p.detail && <Claim text={p.detail} />}
      <p className="small muted mono" style={{ marginTop: 8 }}>
        {p.pages.map((x) => x.path).join(" · ")}
      </p>
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t("findings.collapse") : t("findings.expand")}
      </button>
      {open && (
        <ul className="plain">
          {evs.map((e) => (
            <EvidenceRow key={e.id} ev={e} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FindingsTab({ focusId }: { focusId: string | null }) {
  const { report } = useReport();
  const { t } = usePrefs();
  const [params, setParams] = useUrlParams();
  const noLlm = report.audit.llm_mode === "none";
  const sort = params.get("sort") === "priority_asc" ? "priority_asc" : "priority_desc";
  const val = (k: FilterId): string => params.get(k) ?? "";

  const evById = useMemo(() => new Map(report.evidence.map((e) => [e.id, e])), [report.evidence]);
  const opts = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs)].sort();
    const fs = report.findings;
    return {
      device: uniq(fs.flatMap((f) => f.evidence_ids.map((id) => evById.get(id)?.viewport ?? ""))).filter(Boolean),
      page: uniq(fs.flatMap((f) => f.pages.map((p) => p.path))),
      confidence: CONFS.filter((c) => fs.some((f) => f.confidence.level === c)) as string[],
      category: uniq(fs.map((f) => f.category)),
      lens: uniq(fs.flatMap((f) => f.affected_lens_ids)),
      task: uniq(fs.flatMap((f) => f.affected_task_ids)),
    };
  }, [report.findings, evById]);

  const matches = (f: Finding): boolean =>
    (!val("device") || f.evidence_ids.some((id) => evById.get(id)?.viewport === val("device"))) &&
    (!val("page") || f.pages.some((p) => p.path === val("page"))) &&
    (!val("confidence") || f.confidence.level === val("confidence")) &&
    (!val("category") || f.category === val("category")) &&
    (!val("lens") || f.affected_lens_ids.includes(val("lens"))) &&
    (!val("task") || f.affected_task_ids.includes(val("task")));

  const shown = report.findings
    .filter(matches)
    .map((f, i) => ({ f, i }))
    // Порядок — rank із контракту (смуги впевненості, DEV-76), не сире priority.value: інакше гіпотеза з вищим числом обганяє VERIFIED.
    .sort((a, b) => (sort === "priority_desc" ? a.f.rank - b.f.rank : b.f.rank - a.f.rank) || a.i - b.i)
    .map((x) => x.f);
  const anyFilter = FILTERS.some((k) => val(k));
  const label = (k: FilterId, v: string): string => {
    if (k === "device") return t(`findings.device.${v}` as Key);
    if (k === "category") return t(`cat.${v}` as Key);
    if (k === "confidence") return t(`conf.${v}` as Key);
    return v;
  };

  return (
    <div className="stack" data-testid="findings">
      <h2>{t("findings.title")}</h2>
      <Disclaimer id="priority_is_ranking_index" title />
      <Disclaimer id="no_conversion_prediction" />
      {noLlm && <Disclaimer id="no_llm_mode" tone="warn" />}

      {report.findings.length === 0 ? (
        <p className="callout callout-ok" role="status" data-testid="findings-empty">
          <strong>{t("overview.no_problem")}</strong>
          {t("overview.no_problem_detail")}
        </p>
      ) : (
        <>
          <form className="card" onSubmit={(e) => e.preventDefault()} aria-label={t("findings.filters")}>
            <div className="filters">
              <div className="field">
                <label htmlFor="f-sort">{t("findings.sort")}</label>
                <select id="f-sort" value={sort} onChange={(e) => setParams({ sort: e.target.value === "priority_desc" ? null : e.target.value })} data-testid="sort">
                  <option value="priority_desc">{t("findings.sort.priority_desc")}</option>
                  <option value="priority_asc">{t("findings.sort.priority_asc")}</option>
                </select>
              </div>
              {FILTERS.map((k) => {
                const list = opts[k];
                const off = list.length === 0;
                return (
                  <div className="field" key={k}>
                    <label htmlFor={`f-${k}`}>{t(`findings.filter.${k}` as Key)}</label>
                    <select id={`f-${k}`} value={val(k)} disabled={off} onChange={(e) => setParams({ [k]: e.target.value || null })} data-testid={`filter-${k}`}>
                      <option value="">{off ? t("findings.filter.unavailable") : t("findings.filter.all")}</option>
                      {list.map((v) => (
                        <option key={v} value={v}>
                          {label(k, v)}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <span role="status" data-testid="findings-count">
                {t("findings.showing", { shown: shown.length, total: report.findings.length })}
              </span>
              {anyFilter && (
                <button type="button" className="btn" onClick={() => setParams(Object.fromEntries(FILTERS.map((k) => [k, null])))} data-testid="filters-reset">
                  {t("findings.filter.reset")}
                </button>
              )}
            </div>
          </form>
          {shown.length === 0 ? (
            <p className="callout callout-info" role="status" data-testid="findings-none">
              {t("findings.none")}
            </p>
          ) : (
            <div data-testid="findings-list">
              {shown.map((f) => (
                <FindingCard key={f.id} f={f} highlight={f.id === focusId} />
              ))}
            </div>
          )}
        </>
      )}

      <section aria-labelledby="pos-h" data-testid="positives">
        <h2 id="pos-h">{t("findings.positives")}</h2>
        {report.positive_findings.length === 0 ? (
          <p className="muted">{t("findings.positives.empty")}</p>
        ) : (
          <ul className="plain">
            {report.positive_findings.map((p) => (
              <PositiveCard key={p.id} p={p} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
