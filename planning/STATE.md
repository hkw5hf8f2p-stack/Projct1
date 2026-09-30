# STATE — SiteLens (читати першим)

> **Оновлення 30.09.2026 (пізніше):** S2 Go після Fix; S4 Go після Fix (кр. 4 guard FAIL 78,8 % → Pivot на структурне
> правило чисел, Known limitation); S5 Fix → повна QA-матриця в S8. **Далі: S8 (DoD з чистого git clone).**
>
> **Оновлення 30.09.2026:** S1b — Go-офлайн після Fix (`conclusions/sprint-1b.md`; **S1b-live блокує реальні URL
> для користувача**); S3 — Go dev-пас (`conclusions/sprint-3.md`; guard held-out 34/48 < 44 → у S4 структурний білий
> список чисел). S2 — у роботі. Далі: S4 ∥ каркас S5.
>
> **Оновлення 29.09.2026 (оркестратор, хмарна сесія): S1a закрито — Go після Fix** (`planning/conclusions/sprint-1a.md`).
> Середовище: Linux-контейнер, Node 22.22.2, pnpm 10.33.0, Playwright 1.56.1 / Chromium r1194 (DEV-23…25), браузер
> від `sitelens` (`bash scripts/run-as-sitelens.sh …`). Живі сайти заблоковані мережею (власник обіцяв відкрити).
> Тести 223/223. **Наступне: S1b** — Lighthouse через проксі, DNS-rebinding ≥ 25, ліміти проксі, robots/пауза,
> схема §8 у `packages/schemas`, живі сайти (якщо мережа). Нижче — стан гейту 0 для історії.

Оновлено: 29.09.2026, sl-pm, після гейту 0.

## Де ми зараз

- **Гейт 0 закрито: Go для S1a** (рішення G0-1…G0-34 — `planning/SPRINT_PLAN.md`, розділ «Гейт 0»).
- **Коду нуль.** Є лише документи: SPEC, рецензія, план S1a…S8, SCORING_SPEC, TEST_STRATEGY, FEASIBILITY, ризики
  (R-1…R-35), відхилення (DEV-1…DEV-18), 4 питання власника, 10 агентів `.claude/agents/sl-*.md`.
- Ієрархія документів (G0-1): рішення гейту 0 > SCORING_SPEC > SPEC_REVIEW_UK > SPRINT_PLAN > TEST_STRATEGY >
  FEASIBILITY > SPEC.
- Порядок: S1a → S1b → {S2 ∥ S3} → S4 → S5 → S8 (DoD) → S6; S7 — живий пас, щойно є ключ і ліміт.
- Оцінка: dev ≈ 8–12 днів агентів; живий пас 1–2 дні.

## Наступний конкретний крок — S1a, перші три кроки (саме в такому порядку)

1. **`scripts/doctor` + спайк сумісності.** pnpm workspace, `pnpm-workspace.yaml` з `allowBuilds` (pnpm 11 **видалив**
   `onlyBuiltDependencies`), `packageManager` з точною версією, `pnpm exec playwright install chromium` (Playwright 1.63
   потребує ревізії **1243**). Playwright Chromium + `@axe-core/playwright` + Lighthouse запускаються на порожній
   сторінці на Node цього середовища. Doctor пише JSON-артефакт і показує FAIL на порожньому `PLAYWRIGHT_BROWSERS_PATH`.
   Несумісність → DEVIATION_LOG одразу. Деталі — `planning/engineering/toolchain-probe.md`.
2. **Мінімальний наскрізний зріз.** Одна сторінка фікстури з overflow + відсутнім alt → захоплення 1440×1000 і 390×844
   → axe + детектор overflow → Evidence-JSON з `source_class` і `artifact_reference` на скриншот із регіоном.
