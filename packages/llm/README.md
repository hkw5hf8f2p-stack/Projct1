# @sitelens/llm — LLM-шар S3 (без ключа)

Стан: **плумбінг доведено на replay/scripted fake; якість моделі, стабільність (§56) і вартість — ⏭️ live pass (OQ-1, S7).**
Replay-відповіді `fixtures/replay/**` — SYNTHETIC (пише інженер, `synthetic:true`), вони НЕ показують якість моделі.

## Конфіг (лише з env; жодного імені моделі в коді)
| змінна | значення |
|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `openai_compatible` \| `claude-cli` \| `session` \| `replay` \| `none`; порожньо → провайдер, чий ключ є; ключів немає → `none` (G0-2) |
| `LLM_MODEL` | обов'язкова для живого провайдера (без неї `ConfigError`) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | лише env; редагуються в логах/записах (`createLogger`, `redactDeep`) |
| `OPENAI_BASE_URL` / `OPENAI_API_MODE` | `openai_compatible` (Ollama, LM Studio, vLLM…) або `openai` із чужою базою → **Chat Completions** (`/v1/chat/completions`, `response_format` json_schema → json_object → лише промпт; Zod перевіряє завжди); `OPENAI_API_MODE=responses` → `/v1/responses`. База з `/v1` чи без — обидві працюють. Перевірено лише мок-HTTP (DEV-89), реальні сервери — ⏭️ live |
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

## Транспорти без API-ключа (S7)
### `session` — Claude у сесії, двофазно (DEV-82; протокол — `planning/eval/s7-session-protocol.md`)
`LLM_PROVIDER=session SESSION_MODEL_NAME=<ім'я>` (лише dev; у production `ConfigError`; `LLM_CACHE_MODE=bypass` заборонено — для E2 окремий `LLM_CACHE_NAMESPACE` на прогін). Промах → запит у `planning/qa/artifacts/s7-session/requests/<id>.json` (+ `img/`), етап `awaiting_session_model`; відповідь у `responses/<id>.json` обробляється як відповідь API (parse → Zod → guard → repair; невалідна → `attempt=2`) і пишеться в кеш E5 з provenance `{provider:"session", answered_by:"blind-subagent", synthetic:false, tokens_estimated:true}`. `pnpm s7:export -- <fixture-shop|shop-clean|shop-clean-degraded|injection|all>`, `pnpm s7:import`, відтворення: `LLM_PROVIDER=replay REPLAY_AS=session:<ім'я> pnpm validate --provider replay`. Що доводить/чого ні — DEV-82. Тести: `packages/llm/test/session.test.ts`, `scripts/validate/session.test.ts` (шаблонні «відповіді» тесту, не модель).

### LLM через підписку Claude (`claude-cli`, DEV-83)
Кроки на Mac власника:
1. Встанови Claude Code CLI (за документацією Claude Code) — команда `claude` має бути в PATH (або `CLAUDE_CLI_BIN=/шлях/до/claude`).
2. `pnpm llm:login` — покаже версію й статус автентифікації. Не залогінено → `claude auth login` (підписка, інтерактивно) або `claude setup-token` (довгоживучий токен підписки для неінтерактивних запусків; зберігай лише в `.env`/сховищі середовища, ніколи в репо чи логах). `pnpm llm:login -- --run` запустить `claude auth login`.
3. `pnpm llm:check` — один дешевий структурований виклик (ping зі схемою): друкує модель, токени (usage CLI або оцінка), затримку.
4. `LLM_PROVIDER=claude-cli` (за бажання `LLM_MODEL=<аліас або повне ім'я>`; порожньо — модель CLI за замовчуванням, фактична пишеться в provenance). Ключі `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` дочірньому процесу НЕ передаються (інакше CLI пішов би на API-тариф). Таймаут — `CLAUDE_CLI_TIMEOUT_MS` (180 с).
Безпека: єдиний інструмент моделі — Read у тимчасовому каталозі зі скриншотами (`--tools Read`, `--allowedTools Read`, `--add-dir`, `--restricted`, без MCP/Bash/Edit/Write/WebFetch); текст сторінки — дані. Токени беруться з `usage` виводу CLI (інакше estimated), $ не рахується (підписка). Обмеження й UNVERIFIED — DEV-83 (`--max-turns` у CLI v2.1.285 немає; стабільність/ліміти підписки — ⏭️).
Умови: підписка призначена для особистого/локального використання. Для сервісу, що аналізує сайти для інших людей, потрібен API-ключ (комерційні умови); чинні умови Anthropic перевір до такого використання.
