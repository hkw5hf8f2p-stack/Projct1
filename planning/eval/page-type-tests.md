# Page-type tests — метаморфний набір `fixtures/shop` і юніт-кейси класифікатора (S1a-fix, DEV-32)

Автор: `sl-eval-science`, 29.09.2026. Специфікація: `page-type-spec.md`. Очікування зафіксовано до коду.
**Статус:** регресія (той самий автор фікстури й детекторів) — **не** held-out; held-out — twin2 після тегу v2 (DEV-33).

## 1. Метаморфний набір (CI, прапорець сервера `FIXTURE_TRANSFORM=<id>[,<id>]`, поєднується з `FIXTURE_MUTANT`)
Базова множина спрацювань `S₀` на `shop` = {№2, №5, №6, №7, №8, №9, №10} (класи детекторів, VERIFIED), типи сторінок
`T₀`: `/`→homepage, `/catalog`→category, 3 × `/product/<slug>`→product, `/product/<slug>/configure`→other,
`/help`→other|faq, `/help/shipping`→info_shipping, `/about`→about. Трансформація змінює **усі** внутрішні посилання
узгоджено; посилання deny-list (`?action=delete`, `?add-to-cart=`, `/logout`) зберігають свої тригери; `data-fx`
не змінюються. Сторінки-джерела дефектів (№7/№9 на `softline-s1`) лишаються досяжними в межах crawl 12/3.

