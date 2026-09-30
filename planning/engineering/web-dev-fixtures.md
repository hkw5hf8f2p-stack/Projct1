# apps/web — запуск і dev-фікстури (S5)

- Реальний API: `pnpm web` (`next dev -H 127.0.0.1 -p 3000`, rewrites `/api/*` → `SITELENS_API_URL`, за замовчуванням `http://127.0.0.1:3001`). Очікує від backend `GET /api/audits/:id/report` і `GET /api/audits/:id/artifacts/<path>` (DEV-65, unverified).
- Фікстури: `pnpm web:fixtures` (`SITELENS_SOURCE=fixture`, лише не-production). Мова й тема — cookie `sl_lang` (uk|en), `sl_theme` (light|dark); вкладка й фільтри — query `?tab=&category=&confidence=…&evidence=ev_…`.
- Ідентифікатори аудитів: `fx_completed` (replay-приклад), `fx_nollm`, `fx_clean` (0 знахідок, 5 позитивів), `fx_partial`, `fx_budget`, `fx_early` (без лінз/журналів), `fx_queued`, `fx_running`, `fx_running_partial`, `fx_failed_<клас §48>` ×12, `fx_report_500`, `fx_report_404`, `fx_bad_schema`, `fx_slow` (loading), `fx_deleted` (артефакти видалено), `fx_locked` (токен `fixture-token`), `fx_live` (часова симуляція submit → progress → report).
- Лендінг у fixture-режимі: слова в URL обирають сценарій (`nollm`, `clean`, `queued`, `failed`, `bot`, `slow`, `static`, `ratelimit`); приватні адреси → `invalid_url`.
- Перевірки: `SL_WRITE_ARTIFACTS=1 bash scripts/run-as-sitelens.sh pnpm exec vitest run --configLoader runner apps/web/test` (піднімає `next dev` сам). Артефакти — `planning/qa/artifacts/sprint-5/`.
