# SSRF-ядро, пісочниця й середовище браузера — S1a крок 3

Автор: sl-security, 29.09.2026. Рішення: G0-3, G0-4, G0-11; відхилення DEV-8, DEV-12, DEV-13, DEV-25.
Артефакти: `planning/qa/artifacts/sprint-1a/canary/` (JSON кожного сценарію + `vitest-ssrf.log`).

## Модель загроз (коротко)

SiteLens відкриває в справжньому Chromium довільний URL користувача. Сторінка (або користувач, або prompt injection)
контролює, куди браузер піде далі: підресурси, iframe, fetch/XHR/beacon, редиректи, popup, WebSocket, DNS-імена, що
резолвляться в приватні адреси (rebinding). Цілі атакувальника: (1) внутрішні сервіси й cloud metadata
(`169.254.169.254`, `metadata.google.internal`, `fd00:ec2::254`, `100.100.100.200`, `168.63.129.16`); (2) localhost-сервіси
самого worker (БД, API, Chromium DevTools); (3) зміна стану чужого сайту (POST/PUT/DELETE, GET-дії); (4) крадіжка
секретів із середовища процесу браузера після його компрометації; (5) вихід із рендерера (пісочниця).

Захист у два шари (DEV-8): **шар 1** — egress-проксі бачить кожне TCP-з'єднання і вирішує за IP; **шар 2** —
`context.route` бачить метод і тип запиту (проксі в HTTPS CONNECT методу не бачить). Шари не дублюють один одного.

## Що покрито в S1a (код і тест, що вміє впасти)

| Механізм | Код | Доказ (PASS) | Контроль «вміє впасти» |
|---|---|---|---|
| Класифікатор IP: §49 + B1 + IANA special-purpose; IPv6 лише 2000::/3 мінус спецмережі; mapped/NAT64/6to4/Teredo/IPv4-compatible — блок із назвою вбудованої IPv4; Azure `168.63.129.16` | `packages/browser/src/net/ip-classify.ts` | `net-classify.test.ts`: 62 заблоковані адреси з точним CIDR, 15 публічних на межах діапазонів — дозволені | наївний префіксний фільтр §49 пропускає 59 з 81 вектора, наш — 0 |
| Числові записи IPv4 (десяткові, вісімкові, hex, скорочені, змішані, кінцева крапка) і правило WHATWG «ends in a number» | `parseIPv4Loose`, `classifyIpLiteral` | 19 записів → канонічна IPv4 → блок; `256.0.0.1`, `0x1g.0.0.1`, `4294967296` не проходять як ім'я | — |
| Нормалізація URL: лише http/https, userinfo заборонено, IDN → punycode, повноширинні цифри, дефолтні порти, metadata-імена й зони `.localhost/.internal/.local`, однокомпонентні імена | `net/url-guard.ts` `normalizeTargetUrl` | `net-classify.test.ts` | — |
| Deny-list URL дій (G0-11): `add-to-cart` (query/шлях), `/cart/add`, `checkout`, `logout/sign-out`, `delete/remove`, `unsubscribe`, `wp-admin`, `wp-login.php`, `?action=`; текст елементів EN+UK | `isDeniedActionUrl`, `isDeniedActionText` | 15 deny + 7 allow (вкл. `/blog/checkout-tips-guide`, `/cart`) | allow-кейси доводять, що фільтр не «блокує все» |
| Egress-проксі: резолв рівно 1 раз → перевірка **всіх** A/AAAA → TCP до перевіреної IP (`dial(ip)`, без повторного резолву); CONNECT і plain HTTP; IP-літерали й metadata-імена — без резолву | `net/egress-proxy.ts` | `net-proxy.test.ts` (6 тестів) | rebinding-резолвер: наївне «перевір, потім підключись за ім'ям» пішло б на 127.0.0.1 (FAIL), проксі — 1 резолв, TCP до 93.184.216.34; «лише перша адреса» пропустила б `[публічна, 10.0.0.1]` |
| Режими: `prod` блокує loopback/private для всього; `fixture` — лише з явним прапорцем (`allowFixtureLoopback:true` або env `SITELENS_FIXTURE_MODE=1`; без нього — виняток) + явний allow-list `host:port` лише loopback, заборонений при `NODE_ENV=production`, порожній allow-list — помилка | `startEgressProxy`, `secureLaunch` | fixture: дозволено рівно `127.0.0.1:PORT` (і `2130706433:PORT` — та сама IP), `PORT+1` і `127.0.0.2` — 403; prod на тому самому URL — 403 | allow-list з `10.0.0.1:80` → виняток |
| Прапорці Chromium: `--proxy-server`, `--proxy-bypass-list=<-loopback>`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (+ `--webrtc-ip-handling-policy`), `--disable-quic`. Playwright-опцію `proxy` свідомо не використовуємо (вона сама дописує bypass-правила) | `secure-launch.ts` `secureChromiumArgs` | канарка (б) | канарка (в) |
| Шар 2: не-GET/HEAD → `route.abort` + лог; `routeWebSocket` → close(1008) + лог; `serviceWorkers:'block'`, `acceptDownloads:false`, `permissions:[]`; `newContext` відмовляє на `acceptDownloads:true`, `serviceWorkers:'allow'`, `proxy` | `applyContextGuards`, `SecureBrowser.newContext` | не-GET: сервер 0 не-GET, 0 WS-upgrade; лог блоків по 1 на кожну з 6 спроб + 1 WS | той самий проксі, контекст без шару 2 → сервер отримав 6 не-GET і WS upgrade |
| Пісочниця (DEV-13): `chromiumSandbox:true`, інваріант перед launch, без фолбеку; env — білий список (`PATH, LANG, LC_ALL, TZ`) + тимчасові `HOME/TMPDIR/XDG_*`; тимчасовий профіль Playwright | `buildBrowserEnv`, `buildLaunchOptions`, `secureLaunch` | 0 фейкових секретів у `/proc/<pid>/environ` усіх 7 процесів дерева; ключі env лише з білого списку; 0 `--no-sandbox`; renderer під seccomp-bpf (`Seccomp: 2`) | звичайний `chromium.launch` без env і без пісочниці: 3/3 фейкові секрети в environ, `--no-sandbox` у кожному процесі, 0 renderer під seccomp |

