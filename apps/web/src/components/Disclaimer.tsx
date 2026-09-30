"use client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";

export type DisclaimerId =
  | "lenses_not_population_shares" | "automated_a11y_not_wcag_audit" | "synthetic_single_model_correlated"
  | "priority_is_ranking_index" | "no_conversion_prediction" | "no_llm_mode";

/** Дисклеймер із каталогу (тексти — з контракту; дрейф ловить тест). `data-disclaimer` — гачок для перевірки «100 % потрібних екранів». */
export function Disclaimer({ id, tone = "info", title = false }: { id: DisclaimerId; tone?: "info" | "warn"; title?: boolean }) {
  const { t } = usePrefs();
  return (
    <p className={`callout callout-${tone}`} role="note" data-disclaimer={id}>
      {title && <strong>{t("disc.title")}</strong>}
      {t(`disc.${id}` as Key)}
    </p>
  );
}

/** Коротке застереження G0-25 поряд із кожним «N of M synthetic …» (плюс повний текст у title) */
export function SyntheticCaveat() {
  const { t } = usePrefs();
  return (
    <span className="small muted" data-synthetic-caveat="" title={t("disc.synthetic_single_model_correlated")}>
      {" "}
      {t("disc.synthetic_short")}
    </span>
  );
}
