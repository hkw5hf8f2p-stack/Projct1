# Проба тулчейну — 29.09.2026 (виправлено на гейті 0)

Факти стосуються **Mac власника** (arm64, macOS). Нова сесія може працювати деінде (хмара/Linux) — тоді ці факти
не діють, і першою дією S1a є `scripts/doctor` (див. нижче), а не довіра цьому файлу.

## Що бачила проба на Mac власника

- Node 24.18.0, pnpm 11.9.0 (nvm). Docker/Postgres/Redis відсутні. `timeout` у shell відсутній (macOS).
- `embedded-postgres@18.4.0-beta.17` — initialise → start → `select version()` → stop пройшло.
  Відповідь: `PostgreSQL 18.4 on x86_64-apple-darwin24.6.0` — **бінарник x86_64 під Rosetta** на arm64-машині.
  Причину не з'ясовано (гіпотеза: пакет `@embedded-postgres/darwin-arm64` не зібрався через заблокований postinstall).
  На arm64 без Rosetta це буде збій. **Unverified**, закриває `scripts/doctor` (arch бінарника) на чистій інсталяції.
- Перша спроба старту Postgres впала **мовчки** (лише «shut down», без помилки) — через заблокований postinstall.

## Виправлення (гейт 0)

1. **pnpm 11: `allowBuilds`, не `onlyBuiltDependencies`.** У pnpm 11 `onlyBuiltDependencies`,
   `onlyBuiltDependenciesFile`, `neverBuiltDependencies`, `ignoredBuiltDependencies` **видалено** — вони ігноруються.
   Заміна — мапа `allowBuilds` у `pnpm-workspace.yaml` (джерело: https://pnpm.io/blog/releases/11.0, перевірено
   29.09.2026):
   ```yaml
   allowBuilds:
     embedded-postgres: true
     "@embedded-postgres/*": true
     # + кожен інший пакет із postinstall, який реально потрібен (перелік — з `pnpm install` без дозволу)
   ```
   `package.json` → `"packageManager": "pnpm@<точна версія>"`, щоб синтаксис не залежав від машини. Предикат: після
   `pnpm install` на чистій копії бінарник Postgres існує й запускається; контроль — без `allowBuilds` старт падає.
2. **Chromium ревізії 1243 для Playwright 1.63.0.** `playwright-core@1.63.0/browsers.json`: `chromium` і
   `chromium-headless-shell` ревізії **1243** (Chrome for Testing 153.0.8010.12). Локальний кеш на Mac — **1187**, він
   **не підходить**. У README і `scripts/setup`: `pnpm exec playwright install chromium`. Для перевірки чистої інсталяції —
   окремий `PLAYWRIGHT_BROWSERS_PATH` (R-16).
3. **embedded-postgres існує лише в pre-release.** `npm view embedded-postgres dist-tags` → `latest: 18.4.0-beta.17`;
   жодної стабільної версії на npm немає (лише `*-alpha.*` / `*-beta.*`). Рішення DEV-10: закріпити **точну** версію
   (без `^`), arch бінарника — у `scripts/doctor`; ризик R-8, R-24. Платформні пакети є для darwin-arm64/x64 і
   linux-arm64/x64.
4. **Пісочниця Chromium.** Playwright за замовчуванням `chromiumSandbox: false`, `acceptDownloads: true`. Ми вмикаємо
   пісочницю й вимикаємо завантаження (DEV-13, G0-4). У Linux-контейнері під root пісочниця не стартує → запуск від
   не-root користувача; інакше doctor = FAIL і живі сайти заборонені (лише фікстура).
5. Актуальні версії npm на 29.09.2026: playwright 1.63.0, @axe-core/playwright 4.13.0, lighthouse 13.5.0,
   pg-boss 12.35.0. Сумісність Lighthouse 13.5 + Playwright 1.63 + Node 24 **не перевірена** — це спайк S1a, крок 1.

## `scripts/doctor` (перша дія S1a) — що перевіряє, JSON-артефакт

| Перевірка | PASS | Контроль «уміє впасти» |
|---|---|---|
| Node major ≥ 22 | так/ні | — |
| pnpm = версія з `packageManager` | так/ні | — |
| `os.arch()`, Rosetta (macOS) | записати | — |
| Chromium ревізії з `browsers.json` встановлено | так/ні | навмисно порожній `PLAYWRIGHT_BROWSERS_PATH` → FAIL |
| Chromium стартує з пісочницею | так/ні | — |
| embedded-postgres: arch бінарника (`file`) + старт + `SELECT 1` на `EMBEDDED_PG_PORT` | так/ні | зайнятий порт → FAIL з назвою причини |
| Вихід в інтернет (GET на публічний сайт зі списку G0-14) | так/ні — визначає, чи можливі живі пас-и | — |
| Docker | так/ні (лише інформативно) | — |