### Канарка `127.0.0.2:4199` (сторінка: img, css, iframe, iframe→302, fetch, decimal-IP img, mapped-IPv6 fetch, popup, fetch metadata IP/ім'я, iframe→302→10.0.0.1)

| Сценарій | Звернень до канарки | Рішення проксі | Файл |
|---|---|---|---|
| (а) без проксі (той самий Chromium, контекст із шаром 2) | **7** (`/img /css /decimal-img /iframe /fetch /redirect /popup`) | — | `a-control-no-proxy.json` |
| (б) prod-режим, `attacker.test` → мок-резолвер → 93.184.216.34 | **0** | 11 deny, 3 allow (сама сторінка й 2 її редиректи) | `b-prod-proxy.json` |
| (б2) fixture-режим, allow-list лише origin сторінки | **0** | 11 deny, 3 allow | `b2-fixture-proxy.json` |
| (в) проксі є, `<-loopback>` прибрано | **7** — жодне звернення до `127.0.0.2` не дійшло до проксі | 2 deny, 3 allow | `c-control-no-loopback-flag.json` |

Знахідка з (в): без `<-loopback>` Chromium обходить проксі не лише для loopback, а й для **link-local** —
`169.254.169.254` у (в) у лозі проксі відсутній (пішов напряму), у (б) — deny. Тобто прапорець закриває і cloud metadata.

«Симульований інтернет» у (б)/(в): ін'єктований дайлер з'єднує з локальною сторінкою атакувальника лише IP
93.184.216.34; будь-яку іншу IP він набирає по-справжньому. Якби проксі пропустив `127.0.0.2`, канарка отримала б запит.

### Інтеграція

