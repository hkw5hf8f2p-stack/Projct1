"use client";
import { usePrefs } from "@/lib/prefs";
import type { Key } from "@/lib/messages";
import type { Confidence, SourceClass } from "@/lib/types";

/** Мітка класу доказу — обов'язкова біля КОЖНОГО твердження. Не лише колір: слово + стиль рамки. */
export function ClassBadge({ cls }: { cls: SourceClass }) {
  const { t } = usePrefs();
  return (
    <span className={`badge badge-${cls}`} data-class-badge={cls} title={t(`class.${cls}.desc` as Key)} aria-label={`${t("class.label")}: ${cls}. ${t(`class.${cls}.desc` as Key)}`}>
      {cls}
    </span>
  );
}

const GLYPH: Record<Confidence, string> = { VERIFIED: "✔", STRONG_HYPOTHESIS: "◐", HYPOTHESIS: "?" };
export function ConfidenceBadge({ level }: { level: Confidence }) {
  const { t } = usePrefs();
  return (
    <span className={`conf conf-${level}`} data-confidence={level} title={t(`conf.${level}.desc` as Key)} aria-label={`${t("conf.label")}: ${t(`conf.${level}` as Key)}. ${t(`conf.${level}.desc` as Key)}`}>
      <span aria-hidden="true">{GLYPH[level]}</span>
      {t(`conf.${level}` as Key)}
    </span>
  );
}

/** «Priority NN/100» — значення з контракту (priority.value), без «%»; це індекс, не прогноз */
export function PriorityLabel({ value }: { value: number }) {
  const { t } = usePrefs();
  return (
    <span className="prio" data-priority={value} title={t("priority.hint")}>
      {t("priority.label", { n: value })}
    </span>
  );
}
