"use client";
import { formatParam } from "@/lib/render";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import type { Finding } from "@/lib/types";
import { Measured } from "./Claim";
import { SyntheticCaveat } from "./Disclaimer";
import { useReport } from "./ReportContext";

type SC = NonNullable<Finding["synthetic"]["lens_coverage"]>;

/** «N of M synthetic …» — текст формує formatParam контракту; ЗАВЖДИ із застереженням G0-25 поряд і повним у title */
export function SyntheticCountView({ count, label }: { count: SC; label: Key }) {
  const { report } = useReport();
  const { t } = usePrefs();
  const lang = report.audit.language;
  const s = formatParam({ v: count }, { ptr: "/v", format: "n_of_m" }, lang);
  const text = typeof s === "string" ? s : t("report.text_unavailable");
  return (
    <span data-synthetic-count="" title={t("disc.synthetic_single_model_correlated")}>
      <Measured cls="SYNTHETIC" label={t(label)}>
        {text}
      </Measured>
      <SyntheticCaveat />
    </span>
  );
}
