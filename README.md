# SiteLens

Evidence-backed AI-діагностика конверсії сайтів із синтетичними behavioral lenses. Повна специфікація — `docs/SOURCE/SPEC.md`; рішення, що мають
пріоритет над нею, — `planning/DEVIATION_LOG.md`, `docs/SPEC_REVIEW_UK.md`. Стан проєкту — `planning/STATE.md`.

**Що працює зараз (README v0, після спринту S2):** ви подаєте URL → стійкий конвеєр (черга в PostgreSQL) обходить сайт (≤ 12 сторінок), знімає
desktop 1440×1000 і mobile 390×844, запускає Lighthouse (через egress-проксі), axe і детермінований набір детекторів, зберігає **докази** (Evidence) у БД
і скриншоти на диск. Аудит переживає `kill -9` worker/API, частковий збій сторінки чи Lighthouse не валить аудит, а збій захоплення — це чесна помилка,
а не «аналіз». **Чого ще немає:** UI, звіт, синтетичні сесії, LLM-якість (див. «Known limitations»).

## Вимоги
| що | версія / примітка |
|---|---|
| Node.js | ≥ 22.19 (перевірено 22.22.2) |
| pnpm | 10.33.0 (`packageManager` у `package.json`; `corepack enable`) |
| ОС | Linux x64 або macOS arm64 (бінарники PostgreSQL з npm). Docker **не потрібен** (DEV-2) |
| Браузер | Playwright Chromium — окремий крок нижче |
| Мережа | лише для `pnpm install`, завантаження Chromium і живих сайтів. Тести й фікстури працюють офлайн |

## Швидкий старт (чиста машина)
```bash
pnpm install                          # пакети; postinstall для esbuild і @embedded-postgres/* дозволено в pnpm-workspace.yaml
pnpm exec playwright install chromium # браузер (Playwright 1.56.1); у Linux-контейнері з общим /opt/pw-browsers — виконайте від root (там це no-op)
cp .env.example .env                  # усе за замовчуванням працює; секретів у файлі немає
pnpm db:start                         # embedded PostgreSQL як демон: дані data/pg, порт 54329, PID у data/pids/postgres.json
pnpm db:migrate                       # forward-only міграції 001 + 002
pnpm api                              # термінал 1: API на http://127.0.0.1:3001
pnpm worker                           # термінал 2: worker (pg-boss) — обходить і знімає сторінки
```
**Перевірено 30.09.2026** у Linux-контейнері на копії робочого дерева (не `git clone`: робота ще не закомічена): `pnpm install` (10,6 с) → `cp .env.example .env` → `db:start` → `db:migrate` → `pnpm fixtures`/`api`/`worker` →
`POST /api/audits` на фікстуру → `completed` (4 сторінки, 3 прогони Lighthouse, докази доступні через `/pages` і `/evidence/…`). Не перевірено: macOS; `playwright install` із нуля з мережі (Chromium уже був у `/opt/pw-browsers`; під `sitelens` цей крок дає EACCES на root-власний каталог — див. вище).

Подати сайт і дочекатись результату:
```bash
curl -s -X POST http://127.0.0.1:3001/api/audits -H 'content-type: application/json' -d '{"url":"https://example.com"}'
# → {"auditId":"aud_…"}   (202 Accepted)
curl -s http://127.0.0.1:3001/api/audits/aud_…          # статус, етапи, попередження, помилка
curl -s http://127.0.0.1:3001/api/audits/aud_…/pages    # сторінки (+ збійні з класом помилки)
curl -s http://127.0.0.1:3001/api/audits/aud_…/evidence/ev_…
```
**Без інтернету / на локальних фікстурах** (fixture-режим послаблює SSRF-захист лише для явно перелічених origin-ів; заборонений при `NODE_ENV=production`):
```bash
export SITELENS_FIXTURE_MODE=1 SITELENS_FIXTURE_ORIGINS=http://127.0.0.1:4210,http://127.0.0.1:4213
pnpm fixtures                         # окремий термінал: shop :4210, shop-clean :4211, bot :4212, errors :4213 (HTTPS :4214)
# перезапустіть pnpm api і pnpm worker з тими самими змінними, тоді:
curl -s -X POST http://127.0.0.1:3001/api/audits -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:4210/"}'
```
**Linux у контейнері під root.** Postgres і Chromium-пісочниця не стартують під root (DEV-13/25). Запускайте кожну команду через
`bash scripts/run-as-sitelens.sh pnpm …` (створює користувача `sitelens`, віддає йому `data/`, очищає env). Змінні, що мають дійти до процесу,
перелічіть у `SL_PASS_VARS="A B"`. Приклад: `SL_PASS_VARS="SITELENS_FIXTURE_MODE SITELENS_FIXTURE_ORIGINS" bash scripts/run-as-sitelens.sh pnpm worker`.

