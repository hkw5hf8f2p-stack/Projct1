"use client";
import { useState } from "react";
import { setToken } from "@/lib/client";
import { usePrefs } from "@/lib/prefs";

/** ACCESS_TOKEN (G0-5): показується лише коли API відповів 401. Токен — у sessionStorage цієї вкладки. */
export function TokenPrompt({ onSaved, rejected }: { onSaved: () => void; rejected?: boolean }) {
  const { t } = usePrefs();
  const [v, setV] = useState("");
  return (
    <form
      className="card stack"
      data-testid="token-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) {
          setToken(v.trim());
          onSaved();
        }
      }}
    >
      <h2>{t("token.title")}</h2>
      <p>{t("token.lead")}</p>
      {rejected && (
        <p role="alert" className="callout callout-danger">
          {t("token.wrong")}
        </p>
      )}
      <div className="field">
        <label htmlFor="token-input">{t("token.label")}</label>
        <input id="token-input" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} />
      </div>
      <div>
        <button type="submit" className="btn btn-primary">
          {t("token.save")}
        </button>
      </div>
    </form>
  );
}
