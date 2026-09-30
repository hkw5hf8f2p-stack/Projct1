# SiteLens

Evidence-backed AI-діагностика конверсії сайтів із синтетичними behavioral lenses. Повна специфікація — `docs/SOURCE/SPEC.md`; рішення, що мають
пріоритет над нею, — `planning/DEVIATION_LOG.md`, `docs/SPEC_REVIEW_UK.md`. Стан проєкту — `planning/STATE.md`.

**Що працює (README v1, S8):** ви подаєте URL в UI (або через API) → стійкий конвеєр (черга в PostgreSQL) обходить сайт (≤ 12 сторінок), знімає
desktop 1440×1000 і mobile 390×844, запускає Lighthouse (через egress-проксі), axe і детермінований набір детекторів, зберігає **докази** (Evidence) у БД
і скриншоти на диск, збирає звіт (guard перевіряє кожен текст) і показує його в UI (10 поверхонь: Landing, Progress, Overview, Audience lenses, Journey,
Findings, Technical, Experiments-заглушка, Evidence, lightbox зі скриншотом і підсвіченою областю). Аудит переживає `kill -9` worker/API; збій сторінки чи
Lighthouse не валить аудит; збій захоплення — чесна помилка, а не «аналіз». **Без ключа LLM працює режим `llm_mode=none`** (детерміновані знахідки, банер
«синтетичний аналіз не виконувався»). **Чого ще немає / ⏭️:** живі публічні сайти, якість моделі (LLM), варіанти A/B (S6) — див. «Known limitations».

## Вимоги
| що | версія / примітка |
|---|---|
| Node.js | ≥ 22.19 (перевірено 22.22.2) |
| pnpm | 10.33.0 (`packageManager` у `package.json`; `corepack enable`) |
| ОС | Linux x64 або macOS arm64 (бінарники PostgreSQL з npm). Docker **не потрібен** (DEV-2) |
| Браузер | Playwright Chromium — окремий крок нижче |
| Мережа | лише для `pnpm install`, завантаження Chromium і живих сайтів. Тести й фікстури працюють офлайн |

## Швидкий старт (чиста машина)
Кроки виконуються **по черзі**, з кореня репозиторію. Лінукс-контейнер під root — див. наступний абзац (кожну команду через `bash scripts/run-as-sitelens.sh …`).
```bash
pnpm install                          # пакети; postinstall для esbuild і @embedded-postgres/* дозволено в pnpm-workspace.yaml
pnpm exec playwright install chromium # браузер (Playwright 1.56.1, ревізія 1194); потребує мережі до CDN Playwright — див. примітку нижче
pnpm run doctor                       # ПЕРЕВІРКА СЕРЕДОВИЩА (перший крок після install): node, pnpm, chromium, пісочниця, axe, lighthouse. Саме `pnpm run doctor`: `pnpm doctor` — вбудована команда pnpm, вона нічого не перевіряє
cp .env.example .env                  # усе за замовчуванням працює; секретів у файлі немає
pnpm db:start                         # embedded PostgreSQL як демон: дані data/pg, порт 54329, PID у data/pids/postgres.json
pnpm db:migrate                       # forward-only міграції 001–003 з нуля
pnpm api                              # термінал 1: API на http://127.0.0.1:3001
pnpm worker                           # термінал 2: worker (pg-boss) — обходить і знімає сторінки, збирає звіт
pnpm web                              # термінал 3: UI на http://127.0.0.1:3000 (Next.js dev; /api/* проксіюється на API, SITELENS_API_URL)
```
Відкрийте **http://127.0.0.1:3000**, введіть адресу сайту → «Analyze website»: Progress (8 кроків §43) → звіт. Скриншоти й артефакти — у `data/artifacts/<auditId>/`.

