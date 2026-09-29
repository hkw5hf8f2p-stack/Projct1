# Двійник «Пасіка Верховина» — прогін S1a (критерій виходу №3)

> **Двійник-1 використаний і розкритий (G0-15, DEV-33).** Цей прогін — єдиний, що рахується для критерію №3 S1a.
> Наступні прогони двійника-1 (після фіксу класифікатора, DEV-32) — **лише інформативні**, у критерій не входять;
> незалежний вимір — запечатаний twin2 після тегу заморожування v2. Виправлено 29.09.2026 за рецензією критика S1a.

Дата: 2026-09-29. Детектори: коміт 7c5cae8 (без змін). Скрипт: scripts/audit-twin.ts. Артефакти: planning/qa/artifacts/sprint-1a/twin/ (evidence.json, findings.json, pages/, twin-summary.json).

- Хеш двійника до і після прогону == planning/sealed/twin.sha256: **OK** (85106e74e18827d718e08b9c48303a65513f772744d791991bcc0226709f3200)
- Сторінок у crawl: 9; evidence 109; findings 24; не-GET запитів до двійника: 0
- **Детерміновані (чесно): 4/7 за критерієм «будь-яка очікувана сторінка/viewport» (№6–№9); при повному покритті EXPECTED — 3/7 (№6, №7, №8). Критерій ≥6/7 НЕ виконано.** Скрипт формально дав 5/7: №10 зараховано помилково — спрацювання **випадкове** (на кошику `kosh.html`, хибно класифікованому як product; на заявлених лістингу/товарах №10 не знайдено), і текст його доказу суперечить геометрії (див. нижче).
- Незаявлені реальні a11y/overflow-знахідки (немає в EXPECTED, **не** хибні спрацювання): 84

## Таблиця дефектів

| № | Детектор | Знайдено | Сторінки / viewport | Клас | Впевненість | Доказ |
|---|---|---|---|---|---|---|
| 2 | shipping_depth | **ні** | — | — | — | — |
| 5 | cta_below_fold | **ні** | — | — | — | — |
| 6 | axe:button-name / link-name / label | так | /index.html, /kataloh.html, /kosh.html, /kosh.html?t=a, /kosh.html?t=b, /pro-nas.html, /tovar-ramka-435.html, /tovar-ramka-435r.html, /umovy.html @ 390x844 | BENCHMARKED | VERIFIED | button — <button class="tgl" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><pa → pages/index-html/390x844/axe.json |
| 7 | horizontal_overflow | так | /kataloh.html, /tovar-ramka-435.html, /tovar-ramka-435r.html @ 390x844 | OBSERVED | VERIFIED | #tilo > div > span:nth-of-type(5) / footer / #tilo > h1 → pages/kataloh-html/390x844/fullpage.png |
| 8 | oversized_image | так | /index.html @ 1440x1000, 390x844 | OBSERVED | VERIFIED | http://127.0.0.1:33043/img/pasika-zahalnyi-plan.png — 9598261 B — natural 2400×1600, rende → pages/index-html/1440x1000/network.json |
| 9 | axe:image-alt | так | /kataloh.html @ 1440x1000, 390x844 | BENCHMARKED | VERIFIED | img dymar.svg без alt (axe) → pages/kataloh-html/1440x1000/axe.json |
| 10 | price_first_viewport | **ні** (випадкове спрацювання на кошику, не зараховано) | /kosh.html, /kosh.html?t=a, /kosh.html?t=b @ 390x844 | OBSERVED | VERIFIED | Верховина Ваш кошик Рамка ДБ-435 ВЛ розс. Рамка ДБ-435 ВЛ розс. Р Разом до сплати: у цьому → pages/kosh-html/390x844/viewport.png |

Нотатки: №6 знайдено на всіх 9 сторінках M (axe button-name 9 рядків, link-name 2 на M); №7 лише M на kataloh і обох tovar-*; №8 index.html D і M; №9 лише kataloh.html (index/pro-nas у EXPECTED «частково» — не знайдено); №10 лише kosh.html (M), тобто НЕ на лістингу/товарах — не зараховано. Доказ №10 на kosh самосуперечливий: текст «немає ціни (перша ціна на 282px)», але ціна `1 200 грн` є на y=282 при x=447 — поза шириною вікна 390 px через горизонтальний overflow сторінки (672 px, наслідок №7); x і причину (`off_fv_horizontal`) доказ не називав (виправлення — page-type-spec §5).