Зупинка: `Ctrl+C` для api/worker (штатно вбиває власні дочірні процеси); `pnpm db:stop` зупиняє лише наш кластер.

## API (SPEC §42)
| метод і шлях | відповідь |
|---|---|
| `POST /api/audits` `{"url", "language"?: "uk"\|"en"}` | `202 {auditId}`; `400` (клас `invalid_url` + пояснення); `401`; `429` (ліміт) |
| `GET /api/audits/:id` | статус (`queued → crawling → profiling → generating_lenses → running_scenarios → aggregating → completed \| failed`), `stage_status` кожного етапу, `progress`, `warnings[]`, `error {class, message}` |
| `GET /api/audits/:id/pages` | сторінки: тип, скриншоти, `capture_ok`, `capture_error {class, message}`, `egress_denied[]` (що заблокував SSRF-шар), `evidence_count` |
| `GET /api/audits/:id/evidence/:evidenceId` | один доказ (source_class, artifact_reference, selector_or_region …) |
| `DELETE /api/audits/:id` | видаляє аудит цілком: рядки БД, задачі черги, каталог артефактів (F3) |
| `GET /api/health` | `{ok, db}` (без токена) |
Повтор аудиту того ж URL — це **новий** AuditRun (§55.12); старий не змінюється. Відповіді S2 не містять LLM-тексту; guard звіту підключається в S4.

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
| `LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MAX_AUDIT_TOKENS` | порожньо | без ключа — режим `none`: LLM-етапи `skipped`, аудит `completed` (DEV-11). У S2 модель не викликається навіть із ключем |
| `SITELENS_FIXTURE_MODE`, `SITELENS_FIXTURE_ORIGINS` | вимкнено | лише локальні фікстури/тести |

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

## Команди
| | |
|---|---|
| `pnpm test` | усі тести (від не-root; `bash scripts/run-as-sitelens.sh pnpm test`). Кожен DB-тест піднімає власний одноразовий кластер і застосовує міграції з порожньої БД |
| `pnpm typecheck` · `pnpm lint` | tsc · eslint |
| `pnpm s2:scenarios [фаза…]` | сценарії S2 справжніми процесами (потрібен root для `runuser` або запуск від власника): `baseline crawl lighthouse api partial taxonomy repeat ttl ssrf listen`; `SL_WRITE_ARTIFACTS=1` пише доказ у репо |
| `pnpm s2:secrets` · `pnpm s2:summary` | критерій «0 секретів у репо» · зведення критеріїв виходу S2 з артефактів |
| `pnpm db:start\|stop\|status\|migrate` | керування локальним PostgreSQL |

## Known limitations
* **Живі сайти — ⏭️ не перевірено** (мережа середовища розробки закрита). Усе перевірено на фікстурах; поведінка проти реального Cloudflare, редіректів, CDN — невідома до живого пасу (S1b-live / S7).
* **LLM — ⏭️**: без ключа етапи `skipped`; збереження виходів етапів (профіль, задачі, лінзи) підключає S4. Якість моделі не перевірялась.
* `infra/docker-compose.yml` — **UNVERIFIED: ніколи не запускався** (немає Docker); лише PostgreSQL. Основний шлях — embedded-postgres.
* embedded-postgres — лише beta-збірки на npm (DEV-10), закріплено `18.4.0-beta.17`; підтримано linux-x64 і darwin-arm64. **macOS не перевірено**: облік процесів спирається на `/proc` (Linux), на macOS перевірка `starttime` і обхід нащадків — неперевірені.
* Знімок нащадків у PID-файл робиться кожні ~100 мс: процес, що з'явився й пережив смерть worker за менший інтервал, не буде записаний (для Playwright Chromium це не важливо: він виходить сам, коли закривається канал; для Chrome Lighthouse — записується за секунди).
* Одночасно — один worker (PID-файл відмовляє другому). Масштабування на кілька worker — не в обсязі.
* Видалення аудиту під час його виконання: задачі, що вже пишуть, можуть створити порожній каталог артефактів (прибирається наступним видаленням/TTL).
* Lighthouse-докази мають `claim_kind=lighthouse_category_score` — узгодження зі схемою `Evidence` ще не закрито (див. звіт S2).
