"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { artifactUrl } from "@/lib/client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import type { Evidence } from "@/lib/types";
import { Claim } from "./Claim";
import { useReport } from "./ReportContext";

/**
 * CSS-ширина, у якій записано region: зі шляху `…/<w>x<h>/…` (так її пише захоплення; знімки можуть бути 2x і fullpage,
 * тож масштаб = naturalWidth / cssW і однаковий по обох осях), інакше з measurement.
 */
function cssWidth(ev: Evidence): number | null {
  const m = /(?:^|\/)(\d{3,5})x(\d{3,5})(?:\/|$)/.exec(ev.screenshot_reference ?? "");
  if (m) return Number(m[1]);
  const w = ev.measurement["viewport_width"];
  return typeof w === "number" ? w : null;
}

export function EvidenceLightbox({ evidence, onClose }: { evidence: Evidence | null; onClose: () => void }) {
  const { auditId, artifactsDeleted } = useReport();
  const { t } = usePrefs();
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  useEffect(() => {
    setState("loading");
    setNatural(null);
  }, [evidence?.id]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      const f = dialogRef.current?.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])");
      if (!f || f.length === 0) return;
      const first = f[0] as HTMLElement, last = f[f.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const ref = evidence?.screenshot_reference ?? null;
  const isImage = !!ref && /\.(png|jpe?g|webp)$/i.test(ref);
  const unavailable = !evidence || !ref || !isImage || artifactsDeleted || state === "error";
  const cssW = evidence ? cssWidth(evidence) ?? natural?.w ?? null : null;
  const scale = natural && cssW ? natural.w / cssW : null;
  const region = evidence?.region ?? null;

  return (
    <div className="lightbox-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="lightbox-backdrop">
      <div ref={dialogRef} className="lightbox" role="dialog" aria-modal="true" aria-labelledby="lb-title" onKeyDown={onKey} data-testid="lightbox" data-evidence-id={evidence?.id ?? ""} data-state={unavailable ? "unavailable" : state}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="lb-title" style={{ margin: 0 }}>
            {t("lightbox.title")}
          </h2>
          <button ref={closeRef} type="button" className="btn" onClick={onClose} data-testid="lightbox-close">
            {t("lightbox.close")}
          </button>
        </div>
        {evidence && (
          <div className="stack" style={{ gap: 6 }}>
            <Claim text={evidence.description} />
            <div className="small muted row">
              <span className="mono">{evidence.page_path}</span>
              {evidence.viewport && <span className="chip">{t(`evidence.viewport.${evidence.viewport}` as Key)}</span>}
              {evidence.selector && <span className="mono">{evidence.selector}</span>}
            </div>
          </div>
        )}
        {unavailable ? (
          <p className="callout callout-warn" role="alert" data-testid="lightbox-error">
            {ref && !isImage ? (
              <>
                {t("lightbox.not_image")} <span className="mono">{ref}</span>
              </>
            ) : (
              t("lightbox.error")
            )}
          </p>
        ) : (
          <>
            {state === "loading" && (
              <p className="muted" role="status" data-testid="lightbox-loading">
                {t("lightbox.loading")}
              </p>
            )}
            <div className="shot" data-testid="shot" style={state === "loading" ? { minHeight: 120 } : undefined}>
              
              <img
                src={artifactUrl(auditId, ref ?? "")}
                alt={region ? t("lightbox.alt", { path: evidence?.page_path ?? "" }) : t("lightbox.alt_noregion", { path: evidence?.page_path ?? "" })}
                onLoad={(e) => {
                  setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                  setState("loaded");
                }}
                onError={() => setState("error")}
              />
              {state === "loaded" && region && natural && cssW && scale && (
                <div
                  className="region"
                  data-testid="region"
                  data-region={`${region.x},${region.y},${region.w},${region.h}`}
                  style={{ left: `${(region.x / cssW) * 100}%`, top: `${((region.y * scale) / natural.h) * 100}%`, width: `${(region.w / cssW) * 100}%`, height: `${((region.h * scale) / natural.h) * 100}%` }}
                />
              )}
            </div>
            <p className="small muted">{region ? t("lightbox.region") : t("lightbox.no_region")}</p>
          </>
        )}
      </div>
    </div>
  );
}
