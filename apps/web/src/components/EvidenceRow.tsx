"use client";
import { useState } from "react";
import { artifactUrl } from "@/lib/client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import type { Evidence } from "@/lib/types";
import { Claim, Measured } from "./Claim";
import { useReport } from "./ReportContext";

export function Thumb({ ev }: { ev: Evidence }) {
  const { auditId, artifactsDeleted, openEvidence } = useReport();
  const { t } = usePrefs();
  const [failed, setFailed] = useState(false);
  const ref = ev.screenshot_reference;
  if (!ref || artifactsDeleted || failed) {
    return (
      <span className="thumb thumb-empty" data-testid="thumb-empty">
        {!ref ? t("evidence.no_screenshot") : t("lightbox.error").split(".")[0]}
      </span>
    );
  }
  return (
    <button type="button" className="thumb" tabIndex={-1} aria-hidden="true" onClick={() => openEvidence(ev.id)} data-testid="thumb">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={artifactUrl(auditId, ref)} alt="" loading="lazy" onError={() => setFailed(true)} />
    </button>
  );
}

export function EvidenceRow({ ev }: { ev: Evidence }) {
  const { openEvidence } = useReport();
  const { t } = usePrefs();
  const canOpen = !!ev.screenshot_reference;
  return (
    <li className="ev" data-testid="evidence-row" data-evidence-id={ev.id} data-polarity={ev.polarity} data-class={ev.source_class}>
      <Thumb ev={ev} />
      <div className="stack" style={{ gap: 6 }}>
        <div className="row small">
          <span className="chip">{t(`evidence.polarity.${ev.polarity}` as Key)}</span>
          {ev.tier && (
            <span className="chip" title={t("evidence.tier")}>
              {ev.tier}
            </span>
          )}
          {ev.viewport && <span className="chip">{t(`evidence.viewport.${ev.viewport}` as Key)}</span>}
          <span className="mono">{ev.page_path}</span>
        </div>
        <Claim text={ev.description} />
        {ev.excerpt && (
          <blockquote className="quote small" data-claim="" data-quote="" data-class="OBSERVED">
            <span className="badge badge-OBSERVED" data-class-badge="OBSERVED" title={t("class.OBSERVED.desc")}>
              OBSERVED
            </span>{" "}
            <span className="muted">{t("evidence.quote")}: </span>
            <q>{ev.excerpt}</q>
          </blockquote>
        )}
        <div className="small muted row">
          {ev.selector && (
            <span>
              {t("evidence.selector")}: <span className="mono">{ev.selector}</span>
            </span>
          )}
          {ev.level && <span>{t(`evidence.level.${ev.level}` as Key)}</span>}
          {ev.session_id && (
            <span>
              {t("evidence.session")}: <span className="mono">{ev.session_id}</span>
            </span>
          )}
          {ev.lens_id && (
            <span>
              {t("evidence.lens")}: <span className="mono">{ev.lens_id}</span>
            </span>
          )}
          {ev.task_id && (
            <span>
              {t("evidence.task")}: <span className="mono">{ev.task_id}</span>
            </span>
          )}
        </div>
        {ev.capture_complete === false && (
          <p className="small callout callout-warn" style={{ margin: 0 }}>
            {t("evidence.incomplete")}: <span className="mono">{ev.incomplete_reasons.join(", ")}</span>
          </p>
        )}
        <div className="row small">
          {canOpen ? (
            <button type="button" className="link-btn" onClick={() => openEvidence(ev.id)} data-testid="open-evidence">
              {t("evidence.open")}
              <span className="sr-only"> ({ev.page_path})</span>
            </button>
          ) : (
            <span className="muted">{t("evidence.no_screenshot")}</span>
          )}
          <Measured cls={ev.source_class} label={t("evidence.artifact")}>
            <span className="mono">{ev.artifact_reference}</span>
          </Measured>
        </div>
      </div>
    </li>
  );
}
