-- 004_llm_providers.sql — DEV-86: провайдер у звіті. Розширення CHECK llm_provider (audit_runs) і provider (llm_calls):
-- + openai_compatible, claude_cli (BYO AI, DEV-85), session (DEV-82). llm_mode НЕ змінюється (live|replay|none; DEV-82: session → replay).
-- Для llm_mode=none провайдер = NULL (окремого значення 'none' немає). Forward-only.
ALTER TABLE audit_runs DROP CONSTRAINT chk_audit_runs_llm_provider;
ALTER TABLE audit_runs ADD CONSTRAINT chk_audit_runs_llm_provider CHECK (llm_provider IN ('anthropic','openai','openai_compatible','claude_cli','replay','session'));
ALTER TABLE llm_calls DROP CONSTRAINT chk_llm_calls_provider;
ALTER TABLE llm_calls ADD CONSTRAINT chk_llm_calls_provider CHECK (provider IN ('anthropic','openai','openai_compatible','claude_cli','replay','session'));