**Перевірено 30.09.2026 (S8, QA) на чистому `git clone` (Linux x64, Node 22.22.2, pnpm 10.33.0, окремі pnpm store і кеш, без `node_modules` і `data/`):** `pnpm install` (7 с) → `pnpm run doctor` (PASS) → `.env` → `db:start` →
`db:migrate` (001–003) → `pnpm fixtures`/`api`/`worker`/`web` (усе на 127.0.0.1) → подання `http://127.0.0.1:4210/` через UI → звіт `llm_mode=none` → знахідка → скриншот із підсвіченою областю;
`pnpm test` — **1457/1457** (66 файлів), `pnpm validate` — PASS (E3c ⏭️). Лог і артефакти — `planning/qa/artifacts/sprint-8/`. **Не перевірено:** macOS; `playwright install` із мережі до CDN (Chromium був наперед у `/opt/pw-browsers`);
`docker compose up -d`; живі публічні сайти.

**Chromium без доступу до CDN (закритий інтернет, контейнер).** `playwright install` без мережі не завершується (повідомлення немає): якщо Chromium ревізії 1194 уже
лежить у спільному каталозі, **пропустіть цей крок** і вкажіть `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (`run-as-sitelens.sh` робить це сам); `pnpm run doctor` покаже,
чи потрібний Chromium знайдено (`chromium_installed: PASS`). Якщо крок потрібен — обмежте його: `timeout 300 pnpm exec playwright install chromium`.

**Docker startup (⏭️ не перевірено).** SPEC §71 радить `docker compose up -d`; `infra/docker-compose.yml` (лише PostgreSQL) **ніколи не запускався** (немає Docker-демона в середовищі
розробки). Основний шлях — embedded-postgres (`pnpm db:start`); Docker не потрібен (DEV-2).

Подати сайт через API і дочекатись результату:
```bash
curl -s -X POST http://127.0.0.1:3001/api/audits -H 'content-type: application/json' -d '{"url":"https://example.com"}'
# → {"auditId":"aud_…"}   (202 Accepted)
curl -s http://127.0.0.1:3001/api/audits/aud_…          # статус, етапи, попередження, помилка
curl -s http://127.0.0.1:3001/api/audits/aud_…/pages    # сторінки (+ збійні з класом помилки)
curl -s http://127.0.0.1:3001/api/audits/aud_…/evidence/ev_…
curl -s http://127.0.0.1:3001/api/audits/aud_…/report   # звіт за контрактом Report (лише коли аудит completed)
```
**Без інтернету / на локальних фікстурах** (fixture-режим послаблює SSRF-захист лише для явно перелічених origin-ів; заборонений при `NODE_ENV=production`):
```bash
export SITELENS_FIXTURE_MODE=1 SITELENS_FIXTURE_ORIGINS=http://127.0.0.1:4210,http://127.0.0.1:4213
pnpm fixtures                         # окремий термінал: shop :4210, shop-clean :4211, bot :4212, errors :4213 (HTTPS :4214)
# запустіть pnpm api і pnpm worker з тими самими змінними, тоді в UI (або curl) подайте http://127.0.0.1:4210/
curl -s -X POST http://127.0.0.1:3001/api/audits -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:4210/"}'
```
**Лише UI без бекенда (dev):** `pnpm web:fixtures` — UI читає записані звіти (`/audit/fx_completed`, `fx_nollm`, `fx_clean`, `fx_partial`, `fx_running`, `fx_failed_<клас>` …); не для користувачів.

**Linux у контейнері під root.** Postgres і Chromium-пісочниця не стартують під root (DEV-13/25). Запускайте кожну команду через
`bash scripts/run-as-sitelens.sh pnpm …` (створює користувача `sitelens`, віддає йому `data/`, очищає env). Змінні, що мають дійти до процесу,
перелічіть у `SL_PASS_VARS="A B"`. Приклад: `SL_PASS_VARS="SITELENS_FIXTURE_MODE SITELENS_FIXTURE_ORIGINS" bash scripts/run-as-sitelens.sh pnpm worker`.
Проксі/мережа для `pnpm install` під sitelens: `SL_PASS_PROXY=1`. Репозиторій, що належить root, `sitelens` не може клонувати (git «dubious ownership») — клонуйте від власника каталогу.

Зупинка: `Ctrl+C` для api/worker/web (api/worker штатно вбивають власні дочірні процеси); `pnpm db:stop` зупиняє лише наш кластер.

## API (SPEC §42)
| метод і шлях | відповідь |
|---|---|
| `POST /api/audits` `{"url", "language"?: "uk"\|"en", "mode"?: "quick"\|"full"}` | `202 {auditId}`; `400` (клас `invalid_url` + пояснення); `401`; `429` (ліміт) |
| `GET /api/audits/:id` | статус (`queued → crawling → profiling → generating_lenses → running_scenarios → aggregating → completed \| failed`), `stage_status` кожного етапу, `progress`, `steps[8]`, `step_details[]` (лічильники й ETA по кроках), `mode`, `llm_concurrency`, `warnings[]`, `error {class, message}` |
| `GET /api/audits/:id/pages` | сторінки: тип, скриншоти, `capture_ok`, `capture_error {class, message}`, `egress_denied[]` (що заблокував SSRF-шар), `evidence_count` |
| `GET /api/audits/:id/report` | звіт за контрактом `Report` (`packages/schemas/src/report.ts`), уже перевірений guard-ом; перед відповіддю API ще раз перевіряє Zod-контракт і сканує весь JSON guard-ом (fail-closed). `409 report_not_ready` (аудит виконується), `503 report_unavailable` (звіту немає або його заблоковано), `404` (аудит не знайдено / завершився помилкою) |
| `GET /api/audits/:id/artifacts/<шлях>` | скриншот/JSON доказу з каталогу **цього** аудиту (`pages/<id>/1440x1000/viewport.png`); лише png/jpg/webp/json, сегменти `[A-Za-z0-9._-]`, без `..`, символічних посилань і прихованих файлів; будь-що інше — `404` |
| `GET /api/audits/:id/evidence/:evidenceId` | один доказ (source_class, artifact_reference, selector_or_region …) |
| `POST /api/audits/:id/artifact-token` | лише коли задано `ACCESS_TOKEN` (потрібна звичайна автентифікація): `{token, expires_at}` — підписаний короткоживучий (600 с) токен `st` **лише** для читання скриншотів цього аудиту; без `ACCESS_TOKEN` → `{token:null}` (DEV-80) |
| `GET /api/audits/:id/artifacts/<шлях>?st=<token>` | те саме, що `artifacts/<шлях>` вище, але з `st` замість заголовка `Authorization` (`<img>` не шле заголовків). `st` діє лише для цього аудиту і лише для `GET /artifacts`; інакше 401 |
| `DELETE /api/audits/:id` | видаляє аудит цілком: рядки БД, задачі черги, каталог артефактів (F3) |
| `GET/PUT /api/settings/ai`, `DELETE /api/settings/ai/key`, `POST /api/settings/ai/check` | BYO AI (розділ «AI-провайдер» нижче): налаштування інсталяції, ключ у відповідях не повертається; `503 ai_settings_unavailable` (файл пошкоджено / немає майстер-ключа) |
| `GET /api/health` | `{ok, db}` (без токена) |
Повтор аудиту того ж URL — це **новий** AuditRun (§55.12); старий не змінюється. Звіт проходить guard (S4) і Zod-контракт перед видачею; без ключа LLM він детермінований (`llm_mode=none`).

## AI-провайдер (BYO AI)
Власник інсталяції підключає власного AI-провайдера; облікових записів немає (налаштування належать інсталяції, мульти-юзер — окреме рішення OQ-3). Провайдери: `none`, `anthropic`, `openai`, `openai_compatible` (свій `base_url`, напр. локальний `http://127.0.0.1:11434` — це явний вибір власника, не ціль аудиту; `userinfo` у URL заборонено), `claude_cli` (локальний `claude` CLI, без ключа).
- **Де зберігається.** Ключ шифрується AES-256-GCM у `data/secrets/ai-settings.enc`; майстер-ключ — `data/secrets/master.key` (створюється з правами 0600 при першому записі) або env `SITELENS_MASTER_KEY` (32 байти: 64 hex або base64). `data/` у `.gitignore`. Втратили майстер-ключ або файл пошкоджено → API відповідає `503` із чітким повідомленням; вихід — задати налаштування знову (`ai-settings.enc` можна видалити). Каталог можна перекрити `SITELENS_SECRETS_DIR`.
- **Пріоритет:** налаштування через UI/API > `.env` (`LLM_PROVIDER`, ключі) > `none`. `.env`-режими `replay`/`session` у цьому екрані відображаються як `none` з `source:"env"` — вони діють, доки нічого не збережено через UI.
- **API** (під `ACCESS_TOKEN`, якщо він увімкнений): `GET /api/settings/ai` → `{kind, model, base_url?, key_set, key_hint?: "…abcd", max_audit_tokens, llm_concurrency, updated_at, last_check?, source}`; `PUT` (`{kind, model?, base_url?, api_key?, max_audit_tokens?, llm_concurrency?}`; пропущений `api_key`/`model` зберігаються з попереднього стану того ж `kind`); `DELETE /api/settings/ai/key`; `POST /api/settings/ai/check` → `{ok, error_class?, latency_ms, model_reported?}` (один дешевий структурований виклик; `error_class` без тексту помилки провайдера: `auth|timeout|rate_limited|network|model_or_endpoint_not_found|provider_not_available|no_key|no_provider|…`). Ключ **ніколи** не повертається, не пишеться в логи, `config_json`, звіти й артефакти.
- **Знімок аудиту.** При створенні аудиту API записує в `audit_runs.config_json.ai` провайдера/модель/`base_url`/ліміт токенів (без ключа), у `llm_mode`/`llm_provider`/`llm_model` — режим і модель; worker працює за знімком. Зміна налаштувань під час аудиту на нього не діє; якщо `kind` у сховищі змінився (ключ іншого провайдера), LLM-етап падає з чіткою помилкою, а не переходить мовчки.
- **Не перевірено (⏭️ живий пас):** реальні виклики Anthropic/OpenAI/`claude_cli`; `openai_compatible` користується OpenAI Responses API (`/v1/responses`) — сумісність конкретного сервера (Ollama тощо) не перевірена.

