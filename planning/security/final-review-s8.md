# Фінальний огляд безпеки S8

sl-security, 30.09.2026. Усе нижче — прогнано в цій сесії (браузерні — від `sitelens`); «unverified» названо окремо.

| Перевірка | Результат | Артефакт |
|---|---|---|
| SSRF-набір S1b: `ssrf-vectors` (R0 контроль → R1/R2 = 0 звернень до канарки; R3/R4 контролі проходять), SW-1 | 11/11 тестів | `packages/browser/test/ssrf-vectors.test.ts`, `planning/security/ssrf-vectors.md` |
| Не-GET із Worker/SharedWorker (13 варіантів; raw і «стара конфігурація» доходять, SecureBrowser 0) | 4/4 | `worker-bypass.test.ts` |
| Класифікатор IP, проксі (pinned IP, ліміти, peer-check 407, SITE_DENYLIST) | 129 + 6 + 10 тестів | `net-classify`, `net-proxy`, `net-proxy-limits` |
| Lighthouse за проксі: канарка 0 (контролі без проксі / без `<-loopback>` = 9), CDP-guard 0 не-GET (контроль без guard = 7) | 8/8 | `lighthouse.test.ts` |
| Пісочниця Chromium: без `--no-sandbox`/`--disable-setuid-sandbox` у коді (grep `src` = 0; збіги лише в `doctor`/spikes як `chromiumSandbox:true`), env-білий список, seccomp активна, 0 секретів у environ | `secure-browser.test.ts` 5/5; контроль: 3/3 секрети в environ у дефолтному запуску | `secure-browser.test.ts` |
| api/web лише 127.0.0.1: `next dev/start -H 127.0.0.1`; API `HOST=127.0.0.1`; не-loopback без токена → exit 3; з токеном `lsof` показує не-loopback (контроль вміє показати ненуль) | ✅ (S2, не перезапускалось) | `planning/qa/artifacts/sprint-2/listen.json`; `api.test.ts`, `config.test.ts` |
| ACCESS_TOKEN (401 без/із хибним; порівняння за сталий час) + ліміт 20/год і ≤ 5/сайт/добу (429, лічильник у БД) | 107 тестів `apps/api` + `pipeline/config` | `apps/api/test/api.test.ts` |
| Ретеншн: TTL-sweep, `DELETE` (файли + БД + черга) з негативними контролями; path traversal/symlink → 404 (наївна реалізація витікає) | ✅ | `packages/pipeline/test/artifacts.test.ts`, `apps/api/test/report.test.ts` |
| **Скриншоти в UI при ACCESS_TOKEN — виправлено (DEV-80)**: підписаний `?st=`, 10 хв, один аудит, лише GET `/artifacts` | api-тест (401 у 11 випадках + контроль) і Chromium e2e (усі thumb-и `naturalWidth>0`; контроль прямий GET = 401; мутація «токен не збережено» валить тест) | `api.test.ts`, `apps/worker/test/web-api-token.e2e.test.ts`, DEV-80 |
| Секрети в логах: токен і `st` не в логах API (контроль: лог непорожній, `st=[redacted]`); канарка в `data/` і артефактах 0; бандл web: лише `NEXT_PUBLIC_SITELENS_SOURCE` | ✅ | `api.test.ts`, `scan-secrets` |
| `scripts/scan-secrets.ts`: дерево (10 збігів, усі пояснені) + історія 70 комітів `git log -p` (10 доданих збігів, усі пояснені); `.env` в історії 0, ignored | 0 непояснених; тест: 7 патернів мають позитивний випадок, ключ, доданий і видалений у справжньому git-репо, знайдено | `scripts/scan-secrets.test.ts` |
| `scripts/scan-todo.ts`: 4 маркери у `packages/*/src`, `apps/*/src`, `scripts` (без тестів), 221 файл | 0, allowlist порожній; тест: 4 слова, .sh/.tsx, allowlist, реальне дерево | `scripts/scan-todo.test.ts` |
| `scripts/scan-claims.ts` (G0-17): uk/en фрази в `conclusions/*.md`, `STATE.md`, `dod-72.md`, `README.md` | 0; 15 підкладених фраз знайдено, кожне з 8 правил має позитив, формула `N ✅ / M ⏭️` і цитата заборони проходять | `scripts/scan-claims.test.ts` |
| typecheck, lint | чисто | — |

Запуск сканерів: `pnpm scan:todo`, `pnpm scan:secrets`, `pnpm scan:claims` (код виходу 1 при знахідках). Сканери не читають `planning/sealed/`.

## Не перевірено (unverified) і що перевірить
* Живі сайти й живий HTTPS (Cloudflare, CDN, CDP-guard на HTTPS): S1b-live на машині з мережею.
* IPv6 наскрізно: у контейнері немає IPv6; доведено лише класифікатором і логом проксі.
* macOS: peer-check проксі (`/proc`) недоступний → проксі відкритий локальним процесам (лише публічні IP); облік процесів неперевірений.
* Контейнерні egress-правила/DNS контейнера: deployment pass. `infra/docker-compose.yml` ніколи не запускався.
* Стійкість живої моделі до prompt injection: ⏭️ live pass (replay доводить код, не модель).
* Exposed-режим (`HOST≠loopback`) з UI і токеном у справжньому браузері не проганявся; перевірено API + loopback-UI.

## Текст для README «Known limitations» (безпека)
* **Ізоляція браузера — лише пісочниця Chromium, без контейнера (DEV-13).** Вихід із рендерера не стримується межею контейнера. Для публічного розгортання потрібні container egress-правила (⏭️ deployment pass). `infra/docker-compose.yml` — UNVERIFIED (немає Docker).
* **Service Worker / SharedWorker lockdown залежить від init-скриптів Playwright** (DEV-48/50): новий тип JS-контексту, у який init-script не потрапляє, — потенційний обхід шару «не-GET». Тест SW-1 спирається на експериментальний прапорець Playwright і впаде при оновленні; кожен новий тип контексту → прогнати `worker-bypass.test.ts`.
* **`dns-prefetch`/`preconnect`**: витік імен через DNS не спостерігався (`ssrf-vectors` v37/v38), але лишається відомим потенційним.
* **IPv6 наскрізно не перевірено** (немає IPv6 у середовищі розробки); доведено лише класифікатор адрес і лог проксі.
* **Живі сайти не перевірено (S1b-live):** усі SSRF-докази — на фікстурах і локальних канарках; живий HTTPS під Lighthouse CDP-guard — ⏭️.
* **macOS:** проксі без peer-check (лише токен `Proxy-Authorization` відсутній) — відкритий локальним процесам, лише для публічних IP.
* **Скриншоти при `ACCESS_TOKEN`** показуються через `?st=` на 10 хв (DEV-80); URL зі `st` дає лише читання скриншотів одного аудиту й може лишитись у історії браузера до кінця TTL токена.
