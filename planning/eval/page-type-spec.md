# Page-type spec — структурний класифікатор типу сторінки й посилань crawl (S1a-fix, DEV-32)

Автор: `sl-eval-science`, 29.09.2026. Замінює map §1 «Page type» і DEV-26. Пороги зафіксовано **до** коду й до прогону
twin2; зміна — лише рядком у DEVIATION_LOG. Регресія: `page-type-tests.md` (метаморфний набір + юніт-кейси).
Принцип: тип = сума **структурних** ознак (DOM, геометрія, форми, schema.org); URL і словник — лише підсилення ≤ 0,5,
ніколи не достатні самі. Жоден рядок/шлях/слово фікстур чи двійника (`tovar-`, «Обрати», `kosh`) як правило — M2.

## 1. Типи
`homepage` · `category` (лістинг) · `product` · `cart` · `checkout` · `info_shipping` · `about` · `faq` · `other` ·
`unknown`. `other` = впевнено «жоден із названих»; `unknown` = не можемо вирішити (захоплення недостатнє або смуга
невизначеності §4). `is_home` — окремий прапорець (корінь origin / фінальний URL seed / `link[rel=canonical]` = корінь).

## 2. Ознаки (обчислюються в сторінці на D; M — перевірка узгодженості, §4)
Зона `main` = `<main>`/`[role=main]`, інакше документ мінус `header|nav|footer|aside|[role=banner|navigation|
contentinfo]`. Усі ознаки — лише видимі елементи (map §1).
**Картки (K1).** Група = ≥ 2 сестринські (або кузени через спільного предка ≤ 2 рівні) вузли в `main` з однаковою
DOM-сигнатурою (послідовність тегів нащадків до глибини 3, без класів/id/тексту), ширина в межах ±20 %, кожен містить
same-origin посилання на **різні** URL і (`img` з площею ≥ 2 500 px² **або** ціну). Елементи всередині групи — «у картці».
**Ціна.** Узагальнений парсер (у сторінці, не лише PRICE_RE): число `\d{1,3}([ .,'   ]\d{3})*([.,]\d{1,2})?`
або `\d+([.,]\d{1,2})?` поруч (≤ 1 пробіл/NBSP, у тому ж або сусідньому текстовому вузлі) із символом/кодом валюти
`₴ грн UAH € EUR $ USD £ GBP zł PLN` (до/після); допустимий префікс `від|from|od|ab`. Не ціна: телефон, дата, рік
без валюти, відсотки, кількість. **Головна ціна (P2):** ціна поза карткою; кластер цін у блоці ≤ 200 px (стара/нова,
закреслена) = одна ціна; «одна головна» = рівно один кластер з найбільшим `font-size×площа`, у межах 1·vh від h1.
**Первинна дія (P3).** Кандидати: `button`, `input[type=submit|button|image]`, `[role=button]`, `a` зі стилем кнопки
(непрозорий фон або рамка + padding ≥ 6 px). Первинна = найпомітніша в `main` поза картками: `площа × (фон ? 1 : 0,5)`,
площа ≥ 1 800 px² і висота ≥ 32 px (D), не `disabled`. Роль дії: її форма (якщо є) **не** має полів вільного тексту
(`textarea`, `input[type=text|email|tel|password|search]`; `hidden/number/select/radio` дозволені); `a` не веде на
сторінку з nav/header (тобто не навігація). Словник CTA (зовнішня таксономія EN/UK/PL, не з двійника) — лише +0,5.
**Інше.** P1 structured: JSON-LD `@type ∈ {Product, ProductGroup}` верхнього рівня (не всередині `ItemList`),
microdata `itemtype=…/Product` поза картками, `og:type ∈ {product, product.item, og:product}`. P4 рівно один видимий h1.
P5 медіа товару: `img`/`picture` у `main` поза картками, площа ≥ 60 000 px² (D) або ≥ 40 % ширини main, верх ≤ 1·vh
від h1. P6 варіанти/кількість у формі дії (`select`, `radio`, `input[type=number]`). P7 URL-підказка (будь-яка форма:
сегмент `product|products|p|item|goods|dp|produkt|tovar\w*`, `[-_/]\d{3,}(\.html?)?$`, `?(product_)?id=|?p=`,
`route=product/product`), регістр і trailing slash ігноруються.
**Кошик/оформлення.** C1 позиції: ≥ 1 рядок (`tr`/повторюваний блок) з ціною **і** контролем кількості (`input[type=
number]`, ± кнопки, `select` чисел) або ≥ 2 рядки з ціною й кнопкою видалення. C2 підсумок: ціна, що дорівнює
Σ цін рядків (±1 %), або ціна з `font-weight ≥ 600` під/після рядків. C3 поля оформлення: ≥ 2 `autocomplete` із
{`email`, `tel`, `name`, `street-address`, `address-line1`, `postal-code`, `cc-number`, `shipping *`}. C4 URL-підказка
`cart|checkout|basket|bag|kosh\w*|koszyk|korzin\w*|warenkorb|panier|order` +0,5; C5 словник «Разом/Total/Razem» +0,5.
**Інфо.** F1 FAQ: `FAQPage` JSON-LD або ≥ 3 `details>summary` або ≥ 3 заголовки, що закінчуються «?». S1 доставка:
SHIP_RE у h1/title або ≥ 2 абзаци з SHIP_RE. A1 about: `AboutPage`/`Organization` як головний тип, або словник
h1/URL. Інфо-типи дозволено визначати словником: вони **не** гейтять №2/№5/№10, лише пріоритет crawl.

