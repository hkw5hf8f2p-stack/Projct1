# Fixture defect map — дефекти §53 → детектори → докази → мутанти

Автор: `sl-eval-science`, 29.09.2026, для `sl-core-engineer` (S1a). Версія скорингу: `scoring-v1` + DEV-19…DEV-21.
Джерела: SPEC §3/§10/§23/§38/§39/§53/§57; SCORING_SPEC §1–§3, §5, §8.1; G0-7, G0-10, G0-11, G0-15; DEV-17; R-9, R-28.
Пороги нижче зафіксовано **до** першого прогону; зміна — лише із записом у DEVIATION_LOG.

## 0. Рішення
- **Розподіл 7 + 3 підтверджено** (DEV не потрібен). Детерміновані: №2, №5, №6, №7, №8, №9, №10. LLM: №1, №3;
  гібрид №4 (детермінований опорний факт ET-SUP + LLM-судження) рахується як LLM (E1_llm лише в абляції, G0-7).
- Жоден предикат не використовує час (R-9, правило 8): лише геометрію, байти, пікселі, axe-правила, граф посилань.
- Поріг №2 = **≥ 2 кліки від продукту** (TEST_STRATEGY §8.1 мав «≥ 3» у іншій системі відліку) — DEV-21.
- №8 — **байти**, без серверної затримки; Lighthouse — лише BENCHMARKED-підтримка — DEV-20.
- Деградований доказ відсутності (DEV-17) отримує окремий рівень сили `ET-INC` — DEV-19 (усуває суперечність DEV-17 ↔
  SCORING_SPEC §1.2: інакше знахідка лише з ET-SUP мала б відкидатися, а з SYN — ставати STRONG).

## 1. Загальні умови вимірювання (усі детектори)
- **Viewports:** D = 1440×1000, DPR 1, `isMobile:false`; M = 390×844, DPR 2, `isMobile:true`, `hasTouch:true`.
- **Момент виміру:** `load` → `document.fonts.ready` → банер за B5 (DEV-5) → прокрутка до низу кроками 0,8·vh до
  стабільного `scrollHeight` (≤ 40 кроків, інакше `scroll_completed=false`) → `scrollTo(0,0)` → два виміри геометрії,
  розділені двома `requestAnimationFrame`; розбіжність > 1 px → `layout_stable=false` → геометричні детектори утримуються.
- **Видимий елемент:** `el.checkVisibility({opacityProperty:true, visibilityProperty:true})` ∧ площа rect ≥ 1 px² ∧
  не обрізаний предком із `overflow≠visible` до нульової площі.
- **Перше вікно (FV)** на viewport v: прямокутник `[0,vw)×[0,vh)` при `scrollY=0`. Елемент «у FV», якщо ≥ 50 % його
  площі всередині FV **і** `document.elementFromPoint(центр видимої частини)` — це він або нащадок (не перекритий).
  Для `position:fixed|sticky` береться фактичний rect при `scrollY=0`.
- **Координати доказу:** CSS px документа + `dpr`; пікселі скриншота = CSS × dpr. Округлення до цілих px.
- **Page type** (для №2, №5, №10): `product`, якщо JSON-LD/microdata `Product` **або** (рівно один видимий `h1` ∧ ≥ 1
  CTA-кандидат, §3.5) **або** шлях `/(product|products|p|item|tovar)/`; `category`, якщо ≥ 3 видимі посилання на
  сторінки `product` (за шляхом або JSON-LD `ItemList`). Невизначений тип → ці детектори не запускаються.
- **Заборона циркулярності (M2):** код детекторів не містить рядків/селекторів/назв фікстури й не читає `data-fx-*`.
- **Детермінізм:** вихід сортується за `(detector_id, page_url, viewport, selector)`; 3 прогони → побайтово однаковий
  JSON без полів часу (час — окремий файл `timing.json`, у порівняння не входить).

## 2. Evidence-контракт (SPEC §23 + SCORING_SPEC §1.1)
```ts
{ id, type, source_class, page_url, description,           // description — шаблон детектора (C4), не LLM
  artifact_reference: 'pages/<page_id>/<vw>x<vh>/{viewport|fullpage}.png' | '…/axe.json' | '…/network.json',
  selector_or_region: { selector?: string, region: {x,y,w,h}, dpr: 1|2, coord: 'css_px_document' },
  excerpt?: string,                                          // що саме цитується (≤ 300 симв.)
  detector_id, claim_kind, assertion: 'presence'|'absence',  // absence → вмикає DEV-17/DEV-19
  viewport: 'D'|'M', measurement: {…числа…},
  self_confirming: boolean, capture_complete: boolean, incomplete_reasons?: string[] }
```
`confidence` не пишеться в доказ — його рахує `confidence()` (SCORING_SPEC §2).

