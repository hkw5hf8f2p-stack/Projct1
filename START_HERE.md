# SiteLens — START HERE

**Що це:** веб-застосунок: вводиш URL публічного сайту → Playwright захоплює desktop/mobile, Lighthouse + axe,
детерміновані детектори, LLM будує SiteProfile і 12 behavioral lenses, синтетичні сесії → знахідки з доказами
й пріоритетом. Без вигаданих чисел (TAM, uplift). Повна спека — `docs/SOURCE/SPEC.md`.

**Ціль сесії розробки:** готовий MVP за Definition of Done (SPEC §72), через спринти S1–S8 (+S6 після DoD).

## Стан на 29.09.2026
- Коду **нуль**. Гейт 0 закрито: рецензія спеки, команда з 10 агентів, спринт-план, тест-стратегія,
  здійсненність і формули, критик + оптиміст, рішення зведено (DEV-1…DEV-18).
- Актуальний стан і наступний крок — `planning/STATE.md` (оновлюй після кожного гейту).

## Порядок читання
1. `CLAUDE.md` — правила (завантажується автоматично).
2. `planning/STATE.md` — де ми й що робити першим.
3. `docs/SPEC_REVIEW_UK.md` → `planning/DEVIATION_LOG.md` — **пріоритет над SPEC.md**.
4. `planning/SPRINT_PLAN.md` (розділ «Гейт 0» — усі рішення G0-N).
5. `planning/eval/SCORING_SPEC.md` — формули, guard, пороги (готові до реалізації).
6. `planning/qa/TEST_STRATEGY.md`, `planning/RISK_REGISTER.md`, `planning/FEASIBILITY_EVAL.md`.
7. `planning/reviews/` — аргументи критика й оптиміста (контекст рішень).

## Ієрархія документів при суперечності
`DEVIATION_LOG.md` + «Гейт 0» у `SPRINT_PLAN.md` > `SPEC_REVIEW_UK.md` > `SCORING_SPEC.md` / `TEST_STRATEGY.md` > `SPEC.md`.
Нова суперечність → запис у DEVIATION_LOG, не мовчазний вибір.

## Команда
`.claude/agents/sl-*.md`, опис — `planning/TEAM.md`. Головна сесія — оркестратор; кожен спринт закінчується
`planning/conclusions/sprint-N.md` з вердиктом після `sl-critic` + `sl-optimist`.

## Що за власником (не питати, доки не дійшли — див. `planning/OPEN_QUESTIONS.md`)
OQ-1 ключ LLM · OQ-2 сайт §66 + прихований список · OQ-3 публічне розгортання · OQ-4 ліміт витрат живого пасу.
Без них робиться весь dev-пас; LLM-залежне позначається ⏭️, ніколи ✅.

## Середовище
Перевірено на Mac власника: Node 24 + pnpm 11, без Docker. PostgreSQL — `embedded-postgres` (beta, див.
`planning/engineering/toolchain-probe.md`, у pnpm 11 дозволити build через `allowBuilds`). Playwright 1.63
потребує свій Chromium: `pnpm exec playwright install chromium`. Якщо ти в іншому середовищі (Linux/хмара) —
спершу перевір, що є, і запиши в `planning/engineering/`.