## Конфіг (`.env`, див. `.env.example`)
| змінна | типово | значення |
|---|---|---|
| `DATABASE_URL`, `EMBEDDED_PG_PORT` | `…@127.0.0.1:54329/sitelens`, `54329` | PostgreSQL. Порт зайнятий чужим процесом → `db:start` відмовляє (чужий не зупиняє) |
| `HOST`, `PORT` | `127.0.0.1`, `3001` | не-loopback `HOST` **лише** з `ACCESS_TOKEN` ≥ 16 символів, інакше API не стартує (G0-5) |
| `ACCESS_TOKEN`, `RATE_LIMIT_PER_HOUR` | порожньо, `20` | задано → `Authorization: Bearer …` або `x-access-token` обов'язкові (401) і діє ліміт аудитів/год (429); лічильник у БД |
| `ARTIFACT_DIR`, `ARTIFACT_TTL_DAYS` | `./data/artifacts`, `30` | скриншоти/JSON у `<ARTIFACT_DIR>/<auditId>/`; worker кожні `TTL_SWEEP_INTERVAL_MS` (типово 10 хв) прибирає прострочені (файли; метадані лишаються) |
| `MAX_PAGES`, `MAX_CRAWL_DEPTH` | `12`, `3` | обмеження crawl (знімок у `audit_runs.config_json`) |
| `LIGHTHOUSE_MAX_PAGES`, `LIGHTHOUSE_FORM_FACTORS`, `LIGHTHOUSE_ENABLED` | `3`, `desktop`, `1` | скільки сторінок і які форм-фактори |
| `CAPTURE_ATTEMPTS` | `2` | спроби для транзієнтних збоїв (timeout, crash) |
| `LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MAX_AUDIT_TOKENS` | порожньо | без ключа — режим `none`: LLM-етапи `skipped`, аудит `completed` (DEV-11). Із ключем/replay LLM-етапи виконуються (пайплайн S3–S4), але якість моделі **не перевірена** (⏭️ живий пас) |
| `LLM_CONCURRENCY` | `3` (`claude-cli` — `2`) | паралельні LLM-виклики (snapshot-сесії), 1–6; у UI `/settings/ai` має пріоритет |
| `LOG_LEVEL` | `info` | рівень логів API; опитування статусу аудиту пишеться лише на `debug` |
| `SITELENS_EXTRA_CA_FILE` | вимкнено | шлях до PEM додаткового CA (лише середовища з TLS-перехопленням, DEV-90) |
| `SITELENS_FIXTURE_MODE`, `SITELENS_FIXTURE_ORIGINS` | вимкнено | лише локальні фікстури/тести |