## 3. Детерміновані дефекти

### 3.2 №2 Схована доставка — `shipping_depth` · category `shipping` · claim_kind `deep_link_only` · absence
- **Вимір** (лише сторінка `product`, union по D і M): `SHIP_RE = (?<!\p{L})(доставк\p{L}*|відправк\p{L}*|shipping|
  delivery|нова пошта|укрпошта)(?!\p{L})` (i, u). `d0` = є видимий текстовий вузол із SHIP_RE будь-де на сторінці
  (не лише FV; видимий `<summary>`/заголовок акордеона рахується). `d1` = є видиме same-origin посилання, у якого
  accessible name **або** шлях URL відповідає SHIP_RE (`/shipping|/delivery|/dostavka`).
- **Предикат:** `¬d0 ∧ ¬d1` ⇒ глибина ≥ 2 кліки ⇒ спрацювання. `measurement.depth_clicks` = точна BFS-глибина за
  crawl-графом (лише видимі посилання, deny-list G0-11 не відкривається) або `null`, якщо ціль не знайдено в межах
  crawl — у предикат **не входить** (залежить від бюджету crawl).
- **Доказ (DEV-41: page-level факт, рядок на КОЖНОМУ viewport D і M):** `type:dom`, OBSERVED, `artifact_reference` = fullpage.png свого viewport, region = вся сторінка, `measurement.scope='page'`, `d0/d1` — union D∪M, `viewport_local` — по viewport; excerpt =
  список текстів видимих посилань сторінки (показує, що жодне не веде до доставки) + шлях, де доставку знайдено
  (`/help → /help/shipping`), якщо знайдено. Повне захоплення → ET-DET → **VERIFIED**; інакше §4.
- **Мутант M2:** на продукті видимий блок «Доставка: 1–2 дні, від 70 грн» (d0) → 0.
- **FP на чистих/живих:** промо «Безкоштовна доставка» в шапці робить d0=true (це FN, не FP — прийнятно); FP можливий,
  якщо доставка показана картинкою без alt-тексту → alt-текст `img` теж зіставляється з SHIP_RE.

### 3.5 №5 CTA нижче згину — `cta_below_fold` · `cta` · `below_fold` · presence (позиційний вимір)
- **CTA-кандидат** (лише `product`): видимий `button | a[href] | input[type=submit|button] | [role=button]`, accessible
  name (trim, lower) відповідає `CTA_RE = ^(купити|придбати|замовити|оформити( замовлення)?|(додати )?(в|у|до)
  кошик[аи]?|buy( now)?|add to (cart|bag|basket)|order( now)?)\b` (G0-26: межі через `(?!\p{L})`).
- **Вимір:** `vis(c,v)` = частка висоти c у FV (для fixed/sticky — у фактичній позиції); `top_px(c)` при scrollY=0.
- **Предикат на v:** ∃ кандидат ∧ `max_c vis(c,v) < 0.5`. Жодного кандидата → детектор мовчить (не твердження
  відсутності; `cta_not_found` — окремий майбутній детектор, поза E1). `layout_stable=false` → утримання.
- **Доказ (на кожен v, що спрацював):** `type:dom`, OBSERVED, `artifact_reference` = fullpage.png v, region = rect CTA;
  у measurement `top_px`, `vh`, `vis`; excerpt = accessible name CTA + селектор. Поза DEV-17 (не відсутність), але
  `banner_state='open'` → `capture_complete=false` → ET-INC за §4 п.2 (банер міг зсунути макет).
- **Фікстура:** CTA `top ≥ 1,5·vh` на **обох** v. **Мутант M5:** CTA під H1, `bottom ≤ 0,6·vh` на обох → 0.
- **FP:** галерея 390×390 + довга назва на мобільному → чиста сторінка має тримати CTA `bottom ≤ 0,6·vh` на M;
  sticky-панель «Купити» внизу мобільного екрана рахується як видимий CTA (не FP).