## 3. Бали й пороги
| Клас | Бали | Поріг |
|---|---|---|
| product | P1 +3 · P2 +2 · P3 +2 (+0,5 словник, +0,5 близькість ≤ 1·vh до h1/ціни) · P4 +1 · P5 +1 · P6 +0,5 · P7 +0,5 | `P ≥ 4 ∧ (P1 ∨ P3)` |
| — штрафи product | група карток займає ≥ 40 % висоти main **і** стоїть вище P3 −3 · форма P3 з вільним текстом → P3 = 0 | |
| category | K1 (≥ 2 картки) +3 · ≥ 3 картки або ціни в картках +1 · JSON-LD `ItemList`/`CollectionPage` +1 · пагінація/сортування/фільтр (`rel=next`, `?page=`, `select` ≥ 3 опції над групою) +0,5 · URL +0,5 | `K ≥ 3` (K1 обов'язкова) |
| cart / checkout | C1 +2 · C2 +1 · C3 +2 · C4 +0,5 · C5 +0,5; checkout, якщо C3, інакше cart | `C ≥ 2 ∧ (C1 ∨ C2 ∨ C3)` |
| faq / info_shipping / about | F1 / S1 / A1 | ознака є |
Смуга невизначеності product: `2,5 ≤ P < 4 ∧ (P1 ∨ P3)` → `unknown` з `reason: product_likely`.
Без P1 і без P3 сторінка **не** product ні за яких балів (сторінка комплектації «h1 + ціна» → `other`).

## 4. Пріоритети при конфлікті (перший, що спрацював)
0. Захоплення недостатнє (map §4 п.3: не 2xx, навігація не завершена, бот-стіна, `visible_text_length < 200`) →
   `unknown(capture)`.
1. **Кошик/оформлення — вето:** `C` пройшов поріг → `cart|checkout`, **ніколи** product/category (кошик з h1,
   однією сумою й помітною кнопкою «Оформити» — саме випадок двійника-1).
2. product і category обидва пройшли: `product`, якщо P3 і головна ціна (якщо є) поза картками **і** h1 вище першої
   групи карток (блок «схожі товари» під товаром); інакше `category` (дії «в кошик» у картках не є P3).
3. `is_home`: product ≥ 4 → `product` (односторінковий магазин); інакше `homepage` (вітрина з картками — не лістинг).
4. product → 5. category → 6. смуга `product_likely` → `unknown` → 7. faq > info_shipping > about → 8. `other`.
Узгодженість D/M: тип рахується на D і M; розбіжність product↔інше → `unknown(product_likely)`, якщо max(P) ≥ 2,5,
інакше `other`. Вихід: `{page_type, is_home, scores:{P,K,C}, features:[…], reason}` у capture (для аудиту й тестів).

## 5. Поведінка детекторів за типом
| Тип | №2 `shipping_depth` | №5 `cta_below_fold` | №10 `price_first_viewport` | №6–№9 |
|---|---|---|---|---|
| product | так (CTA-кандидати = P3 + словник) | так | так | так |
| unknown(product_likely) | так, доказ **ET-INC** | так, знахідка ≤ HYPOTHESIS | так, доказ **ET-INC** | так |
| category | ні | ні | так (FV: ≥ 1 ціна картки або головна ціна) | так |
| cart / checkout | ні | ні | ні | так |
| homepage, info_*, about, faq, other | ні | ні | ні | так |
| unknown(capture) | утримання (map §4 п.3) | утримання | утримання | за наявності axe/DOM |
- **Не мовчати (DEV-17/DEV-19):** на `product_likely` детектори відсутності запускаються; доказ `capture_complete=false`,
  `incomplete_reasons += ['page_type_uncertain']` → ET-INC, знахідка ≤ HYPOTHESIS. Кожне «ні»/«утримання» пишеться
  рядком покриття `{detector_id, page, status: not_applicable|withheld|capped, reason}` у артефакт і в розділ звіту
  «Не перевірено» — відсутність спрацювання ≠ відсутність дефекту.
- №5: кандидат CTA = P3 (роль) ∪ збіги словника; без жодного — мовчить (map §3.5, не твердження відсутності).
- №10: у `measurement` — `first_price_x`, `first_price_y`, `reason ∈ {none_on_page, below_fv, off_fv_horizontal}`;
  текст доказу називає причину (двійник-1: ціна y=282, x=447 при vw=390 — «ціни немає» було самосуперечливим).
  Виключення «від/from» map §3.10 / DEV-27 для №10 цим документом **не** змінюється (для класифікатора «від» — ціна).

## 6. Посилання crawl (`classifyLink`, SPEC §13)
До захоплення клас посилання береться з **контексту на сторінці-джерелі**, URL — лише розв'язання нічиїх (+0,05):
| Контекст посилання | Клас · пріоритет |
|---|---|
| корінь origin | homepage 1,00 |
| посилання в групі карток K1 | product 0,95 (кап ≤ 3, farthest-first за текстом картки + ціною) |
| найпомітніше посилання/кнопка в main головної; пункт nav/header без інфо-збігу | shop_category 0,95 / 0,90 |
| словник/URL інфо (EN/UK/PL): shipping · faq · about · contact · blog · legal | 0,80 · 0,75 · 0,60 · 0,55 · 0,20 · 0,10 |
| cart/checkout/account/login (URL C4, іконка з лічильником) | cart 0,10 (ніколи product) |
| решта | other 0,30 |
Після захоплення клас у журналі замінюється `page_type`; кап «≤ 3 продукти» рахує **захоплені** сторінки типу product
(прогноз «product», що виявився category, не витрачає кап, а його картки йдуть у frontier). Ліміти 12/3 — без змін.

## 7. Потрібні поля захоплення (для sl-core-engineer)
`og_type`, `microdata_types` (з ознакою «у картці»), `landmark` для кожного link/interactive/price/img, `card_groups`
(сигнатура, вузли, rect), для interactive: `bg_opaque`, `border`, `padding`, `form:{method, free_text:boolean,
has_variants}`, для price: `value`, `currency`, `font_size`, `in_card`, `prefix_from`; `h1_rect`; `autocomplete_tokens`;
`details_count`; `canonical`. Класифікатор — чиста функція над цими полями (юніт-тести без браузера).

## 8. Межі й ризики
- Товар «немає в наявності» (без P3) → `other`/`unknown`: FN №2/№5/№10 прийнятний, рядок покриття його показує.
- Ціна картинкою/`canvas` — не P2 (R-28); product лишається за P3+P4+P5.
- SPA без `main` і з кнопками-`div` без `role` → P3 може не знайтись; вимір на живих (⏭️ S1b: ≥ 10 магазинів, ручна
  розмітка, recall product ≥ 0,8, cart→product = 0 — предикат критика §5.2).
- Метаморфний набір — регресія того самого автора, **не** held-out; held-out = twin2 після тегу v2 (DEV-33).