## Швидкість і прогрес
- **Що показує екран прогресу.** Під активним етапом — лічильник і смуга: сторінки N/≤M (до кінця обходу M = `MAX_PAGES`), Lighthouse N/M, LLM-етапи виконано/заплановано, лінзи N/ціль, синтетичні сесії N/M, подорожі N/M. «≈ N хв лишилось» з'являється лише коли є дані: це середня тривалість уже завершених задач **цього етапу в цьому аудиті** × (лишилось / паралельність). Немає завершених задач — оцінки немає, показується «працює N хв». Усередині одного LLM-виклику (генерація лінз, профіль сайту) прогресу немає — лише 0/N і час, що минув.
- **Паралельність.** `llm_concurrency` (1–6; типово 3, для `claude_cli` — 2) — у `/settings/ai` або `LLM_CONCURRENCY`; діє на snapshot-сесії, береться знімком при створенні аудиту. Більше — швидше, але швидше йдуть токени й ліміти запитів; бюджет `MAX_AUDIT_TOKENS` лишається «м'яким» (DEV-70), а резерв під паралельні задачі стискає перевищення (DEV-92). Реальний виграш швидкості на живій моделі — ⏭️ не перевірений.
- **Швидкий аудит** (`mode: "quick"`, перемикач на лендінгу; `POST /api/audits {"url", "mode":"quick"}`): ≤ 6 сторінок, 6 лінз (мін. 6 замість 8; обов'язкові полюси зберігаються, якщо можливо, інакше `pole_unmet`), ~12 snapshot-сесій, ≤ 2 журнали. У звіті банер «Швидкий аудит: менше покриття». Це компроміс покриття (DEV-93): результати не порівнюються з повним аудитом.
- **Логи API** (`LOG_LEVEL`, типово `info`): один рядок на запит `{method, url, status, ms}` без заголовків; успішні опитування `GET /api/audits/:id` — лише на `debug` (DEV-94).

## Стійкість (SPEC §55.11–13) і що саме перевірено
* Черга — pg-boss у тій самій БД (DEV-1): задачі `crawl_site → capture_page → run_lighthouse / run_accessibility → build_site_profile → generate_tasks → generate_lenses → build_scenario_matrix → aggregate_findings`.
  Кожна ідемпотентна (PK/UNIQUE + маркер у `audit_jobs`), повторюється з backoff, прогрес зберігається; `POST /api/audits` створює аудит і першу задачу в **одній транзакції**.
* **Облік процесів (G0-28):** worker щосотні мілісекунди пише нащадків (Chromium, Chrome Lighthouse) у `data/pids/worker.json` (pid + starttime + comm);
  після `kill -9` наступний старт вбиває **лише записаних**, що ще живі й ті самі (захист від повторного використання PID), і повертає в чергу задачі, що зависли `active`.
  Postgres — окремий демон із `data/pids/postgres.json`. Ніколи `pkill -f`/`killall`; чужі процеси не чіпаються (зокрема чужі Chrome на спільній машині).
* Збій сторінки/Lighthouse → `completed` із `warnings[]`; збій **стартової** сторінки → `failed` з класом і повідомленням (§48). Дванадцять класів: `invalid_url`, `dns_failure`,
  `ssl_failure`, `timeout`, `bot_protection`, `captcha`, `browser_crash`, `page_crash`, `redirect_loop`, `unsupported_site`, `empty_page`, `js_rendering_failure`. При збої захоплення — 0 доказів.
* Артефакти перевірок S2 — `planning/qa/artifacts/sprint-2/` (kill -9 ×3, часткові збої, §48 12/12, повтор, TTL/видалення, SSRF через API, `lsof`, секрети).

## Безпека
* API за замовчуванням лише на `127.0.0.1`. Токен порівнюється за сталий час і не потрапляє в логи (redact).
* SSRF: вхід — `url-guard` (схеми, userinfo, приватні/службові/loopback адреси, IP у нестандартних записах); worker — egress-проксі з pinned IP на **кожен** запит браузера й Lighthouse.
* Ніколи не змінюємо чужий сайт: браузер блокує не-GET/HEAD; краулер не відкриває deny-list URL (кошик, logout, delete…). Лічильник ≤ 5 аудитів на сайт за добу, ≥ 1500 мс між навігаціями, `robots.txt` (на живих сайтах).
* Секрети лише в `.env` (у `.gitignore`) або середовищі; `pnpm s2:secrets` шукає їх у репо й логах (з контролем на підкладеному фейковому ключі).
* Сканери S8 (кожен перевірений на підкладеному позитивному випадку): `pnpm scan:todo` (0 маркерів недоробок у критичному шляху), `pnpm scan:secrets` (0 секретів у репо), `pnpm scan:claims`
  (заборонені формулювання «DoD пройдено», «MVP готовий» тощо у `planning/conclusions/*.md`, `STATE.md`, `dod-72.md`). **Запускати від власника репозиторію, не від `sitelens`** (git «dubious ownership»).
* Скриншоти в UI при `ACCESS_TOKEN`: UI бере підписаний короткоживучий `?st=` (600 с, один аудит, лише `GET /artifacts`; DEV-80) через `POST /api/audits/:id/artifact-token`; сам `ACCESS_TOKEN` у URL не потрапляє, у логах `st=[redacted]`.

## Команди
| | |
|---|---|
| `pnpm run doctor` | перевірка середовища (перший крок після `pnpm install`); `pnpm doctor:as-sitelens` — те саме під root через sitelens |
| `pnpm test` | усі тести (unit + integration + e2e; від не-root: `bash scripts/run-as-sitelens.sh pnpm test`). Кожен DB-тест піднімає власний одноразовий кластер і застосовує міграції з порожньої БД |
| `pnpm validate` | E1–E4 на scripted fake-провайдері (`bash scripts/run-as-sitelens.sh pnpm validate`; PASS і FAIL-контролі) — **не** оцінка моделі |
| `pnpm scan:todo` · `scan:secrets` · `scan:claims` | сканери S8 (від власника репо, див. «Безпека») |
| `pnpm web` · `pnpm web:fixtures` | UI (`:3000`, проксі на API) · UI на записаних звітах без бекенда (dev) |
| `pnpm audit:fixture` · `pnpm audit:live -- <url>` | прогін детекторів на фікстурах · аудит живого сайту зі списку G0-14 (лише з мережею й дозволом) |
| `pnpm typecheck` · `pnpm lint` | tsc · eslint |
| `pnpm s2:scenarios [фаза…]` | сценарії S2 справжніми процесами (потрібен root для `runuser` або запуск від власника): `baseline crawl lighthouse api partial taxonomy repeat ttl ssrf listen`; `SL_WRITE_ARTIFACTS=1` пише доказ у репо |
| `pnpm s2:secrets` · `pnpm s2:summary` | критерій «0 секретів у репо» · зведення критеріїв виходу S2 з артефактів |
| `pnpm db:start\|stop\|status\|migrate` | керування локальним PostgreSQL |

## Known limitations
* **Середовище з TLS-перехопленням (DEV-90):** `SITELENS_EXTRA_CA_FILE=/path/ca.pem` (необов'язково, типово вимкнено) додає довіру ЛИШЕ до ключів сертифікатів із файлу (`--ignore-certificate-errors-spki-list`); перевірка TLS не вимикається. Прямий вихід egress-проксі в хмарному середовищі додатково обмежений allowlist-ом шлюзу (`403 host_not_allowed`) — живі сайти там можливі лише через дозволений шлях; не виправлено.
* **Живі сайти — ⏭️ не перевірено** (мережа середовища розробки закрита). Усе перевірено на фікстурах; поведінка проти реального Cloudflare, редіректів, CDN — невідома до живого пасу (S1b-live / S7).
* **LLM — ⏭️**: без ключа етапи `skipped`. Виходи етапів (профіль, задачі, лінзи, сценарії, snapshot-сесії) зберігаються в БД і проходять весь конвеєр до звіту на scripted fake / replay (плумбінг доведено), але **якість моделі не перевірялась**; тексти знахідок від LLM (finding-aggregator-v1 → recommendation-v1) підключено на шляху worker (DEV-98: до 12 груп у порядку рангу, бюджет E4, таблиця `finding_texts`); без тексту моделі — заголовок зі спостереження лінзи чи цитати сайту й дія за категорією, а не загальний шаблон; журнали (`run_browser_scenario`) виконує `packages/browser` (`runJourney`) з кодовим фільтром дій G0-11 — на фікстурі 0 не-GET і 0 deny-list; рішення агента без моделі — scripted fake.
* Токени (`MAX_AUDIT_TOKENS`): ліміт «м'який» при паралельних snapshot-сценаріях — кожна задача бачить залишок на момент свого старту (до 4 задач одночасно); перевищення обмежене кількома викликами (DEV-70).
* **Report guard — ❌ на запечатаному held-out (S4):** лексичний guard 41/52 (78,8 %), разом зі структурним правилом чисел 44/52 (84,6 %) при порозі 90 %; дозволені 44/48. Основний захист — структурний: у LLM-текстах звіту заборонені цифри й числівники, числа лише з доказів через шаблон коду (DEV-58/62); з DEV-98 цифри моделі маскуються «…», а речення з числівником-словом чи % видаляється (а не весь текст). Не ловляться риторичні твердження без чисел («продажі суттєво зростуть»-подібні перефразування). Поріг 90 % перевіряється на реальних текстах моделі в живому пасі.
* **Скриншоти при `ACCESS_TOKEN`** показуються через `?st=` на 10 хв (DEV-80); URL зі `st` дає лише читання скриншотів одного аудиту й може лишитись у історії браузера до кінця TTL токена.
* **Ізоляція браузера — лише пісочниця Chromium, без контейнера (DEV-13).** Вихід із рендерера не стримується межею контейнера. Для публічного розгортання потрібні container egress-правила (⏭️ deployment pass).
* **Service Worker / SharedWorker lockdown залежить від init-скриптів Playwright** (DEV-48/50): новий тип JS-контексту, у який init-script не потрапляє, — потенційний обхід шару «не-GET»; після оновлення Playwright — прогнати `worker-bypass.test.ts`.
* `dns-prefetch`/`preconnect`: витік імен через DNS не спостерігався (`ssrf-vectors` v37/v38), але лишається відомим потенційним. IPv6 наскрізно не перевірено (у середовищі розробки IPv6 немає).
* Exposed-режим (`HOST≠loopback`) з UI і токеном у справжньому браузері не проганявся; перевірено API + loopback-UI.
* **Experiments (варіанти A/B, сліпе порівняння) — S6**, у UI лише заглушка. **en-звіт із LLM-вкладками** не перевірено (немає en-фікстури LLM, DEV-66); en у режимі `llm_mode=none` — перевірено.
* **Chromium ставиться через CDN Playwright:** у мережі без доступу до нього `playwright install` не завершується (див. «Швидкий старт»); перевірено лише з наперед встановленим `/opt/pw-browsers` (DEV-23).
* Живі публічні сайти через UI — ⏭️ (мережа середовища розробки закрита): `pnpm audit:live` і живий прогін із чистої інсталяції — на машині з мережею.
* `infra/docker-compose.yml` — **UNVERIFIED: ніколи не запускався** (немає Docker); лише PostgreSQL. Основний шлях — embedded-postgres.
* embedded-postgres — лише beta-збірки на npm (DEV-10), закріплено `18.4.0-beta.17`; підтримано linux-x64 і darwin-arm64. **macOS не перевірено**: облік процесів спирається на `/proc` (Linux), на macOS перевірка `starttime` і обхід нащадків — неперевірені.
* Знімок нащадків у PID-файл робиться кожні ~100 мс: процес, що з'явився й пережив смерть worker за менший інтервал, не буде записаний (для Playwright Chromium це не важливо: він виходить сам, коли закривається канал; для Chrome Lighthouse — записується за секунди).
* Одночасно — один worker (PID-файл відмовляє другому). Масштабування на кілька worker — не в обсязі.
* Видалення аудиту під час його виконання: задачі, що вже пишуть, можуть створити порожній каталог артефактів (прибирається наступним видаленням/TTL).
* Lighthouse-докази (`claim_kind=lighthouse_category_score`) — опорні факти (ET-SUP): проходять Zod `Evidence` (DEV-68), але самі знахідок не створюють (severity від LCP/TBT для них ще не підключено).
