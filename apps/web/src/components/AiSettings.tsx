"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { checkAi, deleteAiKey, getAiSettings, putAiSettings, type ApiFailure } from "@/lib/client";
import {
  CHECK_ERROR_CLASSES, LLM_CONCURRENCY_MAX, LLM_CONCURRENCY_MIN, KIND_NEEDS_KEY, defaultConcurrency, parseConcurrency, KIND_NEEDS_MODEL, MODEL_PLACEHOLDER, PROVIDER_KINDS, parseTokens, validBaseUrl,
  type AiCheckResult, type AiSettingsView, type ProviderKind,
} from "@/lib/ai-settings";
import type { Key } from "@/lib/messages";
import { usePrefs } from "@/lib/prefs";
import { TokenPrompt } from "./TokenPrompt";

/** `code` у підписах → <code>: потрібно для команд (`claude auth login`). Текст — лише з каталогу підписів UI. */
function withCode(s: string) {
  return s.split("`").map((p, i) => (i % 2 ? <code key={i} className="mono">{p}</code> : <Fragment key={i}>{p}</Fragment>));
}

type Busy = null | "save" | "delete" | "check";
type Msg = { tone: "ok" | "danger"; text: string } | null;

export function AiSettings() {
  const { t, lang } = usePrefs();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [loadErr, setLoadErr] = useState<ApiFailure | null>(null);
  const [kind, setKind] = useState<ProviderKind>("none");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [tokens, setTokens] = useState("");
  const [conc, setConc] = useState("");
  const [concTouched, setConcTouched] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [errs, setErrs] = useState<Partial<Record<"model" | "base" | "tokens" | "conc", Key>>>({});
  const [check, setCheck] = useState<AiCheckResult | null>(null);

  const adopt = useCallback((v: AiSettingsView) => {
    setView(v);
    setKind(v.kind);
    setModel(v.model);
    setBaseUrl(v.base_url ?? "");
    setTokens(String(v.max_audit_tokens));
    setConc(String(v.llm_concurrency ?? defaultConcurrency(v.kind)));
    setConcTouched(false);
    setApiKey(""); // ключ ніколи не лишається в стані після відповіді
  }, []);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await getAiSettings();
    if (r.ok) adopt(r.data);
    else setLoadErr(r);
  }, [adopt]);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadErr?.cls === "unauthorized") return <TokenPrompt rejected={false} onSaved={() => void load()} />;
  if (loadErr)
    return (
      <div className="card stack" data-testid="ai-load-error" role="alert">
        <h1>{t("ai.title")}</h1>
        <p className="callout callout-danger">{loadErr.cls === "ai_settings_unavailable" ? t("ai.err.storage_unavailable") : t("ai.load_failed")}</p>
        <div><button type="button" className="btn" onClick={() => void load()}>{t("ai.retry")}</button></div>
      </div>
    );
  if (!view)
    return (
      <div className="stack" data-testid="ai-loading" role="status" aria-busy="true">
        <h1>{t("ai.title")}</h1>
        <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );

  const needsKey = KIND_NEEDS_KEY[kind];
  const dirty =
    kind !== view.kind || model.trim() !== view.model || baseUrl.trim() !== (view.base_url ?? "") || tokens.trim() !== String(view.max_audit_tokens) || concTouched || apiKey !== "";
  const errText = (r: ApiFailure) => (r.http === 0 ? t("ai.err.network_api") : r.cls === "unauthorized" ? t("error.unauthorized") : r.cls === "ai_settings_unavailable" ? t("ai.err.storage_unavailable") : t("ai.save_failed"));

  async function save() {
    const e: typeof errs = {};
    if (KIND_NEEDS_MODEL[kind] && !model.trim()) e.model = "ai.err.model_required";
    if (kind === "openai_compatible") {
      if (!baseUrl.trim()) e.base = "ai.err.base_url_required";
      else if (!validBaseUrl(baseUrl)) e.base = "ai.err.base_url_invalid";
    }
    const tk = parseTokens(tokens);
    if (kind !== "none" && tk === null) e.tokens = "ai.err.tokens_invalid";
    const cc = parseConcurrency(conc);
    if (kind !== "none" && concTouched && cc === null) e.conc = "ai.err.concurrency_invalid";
    setErrs(e);
    setMsg(null);
    if (Object.keys(e).length) return;
    setBusy("save");
    const input = {
      kind,
      ...(KIND_NEEDS_MODEL[kind] || (kind === "claude_cli" && model.trim()) ? { model: model.trim() } : {}),
      ...(kind === "openai_compatible" ? { base_url: baseUrl.trim() } : {}),
      ...(needsKey && apiKey ? { api_key: apiKey } : {}),
      ...(kind !== "none" && tk !== null ? { max_audit_tokens: tk } : {}),
      ...(kind !== "none" && concTouched && cc !== null ? { llm_concurrency: cc } : {}), // лише якщо змінено: інакше діє типове за провайдером (3; claude_cli — 2)
    };
    const r = await putAiSettings(input);
    setBusy(null);
    setCheck(null);
    if (r.ok) {
      adopt(r.data);
      setMsg({ tone: "ok", text: t("ai.saved") });
    } else setMsg({ tone: "danger", text: errText(r) });
  }
  async function removeKey() {
    setBusy("delete");
    setMsg(null);
    const r = await deleteAiKey();
    setBusy(null);
    setCheck(null);
    if (r.ok) {
      setView(r.data);
      setApiKey("");
      setMsg({ tone: "ok", text: t("ai.key.deleted") });
    } else setMsg({ tone: "danger", text: errText(r) });
  }
  async function runCheck() {
    setBusy("check");
    setMsg(null);
    setCheck(null);
    const r = await checkAi();
    setBusy(null);
    if (r.ok) setCheck(r.data);
    else setMsg({ tone: "danger", text: r.cls === "ai_settings_unavailable" ? t("ai.err.storage_unavailable") : r.http === 0 ? t("ai.err.network_api") : t("ai.check.unavailable") });
  }

  const checkErr = (c: string | null | undefined) => {
    const known = (CHECK_ERROR_CLASSES as readonly string[]).includes(c ?? "");
    return t(`ai.err.check.${known ? c : "unknown"}` as Key);
  };
  const kindDesc = (k: ProviderKind) => t(`ai.kind.${k}.desc` as Key);
  const updated = view.updated_at ? new Date(view.updated_at).toLocaleString(lang) : null;
  const canCheck = view.kind !== "none" && !dirty && busy === null;

  return (
    <form className="stack ai-settings" data-testid="ai-settings" noValidate onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
      <h1>{t("ai.title")}</h1>
      <p>{t("ai.lead")}</p>

      <fieldset className="card stack ai-fieldset">
        <legend>{t("ai.provider")}</legend>
        <div className="radio-cards">
          {PROVIDER_KINDS.map((k) => (
            <label key={k} className="radio-card" data-checked={kind === k} data-testid={`kind-${k}`}>
              <input type="radio" name="ai-kind" value={k} checked={kind === k} onChange={() => { setKind(k); setErrs({}); setMsg(null); }} />
              <span>
                <strong>{t(`ai.kind.${k}` as Key)}</strong>
                <span className="small muted block">{withCode(kindDesc(k))}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {kind !== "none" && (
        <section className="card stack" aria-labelledby="ai-conn">
          <h2 id="ai-conn">{t("ai.connection")}</h2>

          {kind === "openai_compatible" && (
            <div className="field">
              <label htmlFor="ai-base">{t("ai.base_url.label")}</label>
              <input id="ai-base" type="url" autoComplete="off" spellCheck={false} placeholder="http://localhost:11434/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                aria-describedby={`ai-base-h${errs.base ? " ai-base-e" : ""}`} aria-invalid={errs.base ? true : undefined} />
              <span id="ai-base-h" className="small muted">{t("ai.base_url.hint")}</span>
              {errs.base && <span id="ai-base-e" role="alert" className="small claim-warn">{t(errs.base)}</span>}
            </div>
          )}

          <div className="field">
            <label htmlFor="ai-model">{t("ai.model.label")}{KIND_NEEDS_MODEL[kind] ? "" : ` (${t("ai.optional")})`}</label>
            <input id="ai-model" type="text" autoComplete="off" spellCheck={false} placeholder={`${t("ai.model.example")} ${MODEL_PLACEHOLDER[kind]}`} value={model} onChange={(e) => setModel(e.target.value)}
              aria-describedby={`ai-model-h${errs.model ? " ai-model-e" : ""}`} aria-invalid={errs.model ? true : undefined} />
            <span id="ai-model-h" className="small muted">{t("ai.model.hint")}</span>
            {errs.model && <span id="ai-model-e" role="alert" className="small claim-warn">{t(errs.model)}</span>}
          </div>

          {needsKey && (
            <div className="field" data-testid="key-block">
              <label htmlFor="ai-key">{t("ai.key.label")}{kind === "openai_compatible" ? ` (${t("ai.optional")})` : ""}</label>
              {view.key_set && view.kind === kind ? (
                <p className="callout callout-ok" data-testid="key-saved" role="status">
                  {view.source === "env" ? t("ai.key.from_env") : t("ai.key.saved", { hint: `…${(view.key_hint ?? "").replace(/^[.…*•]+/, "")}` })}
                </p>
              ) : (
                <p className="small muted" data-testid="key-none">{t("ai.key.none")}</p>
              )}
              <input id="ai-key" type="password" name="ai-api-key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={view.key_set ? t("ai.key.replace_placeholder") : t("ai.key.placeholder")} aria-describedby="ai-key-h" />
              <span id="ai-key-h" className="small muted">{t("ai.key.hint")}</span>
              {view.key_set && view.source === "ui" && (
                <div>
                  <button type="button" className="btn" data-testid="key-delete" disabled={busy !== null} onClick={() => void removeKey()}>
                    {busy === "delete" ? t("ai.key.deleting") : t("ai.key.delete")}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="field">
            <label htmlFor="ai-tokens">{t("ai.tokens.label")}</label>
            <input id="ai-tokens" type="text" inputMode="numeric" autoComplete="off" value={tokens} onChange={(e) => setTokens(e.target.value)}
              aria-describedby={`ai-tokens-h${errs.tokens ? " ai-tokens-e" : ""}`} aria-invalid={errs.tokens ? true : undefined} />
            <span id="ai-tokens-h" className="small muted">{t("ai.tokens.hint")}</span>
            {errs.tokens && <span id="ai-tokens-e" role="alert" className="small claim-warn">{t(errs.tokens)}</span>}
          </div>

          <div className="field">
            <label htmlFor="ai-conc">{t("ai.concurrency.label")}</label>
            <input id="ai-conc" data-testid="ai-concurrency" type="number" min={LLM_CONCURRENCY_MIN} max={LLM_CONCURRENCY_MAX} step={1} inputMode="numeric" autoComplete="off"
              value={concTouched || conc !== "" ? conc : String(defaultConcurrency(kind))} onChange={(e) => { setConc(e.target.value); setConcTouched(true); }}
              aria-describedby={`ai-conc-h${errs.conc ? " ai-conc-e" : ""}`} aria-invalid={errs.conc ? true : undefined} />
            <span id="ai-conc-h" className="small muted">{t("ai.concurrency.hint", { def: defaultConcurrency(kind) })}</span>
            {errs.conc && <span id="ai-conc-e" role="alert" className="small claim-warn">{t(errs.conc)}</span>}
          </div>
        </section>
      )}

      <div className="row-actions">
        <button type="submit" className="btn btn-primary" data-testid="ai-save" disabled={busy !== null}>{busy === "save" ? t("ai.saving") : t("ai.save")}</button>
        <button type="button" className="btn" data-testid="ai-check" disabled={!canCheck} onClick={() => void runCheck()}>
          {busy === "check" ? t("ai.checking") : t("ai.check")}
        </button>
      </div>
      {dirty && view.kind !== "none" && <p className="small muted">{t("ai.dirty_hint")}</p>}
      {msg && <p role={msg.tone === "danger" ? "alert" : "status"} className={`callout callout-${msg.tone}`} data-testid="ai-msg">{msg.text}</p>}

      <div aria-live="polite" data-testid="ai-check-result">
        {check && (check.ok ? (
          <p className="callout callout-ok" data-testid="check-ok">
            {t("ai.check.ok", { ms: check.latency_ms })}
            {check.model_reported ? <> {t("ai.check.model_reported", { model: check.model_reported })}</> : null}
          </p>
        ) : (
          <p className="callout callout-danger" data-testid="check-fail" data-error-class={check.error_class ?? "unknown"}>
            {t("ai.check.failed")} {checkErr(check.error_class)}
          </p>
        ))}
      </div>

      <p className="small muted" data-testid="ai-status">
        {t("ai.current", { kind: t(`ai.kind.${view.kind}` as Key) })}
        {updated ? ` · ${t("ai.updated")}: ${updated}` : ""}
        {view.last_check ? ` · ${t("ai.last_check")}: ${view.last_check.ok ? t("ai.check.last_ok") : checkErr(view.last_check.error_class)}` : ""}
      </p>
      <p className="small muted" data-testid="ai-source" data-source={view.source}>{t(`ai.source.${view.source}` as Key)}</p>

      <section className="card stack" aria-labelledby="ai-notes" data-testid="ai-notes">
        <h2 id="ai-notes">{t("ai.notes.title")}</h2>
        <ul>
          <li>{t("ai.note.costs")}</li>
          <li>{t("ai.note.subscriptions")}</li>
          <li>{t("ai.note.key_storage")}</li>
          {kind === "none" && <li>{t("ai.note.none")}</li>}
        </ul>
      </section>
    </form>
  );
}
