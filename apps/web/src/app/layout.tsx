import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { DEFAULT_LANG, LANGS, type Lang } from "@/lib/messages";
import { PrefsProvider, type Theme } from "@/lib/prefs";
import "./globals.css";

export const metadata: Metadata = { title: "SiteLens", description: "Evidence-backed website conversion diagnostic" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const l = jar.get("sl_lang")?.value;
  const lang: Lang = LANGS.includes(l as Lang) ? (l as Lang) : DEFAULT_LANG;
  const th = jar.get("sl_theme")?.value;
  const theme: Theme = th === "light" || th === "dark" ? th : null;
  return (
    <html lang={lang} {...(theme ? { "data-theme": theme } : {})} suppressHydrationWarning>
      <body>
        <PrefsProvider initialLang={lang} initialTheme={theme}>
          <Header />
          <main id="main" tabIndex={-1} className="page">
            {children}
          </main>
        </PrefsProvider>
      </body>
    </html>
  );
}