### 3.6 №6 Мобільна мітка — `axe:button-name` (також `axe:link-name`, `axe:label`) · `accessibility` · presence
- **Вимір:** `@axe-core/playwright` (версія пінована в lockfile) на D і M, повний дефолтний набір правил; беруться
  лише `violations` (не `incomplete`).
- **Предикат:** ≥ 1 вузол у violations з `id ∈ {button-name, link-name, label}`. Для E1 №6 очікується саме на **M**
  (іконкова кнопка, `display:none` на D → axe її не бачить на D).
- **Доказ:** `type:axe`, BENCHMARKED, `artifact_reference` = axe.json (M) + viewport.png (M), region = rect вузла;
  excerpt = `target`, `html` (≤ 300), `failureSummary`. ET-DET → VERIFIED. Одна знахідка на `(rule-id, pageGroup)`.
- **Мутант M6:** `aria-label="Меню"` → 0 на обох v. **FP:** `svg` без `aria-hidden` усередині підписаної кнопки не
  тригерить `button-name`; чиста сторінка — усі іконкові кнопки/поля з accessible name.

### 3.7 №7 Горизонтальний overflow — `horizontal_overflow` · `mobile_usability` · `horizontal_overflow` · presence
- **Вимір (на M; D теж міряється, але E1 — лише M):** `overflow_px = document.documentElement.scrollWidth − 390`;
  offenders = видимі елементи з `rect.right > 391`, без предка з `overflow-x ∈ {hidden, clip, auto, scroll}`,
  топ-3 за `rect.right`, найглибші (без нащадка-offender).
- **Предикат:** `overflow_px ≥ 2`.
- **Доказ:** `type:dom`, OBSERVED, fullpage.png (M), region = rect першого offender (або смуга `x≥390`, якщо offenders
  порожні); measurement `scrollWidth, overflow_px`; excerpt = селектори offenders. ET-DET → VERIFIED.
- **Фікстура:** `overflow_px ≥ 150` (таблиця `width:540px`). **Мутант M7:** обгортка `overflow-x:auto` → 0.
- **FP:** off-canvas меню з `position:absolute; transform` поза екраном дає реальний горизонтальний скрол — це справжня
  знахідка; на чистих сторінках off-canvas лише `position:fixed` або `display:none`.

### 3.8 №8 Велике «повільне» зображення — `oversized_image` · `performance` · `oversized_image` · presence (DEV-20)
- **Вимір:** для кожної відповіді `content-type: image/*` (без `image/svg+xml`), що відмальована (`img/picture`
  currentSrc або CSS `background-image` видимого елемента): `body_bytes = (await response.body()).length`;
  `oversize = naturalW·naturalH / (renderW·renderH·dpr²)`. 304/кеш/опаковий cross-origin → байти невідомі → утримання
  для цього зображення.
- **Предикат:** `body_bytes ≥ 512 000` (500 KiB; узгоджено з SCORING_SPEC §3.2 «> 500 KB»). `oversize` — лише в
  measurement. Час завантаження, LCP — **не** в предикаті.
- **Доказ:** `type:dom`, OBSERVED, network.json + viewport.png (D), region = rect зображення; excerpt = URL, байти,
  natural vs rendered px. Підтримка: Lighthouse `uses-responsive-images`/`total-byte-weight` → окремий BENCHMARKED
  доказ (не потрібен для спрацювання). ET-DET → VERIFIED.
- **Фікстура:** JPEG 2400×1600, ≥ 1 500 000 байт, рендер ≤ 1440×480; **без** серверної затримки.
  **Мутант M8:** те саме зображення 1440×480, ≤ 150 000 байт → 0. **FP:** на чистих усі зображення ≤ 150 000 байт.

### 3.9 №9 Немає alt — `axe:image-alt` · `accessibility` · presence
- **Предикат:** ≥ 1 вузол axe violations `image-alt` на D або M (зазвичай обидва).
- **Доказ:** як №6 (BENCHMARKED, axe.json + region вузла, excerpt `html` з `src`). VERIFIED.
- **Фікстура:** `<img>` без атрибута `alt` (не `alt=""`). **Мутант M9:** змістовний `alt` → 0. **FP:** декоративні
  зображення на чистих — `alt=""` (axe їх пропускає).

