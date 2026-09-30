"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ensureArtifactToken, getToken } from "@/lib/client";
import { useUrlParams } from "@/lib/urlstate";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import type { Report } from "@/lib/types";
import { ClassBadge } from "./Badges";
import { Claim } from "./Claim";
import { ReportContext } from "./ReportContext";
import { EvidenceLightbox } from "./EvidenceLightbox";
import { OverviewTab } from "./tabs/OverviewTab";
import { LensesTab } from "./tabs/LensesTab";
import { JourneyTab } from "./tabs/JourneyTab";
import { FindingsTab } from "./tabs/FindingsTab";
import { TechnicalTab } from "./tabs/TechnicalTab";
import { ExperimentsTab } from "./tabs/ExperimentsTab";
import { EvidenceTab } from "./tabs/EvidenceTab";

export const TABS = ["overview", "lenses", "journey", "findings", "technical", "experiments", "evidence"] as const;
export type TabId = (typeof TABS)[number];
const isTab = (x: string | null): x is TabId => x !== null && (TABS as readonly string[]).includes(x);
const CLASSES = ["OBSERVED", "BENCHMARKED", "INFERRED", "SYNTHETIC"] as const;

export function ReportShell({ report, auditId, artifactsDeleted }: { report: Report; auditId: string; artifactsDeleted: boolean }) {
  const { t } = usePrefs();
  const [params, setParams] = useUrlParams();
  const [focusFinding, setFocusFinding] = useState<string | null>(null);
  const q = params.get("tab");
  const tab: TabId = isTab(q) ? q : "overview";
  const evidenceId = params.get("evidence");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // DEV-80: при ACCESS_TOKEN скриншоти показуються лише після видачі короткоживучого токена артефактів (інакше `<img>` дав би 401 і назавжди failed)
  const [artReady, setArtReady] = useState(() => !getToken());
  useEffect(() => {
    if (!getToken()) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const ttl = await ensureArtifactToken(auditId);
      if (stop) return;
      setArtReady(true);
      timer = setTimeout(() => void tick(), ttl > 60_000 ? ttl - 60_000 : 30_000); // оновлення за хвилину до закінчення
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [auditId]);

  const setTab = useCallback((id: TabId) => setParams({ tab: id === "overview" ? null : id }), [setParams]);
  const ctx = useMemo(
    () => ({
      report,
      auditId,
      artifactsDeleted,
      openEvidence: (id: string) => setParams({ evidence: id }),
      openFinding: (id: string) => {
        setFocusFinding(id);
        setParams({ tab: "findings", device: null, page: null, confidence: null, category: null, lens: null, task: null });
      },
    }),
    [report, auditId, artifactsDeleted, setParams],
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    if (n >= 0) {
      e.preventDefault();
      const id = TABS[n] as TabId;
      setTab(id);
      tabRefs.current[id]?.focus();
    }
  };

  // тимчасова підсвітка знахідки, на яку перейшли з Overview/Journey
  useEffect(() => {
    if (!focusFinding || tab !== "findings") return;
    const el = document.getElementById(`finding-${focusFinding}`);
    el?.scrollIntoView({ block: "start" });
    (el as HTMLElement | null)?.focus({ preventScroll: true });
  }, [focusFinding, tab]);

  const { audit } = report;
  const partial = audit.banners.some((b) => b.code === "stage_failed" || b.code === "budget_limited");
  const ev = evidenceId ? report.evidence.find((e) => e.id === evidenceId) ?? null : null;

  if (!artReady) return <p className="muted small" role="status" data-testid="artifact-token-wait">…</p>;
  return (
    <ReportContext.Provider value={ctx}>
      <div data-testid="report" data-llm-mode={audit.llm_mode} data-provenance={report.provenance.kind}>
        <section className="card" aria-labelledby="report-h">
          <h1 id="report-h" style={{ marginBottom: 4 }}>
            {audit.domain}
          </h1>
          <p className="muted small" style={{ marginBottom: 6 }}>
            {t("report.site")}: <span className="mono">{audit.normalized_url}</span> · {t("report.generated")}: {report.generated_at.slice(0, 16).replace("T", " ")} UTC · {t("report.language")}: {audit.language}
          </p>
          {report.provenance.kind === "example_fixture" && (
            <p className="callout callout-warn small" role="note">
              {t("report.provenance.fixture")}
            </p>
          )}
          <div className="stack" data-testid="banners">
            {audit.banners.map((b, i) => (
              <div key={i} className={`callout ${b.code === "stage_failed" ? "callout-danger" : b.code === "no_llm" || b.code === "example_fixture" || b.code === "replay_not_live" ? "callout-info" : "callout-warn"}`} role="status" data-banner={b.code} style={{ margin: 0 }}>
                <strong>
                  {t(`banner.${b.code}` as Key)}
                  {b.stage ? ` · ${t("banner.stage")}: ${t(`stage.${b.stage}` as Key)}` : ""}
                </strong>
                <Claim text={b.text} />
              </div>
            ))}
          </div>
          {partial && (
            <p className="small muted" style={{ marginTop: 8 }} data-testid="partial-note">
              {t("report.partial")}
            </p>
          )}
        </section>

        <details className="card" open data-testid="class-legend">
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{t("class.legend.title")}</summary>
          <ul className="plain stack" style={{ marginTop: 10 }}>
            {CLASSES.map((c) => (
              <li key={c}>
                <ClassBadge cls={c} /> <span className="small">{t(`class.${c}.desc` as Key)}</span>
              </li>
            ))}
          </ul>
        </details>

        <div role="tablist" aria-label={t("tabs.label")} className="tabs" onKeyDown={onKey}>
          {TABS.map((id) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              role="tab"
              type="button"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className="tab"
              onClick={() => setTab(id)}
              data-testid={`tab-${id}`}
            >
              {t(`tab.${id}` as Key)}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} data-testid={`panel-${tab}`} data-tab={tab}>
          {tab === "overview" && <OverviewTab />}
          {tab === "lenses" && <LensesTab />}
          {tab === "journey" && <JourneyTab />}
          {tab === "findings" && <FindingsTab focusId={focusFinding} />}
          {tab === "technical" && <TechnicalTab />}
          {tab === "experiments" && <ExperimentsTab />}
          {tab === "evidence" && <EvidenceTab />}
        </div>
        {evidenceId && <EvidenceLightbox evidence={ev} onClose={() => setParams({ evidence: null })} />}
      </div>
    </ReportContext.Provider>
  );
}
