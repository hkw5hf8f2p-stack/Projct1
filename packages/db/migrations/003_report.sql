-- 003_report.sql — S4: сценарії симуляції, збережений звіт (SPEC §35, §47; DEV-68).
-- Forward-only. Жодних market share / TAM / uplift. Звіт — уже перевірений guard-ом JSON за контрактом Report; API віддає лише його.

-- журнал під-задач: + run_snapshot_scenario / run_browser_scenario (job_key: snapshot:<scenario_id>, browser:<scenario_id>)
ALTER TABLE audit_jobs DROP CONSTRAINT chk_audit_jobs_kind;
ALTER TABLE audit_jobs ADD CONSTRAINT chk_audit_jobs_kind CHECK (kind IN ('capture','lighthouse','accessibility','snapshot','browser'));

-- пристрій сценарію snapshot (SCORING_SPEC §10, MatrixEntry.device): вибір скриншота першого вікна
ALTER TABLE scenarios
  ADD COLUMN device text,
  ADD CONSTRAINT chk_scenarios_device CHECK (device IS NULL OR device IN ('mobile','desktop'));

-- шляхи сторінок, які бачила сесія (SessionObs.pages_seen: експозиція для lens_coverage/session_frequency, SCORING_SPEC §4)
ALTER TABLE synthetic_sessions ADD COLUMN pages_seen text[] NOT NULL DEFAULT '{}';

-- збережений звіт: один на аудит (перезапис generate_report при повторі — ON CONFLICT DO UPDATE)
CREATE TABLE audit_reports (
  audit_run_id     text PRIMARY KEY REFERENCES audit_runs (id) ON DELETE CASCADE,
  report           jsonb NOT NULL,
  report_sha256    text NOT NULL,
  schema_version   text NOT NULL,
  scoring_version  text NOT NULL,
  guard_version    text,
  guard_events     integer NOT NULL DEFAULT 0,
  rejected         jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at     timestamptz NOT NULL,
  CONSTRAINT chk_audit_reports_sha CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_audit_reports_obj CHECK (jsonb_typeof(report) = 'object'),
  CONSTRAINT chk_audit_reports_rejected_arr CHECK (jsonb_typeof(rejected) = 'array')
);
