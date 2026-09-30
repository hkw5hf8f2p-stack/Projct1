# Threat model — SiteLens (S1b)

sl-security, 30.09.2026. Деталі: `ssrf-core.md` (S1a), `ssrf-vectors.md` (S1b). Тести — `packages/browser/test/`.
Правило: кожна мітигація має тест, показаний і на контролі (вміє впасти). Без тесту — «unverified».

**Активи:** внутрішня мережа й cloud metadata; localhost-сервіси worker (БД, API, DevTools); стан чужих сайтів; секрети
(ключі LLM, `DATABASE_URL`, `ACCESS_TOKEN`); гроші на LLM; артефакти зі сторонніми даними.
**Атакувальник:** користувач із довільним URL; вміст сторінки (JS, редиректи, DNS, prompt injection); локальний процес на хості.

| # | Загроза | Мітигація | Тест (контроль) |
|---|---|---|---|
| T-1 | SSRF з підресурсів/навігацій (img, iframe, fetch, XHR, CSS, prefetch, meta-refresh, `location=`, popup, Worker, EventSource, script/object) | egress-проксі — єдиний вихід Chromium; рішення за **усіма** A/AAAA; TCP до перевіреної IP | `ssrf-vectors.test.ts` R1/R2 = 0 (R0 = 40) |
| T-2 | Обхід через кодування адрес (десяткові/вісімкові/hex, mapped/NAT64/6to4, `0.0.0.0`, гомогліфи, повноширинні, zone-id) | `ip-classify.ts` + канонізація; проксі класифікує IP, а не рядок | `net-classify.test.ts` (наївний фільтр пропускає 59/81); `ssrf-vectors` v02–v11, P-3 |
| T-3 | DNS rebinding / TOCTOU / змішані записи | резолв 1 раз на з'єднання в проксі, перевірка всіх адрес, `dial(ip)` | `net-proxy.test.ts`; `ssrf-vectors` v40–v45 (контроль R4 — наївний проксі: 3 звернення) |
| T-4 | Chromium обходить проксі для loopback/link-local | `--proxy-bypass-list=<-loopback>` | S1a канарка (в); `ssrf-vectors` R3 = 30 звернень без прапорця |
| T-5 | Редиректи 30x на приватну адресу | браузер робить новий запит → знову проксі | `ssrf-vectors` v28–v31, v52b |
| T-6 | WebRTC/STUN (UDP повз HTTP-проксі) | `disable_non_proxied_udp`, `--disable-quic` | `ssrf-vectors` v36: R0 = 4 STUN, R1/R2 = 0 |
| T-7 | Зміна стану цілі (POST/PUT, beacon, `<a ping>`, форми, WS) | шар 2: не-GET/HEAD → abort; WS → close; deny-list URL дій | `secure-browser.test.ts` (контроль без шару 2: 6 не-GET дійшли); `ssrf-vectors` v24/v25/v27 |
| T-7b | Service Worker в обхід блоку Playwright → POST із SW (**SW-1**) | init-script на прототипі + мережа SW через шар 2 + abort `Service-Worker: script` (DEV-48) | `ssrf-vectors` SW-1 (контроль — стара конфігурація: 2 POST дійшли) |
| T-8 | Інший локальний процес ходить через проксі | peer-check `/proc` (власник сокета — нащадок worker) або токен `Proxy-Authorization`; без `/proc` (macOS) — open з попередженням `authWarning` | `net-proxy-limits.test.ts` (сторонній → 407; контроль `open` → 200). **Залишок:** macOS без peer-check |
| T-9 | DoS/вичерпання через проксі (великі відповіді, повільні з'єднання, флуд) | ліміти: з'єднання 128, 50 МБ, 120 с, простій 30 с, заголовки 10 с, connect 10 с | `net-proxy-limits.test.ts` (контроль — великий ліміт пропускає) |
| T-10 | Lighthouse як обхідний шлях (A4) | chrome-launcher з `CHROME_PATH` = Chromium Playwright, ті самі прапорці, env — білий список, без `--disable-setuid-sandbox` | `lighthouse.test.ts`: канарка 0 (без проксі 9, без `<-loopback>` 9); дефолтний chrome-launcher: 2/2 секрети в env |
| T-11 | Збій Lighthouse валить аудит | ізоляція: виняток/зависання/поганий шлях → `ok:false`, Chrome прибрано | `lighthouse.test.ts` «ізоляція збою» (захоплення паралельно — 3 Evidence) |
| T-12 | Вихід із рендерера, крадіжка секретів процесу браузера | пісочниця без фолбеку (DEV-13, DEV-25), env-білий список, тимчасові HOME/профіль, `acceptDownloads:false` | `secure-browser.test.ts` (контроль: 3/3 секрети в environ, `--no-sandbox`) |
| T-13 | Візит сайту §66 / чужого сайту без дозволу | `SITE_DENYLIST` (env, хост або sha256) у preflight **і** у проксі на кожне з'єднання; список `live-dev-sites.md` | `net-proxy-limits.test.ts` (`isSiteDenied`, проксі до резолву; контроль — без списку 200); `live-preflight.test.ts` |
| T-14 | Етика: частота, robots.txt, бот-захист | DEV-18/DEV-43/DEV-42 (sl-core-engineer) | `ethics.test.ts` |
| T-15 | Prompt injection із вмісту сторінки → дії агента | агент бачить лише GET-навігацію й deny-list дій; вміст сторінки = дані, не команди | ⏭️ S3 (фікстура з ін'єкцією) |
| T-16 | DNS-витік імен (`dns-prefetch`/`preconnect`) | Chromium із проксі не резолвить (netlog: 0 DNS-запитів) | `ssrf-vectors` v37/v38 — **відомий потенційний витік**, не спостерігався; контроль img → DNS-запит |
| T-17 | Секрети в репо/логах/артефактах/бандлі | `.env` у gitignore; лог проксі без заголовків; хеш замість імені в SITE_DENYLIST | частково: env-тести T-12; сканер секретів — ⏭️ S2 |
| T-18 | Публічне розгортання без автентифікації, витрати LLM | MVP bind 127.0.0.1; `ACCESS_TOKEN` + ліміт аудитів/год (B2) | ⏭️ S2/S5 (API) |
| T-19 | Артефакти з персональними даними третіх осіб | видалення, TTL 30 днів | ⏭️ S2 (сховище) |

**Залишкові ризики (прийняті або відкладені):**
1. Lighthouse не блокує метод і SW (DEV-12): лише одна URL, пасивно; шар 1 діє.
2. SW-блок спирається на `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS` — тест SW-1 впаде при оновленні Playwright.
3. IPv6 не перевірено наскрізно (у контейнері немає IPv6); доказ — класифікатор і лог проксі.
4. Контейнерні egress-правила, DNS контейнера — ⏭️ deployment pass (L9). Живі сайти — ⏭️ (мережа закрита, 403).
5. macOS: peer-check недоступний → проксі відкритий для локальних процесів (лише публічні IP — не ескалація SSRF).
