-- 002_pipeline.sql — S2: стійкий конвеєр (SPEC §8, §47, §48, §55.11–13; DEV-11, DEV-48+).
-- Forward-only. Доповнює audit_runs (мова, лічильник токенів E4, клас помилки §48, попередження про часткові збої) і додає
-- журнал прогресу під-задач `audit_jobs` (ідемпотентність і часткові результати). Жодних market share / TAM / uplift.

ALTER TABLE audit_runs
  ADD COLUMN language        text   NOT NULL DEFAULT 'uk',
  ADD COLUMN tokens_input    bigint NOT NULL DEFAULT 0,   -- E4: лічильник токенів (LLM-етапи; 0 без LLM)
  ADD COLUMN tokens_output   bigint NOT NULL DEFAULT 0,
  ADD COLUMN error_class     text,                        -- §48: один із 12 класів; error = людське повідомлення
  ADD COLUMN warnings        jsonb  NOT NULL DEFAULT '[]'::jsonb,  -- часткові збої: [{stage, page_url?, class, message}]
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT chk_audit_runs_language CHECK (language IN ('uk','en')),
  ADD CONSTRAINT chk_audit_runs_tokens CHECK (tokens_input >= 0 AND tokens_output >= 0),
  ADD CONSTRAINT chk_audit_runs_error_class CHECK (error_class IS NULL OR error_class IN (
    'invalid_url','dns_failure','ssl_failure','timeout','bot_protection','captcha','browser_crash','page_crash',
    'redirect_loop','unsupported_site','empty_page','js_rendering_failure')),
  ADD CONSTRAINT chk_audit_runs_warnings_arr CHECK (jsonb_typeof(warnings) = 'array'),
  ADD CONSTRAINT chk_audit_runs_failed_class CHECK (status <> 'failed' OR error_class IS NOT NULL);
CREATE INDEX ix_audit_runs_created ON audit_runs (created_at DESC);                       -- ліміт аудитів/год (B2)
CREATE INDEX ix_audit_runs_artifact_expiry ON audit_runs (artifact_expires_at) WHERE artifacts_deleted_at IS NULL;  -- TTL-прибирання (F3)

-- журнал під-задач: capture:<page_id>, lighthouse:<page_id>:<form_factor>, accessibility:<page_id>
CREATE TABLE audit_jobs (
  audit_run_id  text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  job_key       text NOT NULL,
  kind          text NOT NULL,
  page_url      text,
  status        text NOT NULL,
  error_class   text,
  error         text,
  attempts      integer NOT NULL DEFAULT 1,
  result_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, job_key),
  CONSTRAINT chk_audit_jobs_kind CHECK (kind IN ('capture','lighthouse','accessibility')),
  CONSTRAINT chk_audit_jobs_status CHECK (status IN ('done','failed','skipped')),
  CONSTRAINT chk_audit_jobs_error_class CHECK (error_class IS NULL OR error_class IN (
    'invalid_url','dns_failure','ssl_failure','timeout','bot_protection','captcha','browser_crash','page_crash',
    'redirect_loop','unsupported_site','empty_page','js_rendering_failure')),
  CONSTRAINT chk_audit_jobs_failed_has_error CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX ix_audit_jobs_status ON audit_jobs (audit_run_id, status);