### 3.10 №10 Ціна лише пізно — `price_first_viewport` · `pricing` · `not_in_first_viewport` · absence
- **Вимір (сторінки `product` і `category`, окремо D і M):** `PRICE_RE` (u, i) =
  `(?<![\p{L}\d])(?:[$€£₴]\s?\d{1,3}(?:[   .,]\d{3})*(?:[.,]\d{1,2})?|\d{1,3}(?:[   .,]\d{3})*
  (?:[.,]\d{1,2})?[   ]?(?:грн\.?|₴|uah|usd|eur|zł|\$|€))(?!\p{L})`. Кандидат — найменший видимий елемент з
  `innerText.length ≤ 40`, що матчить PRICE_RE (ловить «2 499» + «грн» у різних `span`), **або** видимий `img` з alt,
  що матчить. Виключення: предок ≤ 3 рівні містить SHIP_RE або `(?<!\p{L})(від|from|економія|знижка|save)(?!\p{L})`.
- **Предикат на v:** на сторінці немає жодного кандидата **у FV**. Знахідка — якщо спрацював ≥ 1 v.
- **Доказ:** `type:screenshot`+`dom`, OBSERVED, viewport.png v, region = весь FV `{0,0,vw,vh}`; excerpt = видимий текст
  FV (≤ 300) + `measurement.first_price_y` (px на цій сторінці або `null`) і `price_depth_clicks` (BFS до першої
  сторінки з ціною того ж продукту; інформативно). Повне захоплення → VERIFIED; інакше §4.
- **Фікстура:** на продукті ціни немає взагалі (лише на `/product/<slug>/configure`), у картках лістингу — немає.
  **Мутант M10:** ціна одразу під H1 (`top ≤ 0,5·vh` на D і M) і в кожній картці лістингу → 0.
- **FP:** ціна картинкою без alt або в `<canvas>` → хибне «немає» (відомий ризик R-28; на живих — через S1b precision).

## 4. Твердження відсутності (DEV-17, G0-10, DEV-19)
Стосується доказів з `assertion:'absence'` (№2, №10; майбутні `*_absent`). Для №5 — лише пункт про банер.
1. **Повне захоплення** (усе разом): `blocked_requests_count` до цільового origin = 0; `js_error_count` (неперехоплені
   `pageerror`) = 0; `banner_state ∈ {none, closed}`; `scroll_completed = true`; плюс (жорсткіше за DEV-17, сумісно):
   `http_status ∈ 2xx`, `failed_requests` same-origin типів document/script/xhr/fetch = 0, `layout_stable = true`.
   → `self_confirming=true`, `capture_complete=true` → ET-DET/F-DET → VERIFIED.
2. **Неповне** (будь-яка умова 1 хибна, але сторінка 2xx і `visible_text_length ≥ 200`): доказ **видається**,
   OBSERVED, `self_confirming=false`, `capture_complete=false`, `incomplete_reasons=[…]`, опис + «можлива неповнота
   захоплення». Рівень `ET-INC` (DEV-19): strength 0,30, родина F-INC — не LLM-похідна, але **не** рахується в `nonLlm`
   для STRONG(a); якщо в знахідці є хоч один доказ відсутності з F-INC і немає F-DET, `confidence ≤ HYPOTHESIS`.
3. **Утримання повністю** (доказ не видається): `http_status ∉ 2xx`; навігація не завершилась; сторінка-заглушка
   бот-захисту; `visible_text_length < 200`; тип сторінки не визначено; для №10/№5 — `layout_stable=false`.
4. «Не знайдено в межах crawl» (`price_depth_clicks`/`depth_clicks = null`) **ніколи** не стверджується як відсутність
   на сайті — лише «в межах N досліджених сторінок».
5. Тест-таблиця SCORING_SPEC §2 доповнюється: відсутність ціни + повне захоплення → VERIFIED; те саме + 1 заблокований
   запит → HYPOTHESIS, strength 0,30; те саме + SYN 3 лінзи/2 контексти → HYPOTHESIS (кап DEV-17).

