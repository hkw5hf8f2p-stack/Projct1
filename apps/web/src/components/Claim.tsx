"use client";
import { ClassBadge } from "./Badges";
import { useReport } from "./ReportContext";
import { renderClaim } from "@/lib/render";
import { usePrefs } from "@/lib/prefs";
import type { SourceClass, TemplatedText } from "@/lib/types";

/**
 * Твердження звіту = мітка класу + текст із контракту. Єдиний спосіб показати TemplatedText у UI.
 * `data-claim` — гачок для автоматичного підрахунку «тверджень без мітки» (критерій S5 п.2).
 */
export function Claim({ text, inline = false, className = "" }: { text: TemplatedText; inline?: boolean; className?: string }) {
  const { report } = useReport();
  const { t } = usePrefs();
  const rendered = renderClaim(text, report);
  const pending = text.guard.status === "pending";
  return (
    <span className={`${inline ? "claim-inline" : "claim"} ${className}`} data-claim="" data-class={text.source_class} data-origin={text.origin} data-guard={text.guard.status} lang={text.lang}>
      <ClassBadge cls={text.source_class} />
      {rendered === null ? (
        <span className="claim-warn" data-render-error="">
          {t("report.text_unavailable")}
        </span>
      ) : (
        <span data-claim-text="">{rendered}</span>
      )}
      {pending && (
        <>
          {" "}
          <span className="chip small" data-guard-pending="">
            {t("report.guard.pending")}
          </span>
        </>
      )}
    </span>
  );
}

/** Твердження про виміряне значення інструмента/пайплайна (не TemplatedText): клас — завжди явний */
export function Measured({ cls, label, children, quote = false }: { cls: SourceClass; label?: string; children: React.ReactNode; quote?: boolean }) {
  return (
    <span className="claim-inline" data-claim="" data-class={cls} {...(quote ? { "data-quote": "" } : {})}>
      <ClassBadge cls={cls} />
      {label ? <span className="muted"> {label}: </span> : " "}
      <span data-claim-text="">{children}</span>
    </span>
  );
}
