-- 005_finding_texts.sql — DEV-98: тексти знахідок від LLM (finding-aggregator-v1 → recommendation-v1) на живому шляху worker.
-- Один рядок на (аудит, finding_key): сирі поля моделі ДО guard/маскування чисел (buildReport робить це при кожному збиранні звіту),
-- версії промптів і llm_calls (відтворюваність §35). Переживає рестарт: generate_report читає звідси. Жодних чисел ринку/uplift. Forward-only.
CREATE TABLE finding_texts (
  audit_run_id     text NOT NULL REFERENCES audit_runs (id) ON DELETE CASCADE,
  finding_key      text NOT NULL,
  status           text NOT NULL,
  title            text,
  problem          text,
  why_it_matters   text,
  recommended_change text,
  how_to_validate  text,
  prompt_versions  text[] NOT NULL DEFAULT '{}',
  llm_call_ids     text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_run_id, finding_key),
  CONSTRAINT chk_finding_texts_status CHECK (status IN ('supported','not_supported'))
);