## 5. LLM-дефекти (детермінована частина — лише ET-SUP, `self_confirming=false`, OBSERVED)
| # | Опорний детектор (не спрацювання дефекту) | Предикат опорного факту | Клас знахідки |
|---|---|---|---|
| 1 | `h1_category_overlap` (`/`) | 5-літерні префікси токенів H1 ∩ (тексти nav-посилань на `category` ∪ головні іменники назв продуктів) = ∅ | INFERRED/SYNTHETIC, category `value_proposition` |
| 3 | `term_unexplained` (`product`,`category`) | токен назви продукту `\p{Lu}{2,5}` або CamelCase/`™` не має на жодній захопленій сторінці `TERM\s*(—|–|:|\(|це|означає)`, `<abbr title>`, `<dfn>` | INFERRED/SYNTHETIC, `terminology` |
| 4 | `similar_products` (`category`) | пара карток: `1 − Lev(norm(a),norm(b))/max ≥ 0,8`; якщо обидві сторінки продукту захоплено — таблиці характеристик відрізняються ≤ 1 рядком | SYNTHETIC, `comparison`/`product_selection` |
В абляції E1_llm (G0-7) ці три опорні детектори вимикаються повністю (ні в промпті, ні в доказах). Без LLM (replay/none)
№1/№3/№4 — ⏭️, ніколи ✅. Самі по собі опорні факти знахідкою не є (SCORING_SPEC §1.2).

## 6. Вимоги до `fixtures/shop`
- **Сторінки** (≤ 10, влазять у crawl ≤ 12/глибина ≤ 3): `/` (№1 H1 без категорійних слів, №8 hero, спільна шапка
  з №6 — іконкова кнопка видима лише `≤ 768px`); `/catalog` (№4 пара `AquaPro X200`/`AquaPro X220`, №3 жаргон у назвах,
  №10 картки без ціни, GET-посилання `?add-to-cart=ID`); `/product/aquapro-x200`, `/product/aquapro-x220`,
  `/product/softline-s1` — спільний шаблон з №2 (жодного SHIP_RE на сторінці, футер «Допомога» → `/help`), №5 (опис
  1,5·vh перед CTA), №10 (ціни немає); `softline-s1` додатково №7 (таблиця 540px) і №9 (`img` без alt);
  `/product/<slug>/configure` (ціна; глибина 3 від `/`); `/help` → `/help/shipping`; `/about`; `/logout`,
  `?action=delete`; POST-форма «в кошик» (кнопка-CTA №5 у ній) — перевірка G0-11.
- **Повнота захоплення для VERIFIED:** 0 JS-помилок; жодних запитів на завантаженні, крім GET; cookie-банер (якщо є)
  має кнопку «Лише необхідні», згода — лише cookie на клієнті, **без мережевого запиту** (інакше блок → DEV-17 FAIL);
  жодного lazy-контенту, що вимагає не-GET. Шрифти — системні; висоти блоків фіксовані (запас ≥ 0,4·vh до порогів).
- **Ізоляція дефектів:** жодна сторінка не містить чужого дефекту «випадково» (напр., промо з «доставка» чи сумою
  в шапці — заборонено, бо ламає №2/№10). Мітки `data-fx="d2|d5|…"` на елементах дефектів — лише для перевірки,
  що region доказу перетинає очікуваний елемент (IoU > 0); детектори їх не читають (grep M2).
- **Мутанти — 7:** M2 блок доставки на продукті · M5 CTA під H1 · M6 `aria-label` · M7 `overflow-x:auto` обгортка ·
  M8 зображення ≤ 150 000 байт · M9 `alt` · M10 ціна під H1 і в картках. Реалізація — прапорець сервера
  `FIXTURE_MUTANT=m<N>` (одна кодова база, без дрейфу копій). Перевірка мутанта: детектор дефекту → **0**, решта 6
  детекторів → той самий набір, що на базовій фікстурі (без побічних змін).
- **Лог сервера:** JSONL `ts, method, path, status, user_agent, audit_hint` (TEST_STRATEGY).

## 7. Вимоги до `fixtures/shop-clean` (E3a, база E3c)
Сторінки `/`, `/catalog`, `/product/<a>`, `/product/<b>`, `/shipping`, `/about`. H1 головної містить категорійне слово з
nav; ціна у FV на D і M (продукт і перша картка лістингу, `bottom ≤ 0,6·vh`); CTA `bottom ≤ 0,6·vh` на D і M; блок
доставки на продукті (d0) + футер «Доставка й оплата»; усі `img` з alt (декоративні `alt=""`); усі іконкові кнопки
підписані; `scrollWidth = 390` на M; усі зображення ≤ 150 000 байт; назви продуктів без абревіатур і попарна схожість
< 0,5; 0 JS-помилок, 0 не-GET. **Очікування:** 0 спрацювань усіх 7 детермінованих детекторів і 0 опорних фактів №1/№3/№4
на D і M. Деградація E3c (5 змін §67) — прапорець `FIXTURE_VARIANT=degraded`, поза S1a.