| ID | Трансформація | Приклад product / category | Очікування |
|---|---|---|---|
| U1 | query-параметр | `/index.php?p=aquapro-x200` · `/index.php?c=catalog` | S = S₀, T = T₀ |
| U2 | OpenCart-маршрут | `/index.php?route=product/product&product_id=1` · `route=product/category&path=20` | S₀, T₀ |
| U3 | числові id | `/p/1001` · `/c/7` (configure `/p/1001/cfg`) | S₀, T₀ |
| U4 | вкладені каталоги | `/dim/filtry/aquapro-x200/` · `/dim/filtry/` | S₀, T₀ |
| U5 | плоскі `.html` | `/aquapro-x200-1001.html` · `/katalog.html` | S₀, T₀ |
| U6 | trailing slash скрізь | `/product/aquapro-x200/` · `/catalog/` | S₀, T₀ (дедуплікація crawl без змін) |
| U7 | верхній регістр | `/PRODUCT/AquaPro-X200` · `/CATALOG` | S₀, T₀ |
| U8 | локалізовані сегменти | `/uk/tovary/aquapro-x200` · `/pl/produkty/…` · `/товар/aquapro-x200` (percent-encoded) | S₀, T₀ |
| U9 | нейтральний шлях | `/x/7f3a` · `/y/2b` (жодної URL-підказки) | S₀, T₀ (P7 = 0: product 4,5 ≥ 4) |
| V1 | CTA-синоніми (таксономія іншого агента) | «Add to basket», «Dodaj do koszyka», «Замовити зараз» | S₀, T₀ |
| V2 | CTA поза словником | «Далі», «→» з `aria-label="Далі"` | S₀, T₀ (product = P3 без +0,5) |
| V3 | мова сайту EN | nav/h1/CTA/довідка англійською; «Shipping & payment» у `/help` | S₀, T₀ |
| E1 | CTA як `<a class="btn" href="…?add-to-cart=1">` | посилання в deny-list, не відкривається | S₀, T₀ (№5 за роллю) |
| E2 | CTA як `<input type="submit" value="…">` | у тій самій POST-формі | S₀, T₀ |
| E3 | CTA як `<a role="button">` / `<div role="button" tabindex="0">` | стиль кнопки | S₀, T₀ |
| K1 | 2 картки на `/catalog` | `softline-s1` — посилання з головної «Новинка» | S₀, T₀ (category = 3 бали) |
| K2 | картки з ціною на лістингу (лише разом з M10) | — | M10 → №10 = 0, решта S₀∖{№10} |
| J1 | JSON-LD `Product` на товарах | — | S₀, T₀ |
| J2 | `og:type=product` на товарах | — | S₀, T₀ |
| J3 | JSON-LD `ItemList` з `Product` на `/catalog` | — | S₀; `/catalog` лишається category |
| R1 | додати GET-кошик `/cart-view`: h1, 1 рядок (кількість + «1 200 грн» з U+00A0), сума, кнопка «Оформити» | посилання в шапці | S₀; `/cart-view`→cart; №2/№5/№10 на ньому = 0 |
| R2 | R1 + форма оформлення (`autocomplete=email tel street-address`) | `/checkout-view` | S₀; →checkout; 0 №2/№5/№10 |
| R3 | блок «Схожі товари» (3 картки) під CTA на товарах | — | S₀; товари лишаються product |
| T1 | (DEV-40) `/about` із 3 картками «команда» (фото + ім'я-посилання `?member=N`, без цін) | — | S₀; `/about` → about (не category) |

**Формати цін** (P1…P9, застосовуються до ціни на `configure` і до M10): `2 499 грн`, `2 499 грн` (U+00A0),
`2 499 грн` (U+202F), `₴2499`, `2.499,00 €`, `€2,499.00`, `£2,499`, `$24.99`, `2 499,00 zł`, `2 499 UAH`.
Очікування: базова фікстура — S₀, T₀ (`configure` лишається other: немає P3); **M10 × кожен формат** — №10 = 0, решта
незмінна. `від 2 499 грн` на M10 — №10 **лишається** (виключення map §3.10/DEV-27), тип сторінок не змінюється.
**Чиста пара:** кожна U/V/E/K/J/R-трансформація, застосована до `shop-clean`, → 0 детермінованих спрацювань.
**Предикат набору:** для кожного рядка `S == очікування` і `T == T₀` (+ нові сторінки R1/R2), 0 не-GET; падіння
будь-якого рядка = регресія (без підгонки порогів без DEV). Контроль, що набір уміє впасти: `FIXTURE_TRANSFORM=U5`
на детекторах `s1a-detectors-frozen` (v1) **має** дати S ≠ S₀ (очікується втрата №2, №5, №10).

## 2. Юніт-кейси `classifyPageType` (чиста функція над полями захоплення, spec §7)
Позначення: P1 structured, P2 головна ціна, P3 первинна дія (роль), lex = словник CTA, P4 один h1, P5 медіа,
K = картки (к-сть, з img/ціною), C = ознаки кошика, URL — лише як підказка.
| # | Вхідні ознаки | Бали | Очікуваний тип |
|---|---|---|---|
| 1 | P3 (button у POST-формі, лише hidden) + lex, P4, P5 390×240 під h1, без ціни, URL `/product/x` | P 5 | product |
| 2 | як 1, URL `/x-1001.html`, CTA «Далі» (без lex) | P 4,5 | product |
| 3 | P4, P2 «1 200 грн» (U+00A0) під h1, P3 = `<a>` з фоном поруч із ціною (не lex), P5, URL плоский | P 6,5 | product |
| 4 | P4, P2, без P3, без P5, URL `/product/x/configure` | P 3,5, без P1/P3 | other |
| 5 | P4, 3 картки (img 120×120 + посилання + `.btn` «В кошик» у картці), без цін | K 4; P3 = 0 (дії в картках) | category |
| 6 | P4, 2 картки (img + посилання), без цін, URL без підказки | K 3 | category |
| 7 | 2 картки з цінами, без img | K 4 | category |
| 8 | P4 «Кошик», 1 рядок: `input[type=number]` + ціна; сума = ціна рядка; помітна кнопка «Оформити»; URL `kosh.html` | C 3,5; P ≥ 4 | cart (вето) |
| 9 | форма: `autocomplete` email + tel + street-address; одна сума; кнопка submit | C 2+ (C3) | checkout |
| 10 | JSON-LD `Product` (верхній рівень), h1 відсутній (назва в h2), P2, P3 | P 7 | product |
| 11 | JSON-LD `ItemList` із 12 `Product`, 12 карток із цінами, пагінація | K 5,5; P1 = 0 | category |
| 12 | product-ознаки (P2, P3, P4, P5) + 4 картки «Схожі» нижче P3 | P 6, K 4 | product (правило 2) |
| 13 | `is_home`, 4 картки «Популярне», hero-зображення, без P3 | K 4 | homepage |
| 14 | `is_home`, JSON-LD `Product`, P2, P3 (односторінковий магазин) | P 8 | product |
| 15 | P4, POST-форма з `textarea` + email, кнопка «Надіслати»; словник «Про нас» | P3 = 0 | about |
| 16 | 6 × `details>summary`, P4 | F1 | faq |
| 17 | P4, P3 = button «Далі» (форма без полів), `img` 120×120, без ціни, без P1 | P 3 | unknown(product_likely): №2/№10 ET-INC, №5 ≤ HYPOTHESIS |
| 18 | `og:type=product`, P4, P3 | P 6 | product |
| 19 | HTTP 200, `visible_text_length = 90` (бот-стіна) | — | unknown(capture): утримання |
| 20 | D: product (P 4,5); M: P3 прихована (P 2,5) | розбіжність D/M | unknown(product_likely) |

**Парсер цін** (окремі кейси): так — `2 499 грн`, `2 499 грн`, `₴2499`, `2.499,00 €`, `€2,499.00`, `£2,499`,
`$24.99`, `2 499,00 zł`, `2 499 UAH`, `від 1 200 грн` (prefix_from); ні — `2026`, `+380 67 123 45 67`, `12.10.2026`,
`30 днів`, `-15 %`, `4.8 (120 відгуків)`.
**`classifyLink`:** посилання в групі карток → product; пункт nav «Товари» без URL-підказки → shop_category 0,90;
`/kosh.html` або іконка з лічильником → cart 0,10; `/p/1001` поза картками й nav → other 0,30 (+0,05 URL).
