"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SOURCE, createAudit } from "@/lib/client";
import type { Key } from "@/lib/messages";
import { ERROR_CLASSES } from "@/lib/errors";
import { validateUrlInput } from "@/lib/validate";
import { usePrefs } from "@/lib/prefs";
import { TokenPrompt } from "./TokenPrompt";

export function Landing() {
  const { t, lang } = usePrefs();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"quick" | "full">("full");
  const [needToken, setNeedToken] = useState(false);
  const [tokenRejected, setTokenRejected] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const bad = validateUrlInput(url);
    if (bad) {
      setErr(t(bad));
      return;
    }
    setErr(null);
    setBusy(true);
    const r = await createAudit(url.trim(), lang, mode);
    if (r.ok) {
      router.push(`/audit/${encodeURIComponent(r.data.auditId)}`);
      return; // busy лишається true до переходу
    }
    setBusy(false);
    if (r.http === 401) {
      setTokenRejected(needToken);
      setNeedToken(true);
      return;
    }
    if (r.cls === "network") setErr(t("landing.err.network"));
    else if (r.cls === "rate_limited") setErr(t("landing.err.rate_limited"));
    else if ((ERROR_CLASSES as readonly string[]).includes(r.cls)) setErr(`${t(`error.${r.cls}` as Key)}${r.message && r.cls === "invalid_url" ? ` (${r.message})` : ""}`);
    else if (r.cls === "bad_request") setErr(t("landing.err.bad_request"));
    else setErr(t("landing.err.internal"));
  };

  return (
    <div className="stack" style={{ maxWidth: 720, margin: "24px auto 0" }}>
      <h1>{t("landing.title")}</h1>
      <p className="muted">{t("landing.lead")}</p>
      {SOURCE === "fixture" && (
        <p className="callout callout-warn" role="note" data-testid="fixture-mode">
          {t("landing.fixture_mode")}
        </p>
      )}
      {needToken && (
        <TokenPrompt
          rejected={tokenRejected}
          onSaved={() => {
            setNeedToken(false);
            void submit();
          }}
        />
      )}
      <form className="card stack" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="url">{t("landing.label")}</label>
          <input
            id="url"
            name="url"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder={t("landing.placeholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? "url-error url-hint" : "url-hint"}
            data-testid="url-input"
          />
          <span id="url-hint" className="small muted">
            {t("landing.hint")}
          </span>
        </div>
        <fieldset className="field" data-testid="mode-select" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted">{t("landing.mode.label")}</legend>
          <div className="radio-cards">
            {(["full", "quick"] as const).map((m) => (
              <label key={m} className="radio-card" data-checked={mode === m} data-testid={`mode-${m}`}>
                <input type="radio" name="audit-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  <strong>{t(`landing.mode.${m}` as Key)}</strong>
                  <span className="small muted block">{t(`landing.mode.${m}_desc` as Key)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {err && (
          <p id="url-error" role="alert" className="callout callout-danger" data-testid="url-error">
            {err}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy} data-testid="analyze">
            {busy ? t("landing.submitting") : t("landing.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