## 8. `EXPECTED.json` (схема `sitelens-fixture-expected/v1`)
```json
{ "schema": "sitelens-fixture-expected/v1", "fixture": "shop", "scoring_version": "scoring-v1",
  "defects": [ { "id": 10, "spec_ref": "§53.10", "type": "deterministic|llm|hybrid",
      "pages": ["/catalog", "/product/aquapro-x200"], "match": "any",
      "viewports": ["D", "M"], "detector_id": "price_first_viewport", "claim_kind": "not_in_first_viewport",
      "assertion": "absence", "categories": ["pricing"], "page_groups": ["category", "product"],
      "evidence": { "type": "screenshot", "source_class": "OBSERVED", "self_confirming": true },
      "expected_confidence": "VERIFIED", "region_marker": "d10", "mutant": "m10" } ],
  "clean": { "fixture": "shop-clean", "deterministic_findings_max": 0, "support_facts_max": 0 } }
```
Для LLM-дефектів: `detector_id: null`, `support_detector_id`, `expected_confidence: null` (⏭️), `evidence.source_class:
"INFERRED|SYNTHETIC"`. `categories`/`page_groups` — точно з SCORING_SPEC §8.1. Раннер E1 читає лише EXPECTED.json.

## 9. Зведена таблиця
| # | Тип | detector_id | Предикат (без часу) | V | Клас доказу → впевненість | Мутант |
|---|---|---|---|---|---|---|
| 1 | LLM | — (опора `h1_category_overlap`) | LLM; опора: H1 ∩ категорії = ∅ | D,M | INFERRED/SYN + ET-SUP | — |
| 2 | дет. | `shipping_depth` | product: ¬SHIP_RE видимого тексту ∧ ¬посилання SHIP_RE ⇒ ≥ 2 кліки | D∪M | OBSERVED dom → VERIFIED* | M2 |
| 3 | LLM | — (опора `term_unexplained`) | LLM; опора: термін ніде не пояснено | D | INFERRED/SYN + ET-SUP | — |
| 4 | гібрид→LLM | — (опора `similar_products`) | LLM; опора: схожість назв ≥ 0,8 | D | SYN + ET-SUP | — |
| 5 | дет. | `cta_below_fold` | product: ∃ CTA ∧ max vis(FV) < 0,5 | D,M | OBSERVED dom → VERIFIED | M5 |
| 6 | дет. | `axe:button-name` (`link-name`,`label`) | ≥ 1 violation | M | BENCHMARKED axe → VERIFIED | M6 |
| 7 | дет. | `horizontal_overflow` | scrollWidth − 390 ≥ 2 | M | OBSERVED dom → VERIFIED | M7 |
| 8 | дет. | `oversized_image` | image body_bytes ≥ 512 000 | D,M | OBSERVED (+Lighthouse BENCHMARKED) → VERIFIED | M8 |
| 9 | дет. | `axe:image-alt` | ≥ 1 violation | D,M | BENCHMARKED axe → VERIFIED | M9 |
| 10 | дет. | `price_first_viewport` | product/category: 0 PRICE_RE у FV | D,M | OBSERVED screenshot+dom → VERIFIED* | M10 |
`*` — твердження відсутності: VERIFIED лише за повного захоплення (§4), інакше ET-INC → HYPOTHESIS.

## 10. Що перевіряє sl-qa-tester (артефакти `planning/qa/artifacts/sprint-1a/`)
Фікстура: 7/7 детекторів спрацювали, region ∩ `data-fx` ≠ ∅, confidence VERIFIED. Мутанти: 7/7 → 0, решта незмінна.
Чисті: 0. Контроль DEV-17: фікстура з одним same-origin `fetch(…,{method:'POST'})` на завантаженні (блокує шар 2 → `blocked_requests_count=1`) → №10/№2 дають HYPOTHESIS,
не VERIFIED (предикат уміє впасти). 3 прогони → побайтово однаковий `findings.json`.
