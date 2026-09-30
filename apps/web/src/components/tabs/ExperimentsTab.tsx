"use client";
import { usePrefs } from "@/lib/prefs";

/** Заглушка до S6 (варіанти й порівняння). Дисклеймер §31 присутній уже зараз, щоб майбутній вміст не з'явився без нього. */
export function ExperimentsTab() {
  const { t } = usePrefs();
  return (
    <div className="stack" data-testid="experiments">
      <h2>{t("experiments.title")}</h2>
      <p className="callout callout-warn" role="note" data-disclaimer="synthetic_preference_not_uplift">
        {t("experiments.disclaimer")}
      </p>
      <section className="card" data-testid="experiments-stub">
        <h3>{t("experiments.stub")}</h3>
        <p className="muted">{t("experiments.explain")}</p>
      </section>
    </div>
  );
}
