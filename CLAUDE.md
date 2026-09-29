# SiteLens — інструкції для сесії розробки

Evidence-backed AI діагностика конверсії сайтів із синтетичними behavioral lenses.
Власник — Арсен. Відповідай **українською**, технічні терміни англійською.

## Читати першим (у цьому порядку)
1. `START_HERE.md` — стан, порядок роботи, перший крок.
2. `docs/SPEC_REVIEW_UK.md` — рішення, що **мають пріоритет** над специфікацією.
3. `docs/SOURCE/SPEC.md` — вихідна специфікація (2563 рядки).
4. `planning/SPRINT_PLAN.md` — спринти S1–S8 з гейтами; `planning/STATE.md` — де ми зараз.
5. `planning/eval/SCORING_SPEC.md`, `planning/qa/TEST_STRATEGY.md`, `planning/RISK_REGISTER.md`.

## Ієрархія документів при суперечності
`planning/DEVIATION_LOG.md` + «Гейт 0» у `planning/SPRINT_PLAN.md` > `docs/SPEC_REVIEW_UK.md` > `planning/eval/SCORING_SPEC.md` / `planning/qa/TEST_STRATEGY.md` > `docs/SOURCE/SPEC.md`. Нова суперечність → запис у DEVIATION_LOG.

## Команда
Агенти в `.claude/agents/sl-*.md` (project scope — доступні як `subagent_type` одразу).
Опис ролей і матриця рішень — `planning/TEAM.md`. Ти — оркестратор: код пишуть інженери
(`sl-core-engineer`, `sl-backend-engineer`, `sl-frontend-engineer`, `sl-llm-engineer`), формули й guard —
`sl-eval-science`, мережа — `sl-security`, перевірка — `sl-qa-tester`, гейти — `sl-pm` + `sl-critic` + `sl-optimist`.
Якщо агенти не підхопились як типи — запускай `general-purpose` з першим рядком
«прочитай .claude/agents/sl-<role>.md і прийми його тіло як системний промпт».

## Незмінні правила продукту
- Жодних некаліброваних чисел: TAM, uplift конверсії, виручка, «% клієнтів/ринку». Лише «N of M synthetic …» і «Priority NN/100».
- Кожна знахідка має ≥1 evidence; рекомендація без знахідки відкидається. Класи: OBSERVED / BENCHMARKED / INFERRED / SYNTHETIC.
- Ніколи не змінювати чужий сайт: жодних не-GET запитів до цілі, форм, покупок, акаунтів.
- SSRF-фільтр на **кожен** запит браузера й Lighthouse (resolved IP), не лише на стартовий URL.
- Секрети — тільки в `.env` (ігнорується git) або в сховищі середовища; ніколи в репо, логах, артефактах.

## Правила роботи Арсена
- **Перевіряй артефактом, не exit-кодом.** Зелений білд ≠ пройдений тест. Звіт субагента — гіпотеза, доки не перевірив сам.
- **Межа тестованості священна.** Без ключа LLM усе LLM-залежне — ⏭️ *deferred to live pass*, ніколи ✅. Replay-відповіді доводять плумбінг, не якість моделі.
- **Жодних галюцинацій.** Неперевірене називається «неперевірене» + що його перевірить.
- **Перевір, що перевірка вміє впасти**: кожен детектор/guard/фільтр мусить бути показаний і на позитивному, і на негативному випадку.
- Будуй інкрементно (SPEC §70): після кожного етапу — тести; компіляцію, міграції й runtime-помилки фіксити одразу. Не генерувати весь застосунок без запуску.
- Джерело правди — git. Документи в `planning/` оновлюються разом із кодом; кожен спринт закривається `planning/conclusions/sprint-N.md` з вердиктом Go/Fix/Pivot/No-go; `planning/STATE.md` — актуальний після кожного гейту.
- Відхилення від SPEC — лише через запис у `planning/DEVIATION_LOG.md`.
- Не вбивати чужі процеси (`pgrep -x`, ніколи `killall`/`pkill -f`); прибирати лише за собою.
- Не пушити, не розгортати публічно й не надсилати нічого назовні без явного «так» власника.

## Середовище
- Node ≥ 22 + pnpm. PostgreSQL: якщо є Docker — `infra/docker-compose.yml`; якщо ні — `embedded-postgres`
  (перевірено на Mac власника, див. `planning/engineering/toolchain-probe.md`; у pnpm 11 postinstall дозволяється через `allowBuilds` у `pnpm-workspace.yaml`, не `onlyBuiltDependencies`).
- Черга — `pg-boss` (не Redis/BullMQ, DEV-1). Браузер — Playwright Chromium: Playwright 1.63 потребує ревізію 1243 → `pnpm exec playwright install chromium`.
- LLM: `LLM_PROVIDER=anthropic|openai|replay`, `LLM_MODEL`, ключ у `.env`. Без ключа — replay. Дефолтна модель для Anthropic задається змінною, не хардкодом.