## Діагностика промахів (не виправлялось)

- №2 shipping_depth: shipping_depth: gate page_type==product. Товари двійника /tovar-ramka-435.html → unknown: PRODUCT_PATH_RE вимагає /(product|products|p|item|tovar)/<slug> (двійник — плоский файл tovar-ramka-435.html, не каталог tovar/); немає JSON-LD Product; CTA «Обрати» не в CTA_RE. Предикат (SHIP_RE на тексті/посиланнях) не досягається; сам по собі спрацював би: у details «Відправляємо…» (не відправк*), посилання «Умови» не SHIP, шлях umovy.html не SHIP_PATH.
- №5 cta_below_fold: cta_below_fold: той самий gate product + CTA_RE не знає «Обрати». Обидва обходять предикат до його перевірки.
- №10 price_first_viewport (часткова/випадкова): price_first_viewport: gate product|category. tovar-* unknown; kataloh unknown, бо посилань на товари 2 (<3 для category, і шлях не збігається з PRODUCT_PATH_RE). Спрацював лише на kosh.html (M) — там h1 + «Оформити» (CTA_RE) дало product; тобто збіг випадковий, не на лістингу/товарах.
- Спільна причина: gate по page_type (classifyPageType) не розпізнає товари двійника — flat-URL tovar-*.html, немає JSON-LD, CTA «Обрати» поза CTA_RE. Три з чотирьох product-детекторів (№2, №5, №10) відрізані ще до предиката.
- №9 (частково): axe:image-alt дав знахідки лише на kataloh.html; в index/pro-nas у двійнику alt="" або наявний — EXPECTED позначає «частково», не промах.

## Незаявлені реальні знахідки (84; раніше помилково названі «хибні спрацювання»)

Це справжні дефекти двійника, яких немає в EXPECTED (EXPECTED неповний), а не FP детекторів. Precision рахується проти правди, не проти EXPECTED. Проблема — обсяг (75 рядків contrast ≈ один дизайн-токен): потрібне групування axe за `(rule, page_group, компонент)` з `instances` (критик S1a, fix-задача 4).

- axe:color-contrast — 75 рядків на всіх сторінках/viewport (напр. футер #8a7c68 на #efe4c6, 3.21; «Кошик» #0000ee на #3d2b1f, 1.42). Це реальні a11y-дефекти двійника, але їх немає в EXPECTED.
- axe:heading-order — 4 (index, kataloh; D і M). Реальний, не заявлений.
- axe:link-name D на kataloh.html — 2 (посилання-картинка без тексту; дотичне до №9/№6, EXPECTED очікує №6 лише M).
- horizontal_overflow на kosh.html M — 3 (footer; kosh?t=a|b) — реальний (scroll_width 672 при 390), EXPECTED очікує лише kataloh/tovar-*.
- Повний список: twin-summary.json → `unclaimed_real_findings` (перейменовано з `false_positives`; `scripts/audit-twin.ts` ще пише стару назву — перейменувати при наступній правці скрипта).

## QA-підтвердження S1a

- bash scripts/run-as-sitelens.sh pnpm test: **176/176 passed** (5 файлів, 379 с)
- pnpm run typecheck: OK
- pnpm run lint: OK (після виправлення одного no-unused-expressions у новому scripts/audit-twin.ts)
- Побічний ефект: pnpm test перезаписав planning/qa/artifacts/sprint-1a/canary/*.json (8 файлів, git M); не коміт.

## Висновок для рецензії гейту

Критерій S1a №3 (≥6/7) не досягнуто: **4/7** (№6–№9), 3/7 з повним покриттям; №10 — випадкове спрацювання з неправильної причини (кошик → product), не зараховано. Корінь — класифікація типу сторінки, не самі предикати. Двійник сконструйовано саме так, що типові URL/CTA-евристики фікстури shop не переносяться. ⏭ Живий прохід не заміщується.
