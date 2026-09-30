"use client";
import Link from "next/link";
import { LANGS } from "@/lib/messages";
import { usePrefs } from "@/lib/prefs";

export function Header() {
  const { lang, setLang, effectiveTheme, setTheme, t } = usePrefs();
  const dark = effectiveTheme === "dark";
  return (
    <>
      <a href="#main" className="skip-link">
        {t("nav.skip")}
      </a>
      <header className="site-header">
        <Link href="/" className="brand">
          <span aria-hidden="true" className="brand-mark" />
          {t("app.name")}
        </Link>
        <span className="tagline">{t("app.tagline")}</span>
        <div className="header-controls">
          <Link href="/settings/ai" className="btn btn-ghost" data-testid="nav-ai">
            {t("nav.ai")}
          </Link>
          <div role="group" aria-label={t("nav.language")} className="seg">
            {LANGS.map((l) => (
              <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)} data-testid={`lang-${l}`}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? t("theme.switch_to_light") : t("theme.switch_to_dark")} data-testid="theme-toggle">
            <span aria-hidden="true">{dark ? "☀" : "☾"}</span> {dark ? t("theme.light") : t("theme.dark")}
          </button>
        </div>
      </header>
    </>
  );
}
