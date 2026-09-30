# @sitelens/llm — LLM-шар S3 (без ключа)

Стан: **плумбінг доведено на replay/scripted fake; якість моделі, стабільність (§56) і вартість — ⏭️ live pass (OQ-1, S7).**
Replay-відповіді `fixtures/replay/**` — SYNTHETIC (пише інженер, `synthetic:true`), вони НЕ показують якість моделі.

## Конфіг (лише з env; жодного імені моделі в коді)
| змінна | значення |
|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `replay` \| `none`; порожньо → провайдер, чий ключ є; ключів немає → `none` (G0-2) |
| `LLM_MODEL` | обов'язкова для живого провайдера (без неї `ConfigError`) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | лише env; редагуються в логах/записах (`createLogger`, `redactDeep`) |
| `MAX_AUDIT_TOKENS` | E4, за замовчуванням 1 650 000 (DEV-44) |
| `LLM_CACHE_MODE` | `use` (типово) \| `bypass` (E2: 0 читань кешу) |
| `LLM_CACHE_NAMESPACE`, `REPLAY_DIR`, `REPLAY_AS` | namespace прогону; каталог `fixtures/replay`; ідентичність ключа E5 для replay (`replay:synthetic-fixture-v1`) |
`replay` у `production` → `ConfigError` (G0-2). `temperature`/`top_p` не надсилаються; якщо задано і провайдер відповів 400 про нього — повтор без нього, `temperature_dropped=true` (U-1 unverified).

## Два різні механізми відтворення (G0-16)
* **Scripted fake** (`ScriptedFakeProvider`, `LlmClient mode:"fake"`): логічний ключ `prompt_id|page_url|lens_id|task_id|step[#rN]`, `synthetic:true`, **не читає пікселі**, кеш E5 не використовує; промах = `ReplayMissError`.
* **Record/replay** (`ReplayCache`, `mode:"live"` пише, `mode:"replay"` читає): ключ E5 = провайдер+модель+prompt_id+повний вміст (з sha256 зображень)+схема виходу+семплінг. Промах у replay = `ReplayMissError`, провайдер не викликається ніколи. Пишеться лише ВАЛІДОВАНА відповідь.

## Етапи для worker S2 (чисті async-функції; БД/чергу/збереження робить worker)
Спільний контекст: `StageContext = { audit_run_id, client: LlmClient, language: "uk"|"en" }`; клієнт — `createClientFromEnv(process.env)`.
Кожна функція повертає `StageResult<T> = { stage, status: "done"|"skipped"|"budget_limited"|"failed", reason?, output, flags[], rejected[], calls[], prompt_id }` і **не кидає** на LLM-збоях (no LLM → `skipped`; бюджет → `budget_limited`; невалідно після 1 repair → `failed`, `output=null`). Кидає лише `ReplayMissError`/`ConfigError` (гучні). `calls` → `client.toLlmCall(rec, audit_run_id, stage)` = рядок `llm_calls` (§35).

| task worker | функція | вхід | вихід (`output`) |
|---|---|---|---|
| `build_site_profile` | `buildSiteProfile(ctx, { pages: PageInput[] })` | `loadPagesFromArtifacts(dir)` або власний мапінг `PageArtifact → PageInput` | `{ profile: SiteProfileCore, evidence[], prompt_id, pages_used }` |
| `generate_tasks` | `generateTasks(ctx, { pages, profile })` | профіль з попереднього етапу | `{ tasks: Task[] (4–7, URL стартової сторінки, audit_run_id), prompt_id }` |
| `generate_lenses` | `generateLenses(ctx, { profile, k? })` | `k` 8–20, за замовчуванням 12 | `{ lenses: BehavioralLens[], candidates_total, candidates_valid, selection, prompt_id }` + `flags` (`pole_unmet:Pn`, `unknown_var:…`, `poles_requested_again`) |
| `build_scenario_matrix` | `buildScenarioMatrix(ctx, { lenses, tasks })` | без LLM-виклику | `{ snapshot_entries, scenarios, fixed_journals, journal_scenarios, violations }`; `violations` не ховаються (`flags` `violation:*`) |
Адаптивні журнали (після snapshot-етапу): `selectAdaptiveJournals(...)`. Композиція для тестів: `runLlmStages(...)`; `toAuditRunRecord(...)` — AuditRun `completed` навіть якщо LLM-етапи skipped/budget_limited (DEV-11). У `AuditRun.stage_status` пиши `{status, reason}` з `StageResult`. Режим `none`: `client.mode==="none"` → усі чотири етапи `skipped: "no LLM provider"`; детермінований звіт-каркас — `buildNoLlmReportStub` + `NO_LLM_BANNER`.
Рішення агента (§20–§21) для S4: `validateAgentDecision(x)` (дозволені/заборонені дії, `reason_summary ≤ 200`, без chain-of-thought).

## Команди
`pnpm exec vitest run --configLoader runner packages/llm` · `pnpm run llm:prompts:lock` (додає НОВІ id; існуючий з іншим хешем — відмова) · `pnpm run llm:replay:record` (перезапис SYNTHETIC-фікстур; тест перевіряє, що вони не застаріли).
Зміна тексту промпту → новий id `…-v2` + запис у lock (SPEC §52; тест `prompts.test.ts`).
