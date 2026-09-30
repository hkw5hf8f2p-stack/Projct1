"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { translate, type Key, type Lang } from "./messages";

export type Theme = "light" | "dark" | null; // null = системна

interface Prefs {
  lang: Lang;
  theme: Theme;
  effectiveTheme: "light" | "dark";
  setLang: (l: Lang) => void;
  setTheme: (t: "light" | "dark") => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
}
const Ctx = createContext<Prefs | null>(null);

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function PrefsProvider({ initialLang, initialTheme, children }: { initialLang: Lang; initialTheme: Theme; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    setCookie("sl_lang", l);
    document.documentElement.lang = l;
  }, []);
  const setTheme = useCallback((th: "light" | "dark") => {
    setThemeState(th);
    setCookie("sl_theme", th);
    document.documentElement.dataset["theme"] = th;
  }, []);

  const value = useMemo<Prefs>(
    () => ({
      lang,
      theme,
      effectiveTheme: theme ?? (systemDark ? "dark" : "light"),
      setLang,
      setTheme,
      t: (key, vars) => translate(lang, key, vars),
    }),
    [lang, theme, systemDark, setLang, setTheme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): Prefs {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePrefs: немає PrefsProvider");
  return v;
}