`captureSlice` (крок 2) без переданого `browser` тепер запускає Chromium через `secureLaunch({mode:'fixture',
fixtureOrigins:[origin URL]})` і створює контексти через `secure.newContext` (тест: ті самі 3 Evidence на
`fixtures/slice/defective.html`, сервер фікстури — лише GET/HEAD). **Обхід закрито (S1a-fix, п.9):**
`captureSlice`, `auditSite`, `captureViewport` приймають лише `SecureBrowser` — branded type (`unique symbol`; сирий `Browser` —
помилка типу, `@ts-expect-error` у тестах) і runtime-перевірка `assertSecureBrowser` (WeakSet об'єктів, виданих `secureLaunch`;
структурна підробка теж відхиляється). `captureSlice` більше не запускає браузер сам і не закриває чужий.

## Що лишається на S1b (і пізніше)

1. **Lighthouse через проксі** (A4, DEV-8): `CHROME_PATH` Playwright-Chromium, ті самі `secureChromiumArgs`, env із
   `buildBrowserEnv`, `chromiumSandbox`-еквівалент (без `--no-sandbox` у `chromeFlags`); канарка (а/б/в) для Lighthouse.
   Метод-виняток Lighthouse (DEV-12) — задокументувати в THREAT_MODEL.
2. **DNS rebinding набір ≥ 25 векторів** через ін'єкцію резолвера: TTL-0 чергування, змішані A/AAAA у різних
   порядках, CNAME на `localhost`, `*.nip.io`/`*.sslip.io`-подібні імена з IP у назві, `0.0.0.0` і `[::]`, AAAA-only
   приватні, rebinding між редиректами, повторні з'єднання keep-alive/HTTP2-coalescing, IPv6 zone id, trailing dot,
   мікс регістру, IDN-гомогліфи `localhost`, тощо.
3. Вектори G0-3, не покриті тут: **WebRTC STUN** (тест із локальним STUN-слухачем), **`dns-prefetch`/preconnect**
   (відомий DNS-витік: резолв через системний DNS до проксі — не SSRF-з'єднання, але витік імені), `<a ping>`,
   `navigator.sendBeacon` поза `context.route` (у S1a перехоплюється — доказ у `nonget-secure.json`).
4. HTTPS наскрізно (CONNECT + TLS до реального сертифіката) — у S1a CONNECT доведено тунелем до echo-сервера;
   IPv6-апстрім і happy-eyeballs (проксі бере першу адресу; fallback на наступні перевірені — S1b).
5. Ліміти проксі: розмір/час відповіді, кількість з'єднань, ліміт редиректів на рівні аудиту; `blocked_requests_count`
   у полях повноти захоплення (G0-10) — брати з `SecureBrowser.blocked` + `proxy.log`.
6. ~~Гейт fixture-режиму~~ — **закрито (S1a-fix):** fixture вмикається лише явно (`allowFixtureLoopback:true` або
   `SITELENS_FIXTURE_MODE=1`), а не «NODE_ENV≠production»; `NODE_ENV=production` забороняє його завжди; порожній allow-list —
   виняток. Тести: без прапорця → виняток; з прапорцем і `[]` → виняток (`net-proxy.test.ts`, `secure-browser.test.ts`).
   Скрипти (`fixture-harness`, `run-slice`) ставлять прапорець явно. Прапорець «NODE_ENV=development» з промпту свідомо
   замінено на явний прапорець (під vitest `NODE_ENV=test`); worker (S2) fixture-режим не вмикає.
7. Проксі слухає 127.0.0.1 без автентифікації: будь-який локальний процес може ним скористатись (дозволено лише
   публічні IP — не ескалація, але в спільному хості — токен у `Proxy-Authorization`). Контейнерні egress-правила — ⏭️ L9.
8. `planning/security/THREAT_MODEL.md` із посиланнями «мітигація → тест» — створити на основі цього файлу.
9. ~~Перевести `slice.test.ts` і crawl/журнали на `SecureBrowser`~~ — **закрито (S1a-fix, п.5 критика):** див. «Інтеграція».