3. **SSRF-ядро з канаркою.** Повний IP-класифікатор (§49 + B1) → egress-проксі з pinned IP як єдиний вихід Chromium
   (`--proxy-server`, `--proxy-bypass-list=<-loopback>`, WebRTC `disable_non_proxied_udp`, `--disable-quic`) +
   `context.route` для не-GET, SW block, WS close (DEV-8). Канарка `127.0.0.2:4199`: без проксі отримує запити, з
   проксі — 0, без `<-loopback>` — отримує (контроль прапорця). Пісочниця Chromium увімкнена, `acceptDownloads:false`,
   очищений `env` (G0-4).

Жодного живого URL до пункту 3 з обома контролями.

## Перед передачею zip (дія власника/оркестратора)

`planning/`, `.claude/`, `CLAUDE.md`, `START_HERE.md`, `.gitignore` зараз **не під git** (untracked). Закомітити до
пакування; перевірити архів: `unzip -l <zip> | grep -c SPRINT_PLAN` ≥ 1 і `grep -c node_modules` = 0 (G0-34, R-34).

## Deferred (⏭️) і чому

| Що | Чому | Що закриє |
|---|---|---|
| Уся якість LLM: 3 LLM-дефекти E1, E2, E3, реальна вартість E4, «LLM outputs validate», звіт із LLM | немає ключа; replay/fake доводять лише плумбінг | OQ-1 ключ + OQ-4 ліміт → S7 |
| Протокол §66 | потрібні сайт (≠ dev-сайти) і прихований список 5/5/5 власника | OQ-2 → S7 |
| `docker compose up -d`, egress-правила контейнера (L9) | немає Docker; MVP локальний | машина з Docker / OQ-3 |
| Публічне розгортання | MVP лише 127.0.0.1 | OQ-3 |
| Бот-захист реальних сайтів (L8) | фікстурна імітація ≠ Cloudflare | живий сайт за Cloudflare у S1b, якщо трапиться |
| S6 (варіанти, компаратор) | свідомо після DoD (DEV-14) | після S8 |

## Лічильник unverified: 6

| # | Твердження | Джерело | Що перевірить |
|---|---|---|---|
| U-1 | `temperature` → 400 на Opus 5/5.5, Sonnet 5, Fable 5.x і OpenAI reasoning | FEASIBILITY §2.3 | один живий виклик кожного адаптера з `temperature=0` (S7, крок 1) |
| U-2 | thinking на Opus 5.5 неможливо вимкнути; `m_think` ×1,5–3 | FEASIBILITY §5.1 | `usage` димового аудиту (S7) |
| U-3 | Ціни в $ (знімок 24.06.2026), $50–90 за `validate` | FEASIBILITY §5.2, критик Р-8 | сторінка цін провайдера на дату прогону |
| U-4 | Архітектура бінарника embedded-postgres (x86_64 під Rosetta на arm64; arm64-пакет не зібрався?) | toolchain-probe | `scripts/doctor` на чистій інсталяції |
| U-5 | Сумісність Lighthouse 13.5 + Playwright 1.63 + Node 24 | toolchain-probe | S1a крок 1 |
| U-6 | «7 з 10 дефектів ловляться детерміновано» | FEASIBILITY §1 | E1 на фікстурі + запечатаному двійнику + мутантах (S1a) |

## Не вирівняно на гейті 0 (дрібниці, виправити на старті S1a)

- `CLAUDE.md` не згадує Chromium ревізії 1243 / `pnpm exec playwright install chromium` і ієрархію G0-1 — у
  `toolchain-probe.md` і тут це є; CLAUDE.md правила паралельно інша сесія, тому не чіпав.
- `TEST_STRATEGY.md` §2 (API compare C1) і §1 «Фікстури» ще не згадують `fixtures/shop-clean` / A-vs-A-пару явно
  (пороги вирівняно в §8.3–8.5 і §15).
- `SPRINT_PLAN.md` S5 «Ризики» без R-29; S4 real-env пас не посилається на список G0-14 явно (правило 9 рамки діє).
- `SCORING_SPEC.md` §2: тест-таблицю доповнено лише текстом (два рядки для тверджень відсутності описано, у таблицю не
  вписано).
- `planning/security/`, `planning/conclusions/` порожні — заповнюються в S1a/S1b.
