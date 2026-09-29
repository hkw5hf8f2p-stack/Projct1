# SCORING_SPEC — точні визначення для `packages/scoring` і `packages/reporting/guard.ts`

Автор: `sl-eval-science`. Дата: 29.09.2026. Версія: `scoring-v1`.
Джерела: `docs/SOURCE/SPEC.md` (§N), `docs/SPEC_REVIEW_UK.md` (рецензія, пріоритет). Обґрунтування й
ризики: `planning/FEASIBILITY_EVAL.md`.

**Загальні правила реалізації**
- Усе нижче — чисті функції без I/O, мережі й LLM. Вхід: об'єкти БД/схем. Вихід: числа, мітки, списки.
- LLM лише **класифікує** в закриті enum (`category`, `claim_kind`, `task_type`, `stage` для сторінок
  невідомого типу). Будь-яке число ставить код за таблицями цього документа.
- Кожна таблиця нижче — це константа в коді (`as const`) із тим самим ID. Зміна значення: нова
  версія `scoring-vN` і запис у цьому файлі.
- Детермінізм: жодних `Math.random`, жодної залежності від порядку вхідних масивів. Tie-break — за
  стабільними ID (хеш вмісту).
- Float-порівняння й округлення — через `EPS = 1e-9` (§6.3).

> **Узгоджено на гейті 0 (29.09.2026, sl-pm).** Доповнення з рішень гейту 0 позначені «(G0-N)»: §2 — твердження
> відсутності (G0-10, DEV-17); §8.1 — E1 двома числами (G0-7); §8.3 — специфічність E3a і база E3c (G0-9). Решта — без змін.

---

## 1. Докази та `evidence_strength` (§23, §26)

### 1.1 Поля доказу, що впливають на оцінку

```ts
type SourceClass = 'OBSERVED' | 'BENCHMARKED' | 'INFERRED' | 'SYNTHETIC';
type EvidenceType = 'screenshot'|'dom'|'accessibility'|'lighthouse'|'axe'
                  |'browser_session'|'repeated_agent_observation';

interface Evidence {
  id: string;
  type: EvidenceType;
  source_class: SourceClass;
  page_url: string;
  // Встановлює ЛИШЕ код детектора. Ніколи не парситься з виводу LLM (в LLM-схемах поля немає).
  self_confirming: boolean;
  detector_id?: string;          // напр. 'cta_below_fold', 'axe:image-alt'
  claim_kind?: string;           // див. §5
  session_id?: string;           // для SYNTHETIC
  lens_id?: string;
  task_id?: string;
  level?: 'snapshot' | 'journey';
  browser_failure?: {            // лише для технічних збоїв браузера, не для «агент здався»
    kind: 'not_actionable'|'obscured'|'http_error'|'nav_timeout'|'blocked_overlay';
    selector?: string;
    reproduced_by_replay: boolean;   // детермінований повтор тієї ж послідовності дій
  };
}
```

### 1.2 Рівні сили (ET = evidence tier)

| ID | Умова (перевіряється за порядком, береться перша, що виконалась) | strength |
|---|---|---|
| ET-DET | `source_class ∈ {OBSERVED, BENCHMARKED}` **і** `self_confirming` | **1.00** |
| ET-BRW | `browser_failure` є і (`reproduced_by_replay` **або** той самий `(page, selector, kind)` у ≥ 2 різних журналах) | **0.90** |
| ET-SYN-M | SYNTHETIC, і ключ знахідки підтримують ≥ 2 **різні** `session_id` | **0.70** |
| ET-SYN-1 | SYNTHETIC, рівно 1 `session_id` | **0.40** |
| ET-INF | INFERRED | **0.30** |
| ET-INC | OBSERVED, `self_confirming = false`, `capture_complete = false` — доказ відсутності (або позиційний при `banner_state='open'`) з неповного захоплення (DEV-19) | **0.30** |
| ET-SUP | OBSERVED/BENCHMARKED, але `self_confirming = false` (опорний факт), `capture_complete ≠ false` | **не рівень сили**; впливає лише на впевненість (§2) |

Примітки:
- Кілька семплів самоузгодженості однієї snapshot-сесії — це **одна** сесія.
- «Агент не впорався із задачею» — це SYNTHETIC, а не ET-BRW. ET-BRW — лише технічний збій, який
  бачить Playwright (actionability error, HTTP ≥ 400, timeout, перекриття оверлеєм).

```ts
function evidenceStrength(f: Finding): number {
  const tiers = f.evidence.map(tierOf);           // null для ET-SUP
  const synSessions = distinct(f.evidence.filter(e => e.source_class==='SYNTHETIC').map(e => e.session_id));
  let s = 0;
  if (tiers.includes('ET-DET')) s = 1.00;
  else if (tiers.includes('ET-BRW')) s = 0.90;
  else if (synSessions.length >= 2) s = 0.70;
  else if (synSessions.length === 1) s = 0.40;
  else if (tiers.includes('ET-INF') || tiers.includes('ET-INC')) s = 0.30;   // ET-INC — DEV-19
  else throw new Error('finding without strength-bearing evidence'); // §23: відкинути
  return s;
}
```

Знахідка лише з ET-SUP (опорний факт без інтерпретації) не є знахідкою. Це або перетворюється на
детектор із `self_confirming`, або відкидається.

---

## 2. Рівень впевненості (§27, рецензія C3)

Родини доказів (незалежні джерела):

| Родина | Що входить | LLM-похідна? |
|---|---|---|
| F-DET | ET-DET | ні |
| F-SUP | ET-SUP | ні |
| F-BRW | ET-BRW | ні (збій бачить браузер) |
| F-SYN | усі SYNTHETIC | **так** |
| F-INF | усі INFERRED | **так** |
| F-INC | ET-INC (DEV-19) | ні, але **не** входить у `nonLlm` для STRONG(a) |

```ts
function confidence(f: Finding): 'VERIFIED'|'STRONG_HYPOTHESIS'|'HYPOTHESIS' {
  const fam = families(f);                                  // Set<'F-DET'|...>
  // VERIFIED: є доказ, що сам підтверджує проблему (C3)
  if (fam.has('F-DET')) return 'VERIFIED';
  if (fam.has('F-INC')) return 'HYPOTHESIS';                // DEV-17/DEV-19: кап незалежно від SYN
  if (fam.has('F-BRW') && f.evidence.some(e => e.browser_failure?.reproduced_by_replay)) return 'VERIFIED';

  // STRONG (a): ≥2 незалежні родини, з них хоча б одна не LLM-похідна.
  //   SYN + INF — це одна модель, тож разом вони НЕ дають двох незалежних родин.
  const nonLlm = ['F-SUP','F-BRW'].filter(x => fam.has(x)).length;
  if (fam.size >= 2 && nonLlm >= 1) return 'STRONG_HYPOTHESIS';

  // STRONG (b): ≥3 лінзи в ≥2 контекстах (C3). Одна сесія має одну лінзу, тому «≥2 сесії»
  //   виконується автоматично. Контекст = (task_id, level): щонайменше 2 різні задачі
  //   або snapshot + journey.
  const syn = f.evidence.filter(e => e.source_class === 'SYNTHETIC');
  const lenses = distinct(syn.map(e => e.lens_id));
  const contexts = distinct(syn.map(e => `${e.task_id}|${e.level}`));
  if (lenses.length >= 3 && contexts.length >= 2) return 'STRONG_HYPOTHESIS';

  return 'HYPOTHESIS';
}
```

**Твердження відсутності (G0-10, DEV-17, обов'язкове).** Якщо F-DET-доказ стверджує **відсутність** (`claim_kind` на
кшталт `absent_in_first_viewport`, `absent_on_page`, `not_found_within_depth`), він дає VERIFIED лише коли захоплення
сторінки повне: `PageArtifact.blocked_requests_count` до цільового origin = 0, `js_error_count` (неперехоплені) = 0,
`banner_state ∈ {none, closed}`, `scroll_completed = true`. Інакше доказ лишається OBSERVED з приміткою «можлива
неповнота захоплення», **не** входить у F-DET для `confidence()`, і знахідка отримує щонайбільше HYPOTHESIS (рівень ET-INC, родина F-INC, strength 0.30 — DEV-19). Тест-таблиця
нижче доповнюється двома рядками: «відсутність ціни, повне захоплення → VERIFIED» і «те саме, 1 заблокований запит →
HYPOTHESIS».

**Правило суперечності (обов'язкове).** Якщо детектор того самого `claim_kind` запускався на тій самій
сторінці й повернув **негатив** (наприклад, LLM каже «ціни не видно», а детектор знайшов ціну в
першому вікні), то:
- впевненість обмежується рівнем `HYPOTHESIS`;
- картка показує OBSERVED-контрдоказ;
- знахідка не потрапляє в топ-5 executive summary.

Виняток — `claim_kind` про сприйняття (`noticed_but_unclear`, `visible_but_not_salient`), де
детектор перевіряє лише наявність.

**Відображення.** Жодних відсотків впевненості (§27). Поле `confidence` з агентного виводу §21 —
лише внутрішнє, у формули не входить.

Тест-таблиця (мінімум):

| Випадок | Очікування |
|---|---|
| лише axe `image-alt` | VERIFIED |
| SYN у 5 сесіях, 5 лінз, 1 задача, лише snapshot | HYPOTHESIS (1 контекст) |
| SYN 3 лінзи, 2 задачі | STRONG |
| SYN 2 лінзи + INF | HYPOTHESIS (обидві LLM-похідні) |
| SYN 1 лінза + ET-SUP | STRONG |
| ET-BRW у 2 журналах без replay | STRONG (F-BRW + F-SYN) |
| ET-BRW із replay | VERIFIED |
| STRONG, але детектор повернув негатив | HYPOTHESIS + контрдоказ |
| відсутність ціни, повне захоплення (DEV-17) | VERIFIED |
| те саме, 1 заблокований запит до цільового origin (ET-INC) | HYPOTHESIS, strength 0.30 (DEV-19) |
| те саме + SYN 3 лінзи / 2 контексти | HYPOTHESIS (кап DEV-17, DEV-19) |

---

## 3. Severity за категорією (§22, рецензія C2)

### 3.1 Базова таблиця (SEV-BASE)

| category | base | Обґрунтування (коротко) |
|---|---|---|
| checkout | 0.85 | блокує завершення покупки |
| pricing | 0.80 | без ціни рішення неможливе |
| cta | 0.75 | не видно наступної дії |
| value_proposition | 0.75 | не зрозуміло, що продають |
| shipping | 0.70 | невідома повна вартість і строки |
| trust | 0.70 | ризик відмови на рішенні |
| product_selection | 0.65 | не вдається обрати |
| mobile_usability | 0.65 | ламає цілий канал |
| navigation | 0.60 | ускладнює, але є обхідні шляхи |
| missing_information | 0.60 | загальна прогалина |
| accessibility | 0.60 | *перевизначається axe impact (3.2)* |
| comparison | 0.55 | ускладнює вибір |
| performance | 0.55 | *перевизначається метриками (3.2)* |
| terminology | 0.45 | бар'єр переважно для новачків |
| visual_hierarchy | 0.45 | суб'єктивніша категорія |
| content_overload | 0.35 | рідко блокує |
| other | 0.30 | некласифіковане |

### 3.2 Перевизначення бази детермінованими джерелами

| Джерело | Умова | base |
|---|---|---|
| axe `impact` | critical / serious / moderate / minor | 0.70 / 0.60 / 0.40 / 0.20 |
| Lighthouse (performance) | LCP > 4.0 s **або** TBT > 600 ms (mobile) | 0.65 |
| Lighthouse (performance) | 2.5 s < LCP ≤ 4.0 s **або** 200 < TBT ≤ 600 ms | 0.45 |
| Lighthouse (performance) | лише opportunities (байти, формати), метрики в нормі | 0.30 |
| мережа | тіло зображення ≥ 512 000 байт (500 KiB) на сторінці першого етапу (DEV-20: час відповіді не використовується — R-9) | max(поточна, 0.45) |

Для кількох джерел в одній знахідці береться **максимум** перевизначень.

### 3.3 Модифікатори (детерміновані)

| ID | Умова | Δ |
|---|---|---|
| MOD-PAGE-PRIMARY | серед сторінок знахідки є `homepage`, `category`, `product`, `pricing`, `cart`, `shipping` | +0.05 |
| MOD-PAGE-SECONDARY | лише `faq`, `about`, `contact`, `services` | 0 |
| MOD-PAGE-PERIPHERAL | лише `blog`, `legal`, `other` | −0.10 |
| MOD-BLOCKER | ≥ 1 сесія з `success = false`, де ключ знахідки — **останній** зафіксований friction цієї сесії | +0.10 |

Модифікатора пристрою немає, бо пристрій — це фільтр (§45), а не вага. Модифікатора етапу теж немає:
етап уже враховує `funnel_proximity`, і подвійного рахунку не буде.

```ts
severity(f) = clamp01( round3( base(f) + pageMod(f) + blockerMod(f) ) )
// pageMod: максимальний з модифікаторів сторінок знахідки
```

---

## 4. Воронка й покриття

### 4.1 `funnel_proximity` — етапи §28 (FUN-STAGE)

| stage | value |
|---|---|
| landing | 0.30 |
| understand_offering | 0.45 |
| browse | 0.55 |
| select | 0.70 |
| evaluate_product | 0.80 |
| price_shipping_confidence | 0.90 |
| cart | 1.00 |

### 4.2 Визначення етапу знахідки

```ts
const CATEGORY_STAGE = {            // канонічний етап категорії, що переважає сторінку
  pricing: 'price_shipping_confidence',
  shipping: 'price_shipping_confidence',
  checkout: 'cart',
  product_selection: 'select',
  comparison: 'select',
} as const;

const PAGE_STAGE = {
  homepage: 'landing', blog: 'landing',
  about: 'understand_offering', contact: 'understand_offering', faq: 'understand_offering',
  legal: 'understand_offering', other: 'understand_offering',
  category: 'browse', services: 'browse',
  product: 'evaluate_product',
  pricing: 'price_shipping_confidence', shipping: 'price_shipping_confidence',
  cart: 'cart',
} as const;

stage(f) = CATEGORY_STAGE[f.category] ?? argmaxValue(f.pages.map(p => PAGE_STAGE[p.page_type]))
funnel_proximity(f) = FUN_STAGE[stage(f)]    // завжди застосовний
```

Для наскрізної знахідки (однакове axe-правило на кількох сторінках) береться максимальний етап серед
уражених сторінок.

### 4.3 Експозиція та три покриття (§24)

**Експозиція визначається через сторінки, а не через задачі.** Задача знахідки виводиться зі сесій, що
про неї повідомили, тож рахувати експозицію через задачі було б циркулярно.

```ts
// Сесія s «бачила» знахідку f, якщо оцінювала/відвідала хоча б одну сторінку f.
// Для наскрізної (site-wide) знахідки — будь-яку сторінку сайту.
exposed(s, f)  = s.pages_seen ∩ f.pages ≠ ∅
reported(s, f) = s.frictions.some(x => keyOf(x) === f.key)

S_exp = {s : exposed(s,f)};   S_rep = {s ∈ S_exp : reported(s,f)}

lens_coverage(f)     = |lenses(S_rep)| / |lenses(S_exp)|
session_frequency(f) = |S_rep| / |S_exp|
task_coverage(f)     = |tasks(S_rep)| / |tasks(S_exp)|     // лише показ і фільтри; у priority НЕ входить
```

Snapshot- і journey-сесії рахуються однаково (кожна = 1).

**Застосовність (рецензія C1):**

| Випадок | lens_coverage / session_frequency |
|---|---|
| `confidence = VERIFIED` | **N/A** завжди. Синтетичне підтвердження показується як доказ, але в оцінку не входить: інакше 1 лінза з 12, що погодилася, **знизила** б пріоритет перевіреного факту (немонотонність). |
| інакше, `S_exp ≠ ∅` | застосовні (значення може бути 0) |
| інакше, `S_exp = ∅` | застосовні зі значенням **0**. Неперевірена гіпотеза не отримує бонусу від перерозподілу ваг. |

---

## 5. Ключ агрегації (§24)

Кластеризація ембедингами нестабільна між прогонами (FEASIBILITY §2.3). Нормалізація детермінована:

```ts
finding_key = `${category}|${stage}|${pageGroup}|${claim_kind}`
// pageGroup: page_type для шаблонних сторінок (усі product → 'product'),
//            нормалізований шлях для одиничних (/, /shipping, /about).
// claim_kind: закритий enum на категорію; LLM обирає зі списку, інакше 'general'.
```

Приклади `claim_kind`:
- `shipping`: `not_on_product_page | collapsed_hidden | cost_unknown | time_unknown | deep_link_only`;
- `pricing`: `not_in_first_viewport | only_in_cart | total_unclear`;
- `cta`: `below_fold | ambiguous_label | competing_ctas`;
- `accessibility`: `axe:<rule-id>`;
- `mobile_usability`: `horizontal_overflow` (детектор `horizontal_overflow`);
- `performance`: `oversized_image` (детектор `oversized_image`, DEV-20).

Детектори й предикати — `planning/eval/fixture-defect-map.md`.

Детектори видають фіксований `claim_kind`. SYNTHETIC/INFERRED-скарги з тим самим ключем зливаються в
знахідку детектора й успадковують її твердження (текст проблеми — шаблон детектора, рецензія C4).
Заголовок, який формулює LLM, — лише для показу, і його теж перевіряє guard (§7).

axe: одна знахідка на `(rule-id, pageGroup)` з лічильником вузлів, а не одна на вузол.

---

## 6. Пріоритет (§25, рецензія C1)

### 6.1 Формула

```
W = { severity: 0.30, funnel_proximity: 0.20, lens_coverage: 0.20,
      session_frequency: 0.15, evidence_strength: 0.15 }

A(f)          = { i ∈ W : component i is applicable to f }     // severity, funnel, evidence — завжди
score(f)      = Σ_{i∈A} W_i · c_i(f)  /  Σ_{i∈A} W_i
priority(f)   = roundHalfUp(100 · score(f))                     // ціле 0..100
```

Інтерпретація: перерозподіл ваг рівнозначний тому, що N/A-компоненти заповнюються середньозваженим
застосовних. Це свідоме припущення, і воно діє лише для VERIFIED (§4.3). **Priority — це індекс
ранжування, а не розмір ефекту.** Показується як «Priority NN/100», ніколи поруч із словами
«конверсія» чи «uplift».

### 6.2 Інваріанти (юніт-тести)

1. `Σ_{i∈A} W_i ≥ 0.65` (severity + funnel + evidence завжди застосовні). Інакше кидаємо помилку.
2. VERIFIED з усіма застосовними = 1 → 100. Це доводить, що стелі 65 більше немає (C1).
3. Монотонність: збільшення будь-якого застосовного компонента не зменшує priority.
4. Додавання SYNTHETIC-доказу до VERIFIED-знахідки не змінює priority.
5. Незалежність від порядку доказів і сесій на вході.

### 6.3 Округлення

```ts
roundHalfUp(x) = Math.floor(x + 0.5 + 1e-9)
```

Без `EPS` значення 34.5, отримане як 34.49999999…, округлюється вниз. Див. приклад 4.

### 6.4 Розраховані приклади

**Приклад 1 — axe `image-alt` на сторінці товару** (BENCHMARKED, `self_confirming`, impact `critical`)

| компонент | значення | звідки |
|---|---|---|
| severity | 0.70 + 0.05 = **0.75** | axe critical (3.2) + MOD-PAGE-PRIMARY |
| funnel_proximity | **0.80** | категорія accessibility без канонічного етапу → product → evaluate_product |
| lens_coverage | N/A | VERIFIED |
| session_frequency | N/A | VERIFIED |
| evidence_strength | **1.00** | ET-DET |

```
score = (0.30·0.75 + 0.20·0.80 + 0.15·1.00) / (0.30+0.20+0.15)
      = (0.225 + 0.160 + 0.150) / 0.65 = 0.535 / 0.65 = 0.82308
priority = 82          (за старою формулою §25: 0.535·100 → 54)
confidence = VERIFIED
```

**Приклад 2 — доставку сховано; детектор + журнали**

Детектор `shipping_discoverability`: на сторінці товару немає видимого тексту про доставку, перше
згадування — на глибині 2 через футер. `claim_kind = not_on_product_page`, `self_confirming`. Крім
того, 6 з 8 синтетичних журналів шукали доставку, і в одному журналі з `success = false` останнім
friction був саме цей ключ.

| компонент | значення | звідки |
|---|---|---|
| severity | 0.70 + 0.05 + 0.10 = **0.85** | shipping + PRIMARY + BLOCKER |
| funnel_proximity | **0.90** | CATEGORY_STAGE[shipping] |
| lens_coverage / session_frequency | N/A | VERIFIED; «6 of 8 synthetic journeys» показується як доказ |
| evidence_strength | **1.00** | ET-DET |

```
score = (0.30·0.85 + 0.20·0.90 + 0.15·1.00) / 0.65 = (0.255 + 0.180 + 0.150) / 0.65 = 0.90
priority = 90, confidence = VERIFIED
```

**Приклад 3 — жаргон у назвах, лише синтетичні докази**

Категорія `terminology`, сторінка товару. Сторінку бачили 14 сесій 9 лінз у 2 задачах; повідомили
6 сесій від 5 лінз в обох задачах.

| компонент | значення | звідки |
|---|---|---|
| severity | 0.45 + 0.05 = **0.50** | terminology + PRIMARY |
| funnel_proximity | **0.80** | product → evaluate_product |
| lens_coverage | 5/9 = **0.5556** | |
| session_frequency | 6/14 = **0.4286** | |
| evidence_strength | **0.70** | ET-SYN-M |

```
score = 0.30·0.50 + 0.20·0.80 + 0.20·0.5556 + 0.15·0.4286 + 0.15·0.70
      = 0.150 + 0.160 + 0.1111 + 0.0643 + 0.105 = 0.5904      (Σ W = 1.0)
priority = 59, confidence = STRONG_HYPOTHESIS (5 лінз, 2 контексти)
```

**Приклад 4 (граничний) — чиста інференція, яку ніхто з сесій не підтвердив**

Нечіткий заголовок головної, лише INFERRED. Головну бачили 10 сесій, ніхто не повідомив.

```
severity = 0.75 + 0.05 = 0.80; funnel = 0.30 (landing); lens = 0; freq = 0; evidence = 0.30
score = 0.240 + 0.060 + 0 + 0 + 0.045 = 0.345
priority = roundHalfUp(34.5) = 35   (без EPS можна отримати 34), confidence = HYPOTHESIS
```

Порівняння прикладів 1 і 3 показує рівновагу після C1. Синтетична знахідка з тими самими
severity 0.75 і funnel 0.80 та ідеальним покриттям (1.0, 1.0, 0.70) дає
0.225 + 0.16 + 0.20 + 0.15 + 0.105 = 0.84 → 84. Детермінована дає 82. Жодна зі сторін не має
систематичної переваги.

### 6.5 Сортування й tie-break (детерміновано)

```
sort by: priority desc,
         confidenceRank desc   (VERIFIED 3 > STRONG 2 > HYPOTHESIS 1),
         evidence_strength desc,
         severity desc,
         funnel_proximity desc,
         finding_key asc       (порівняння рядків за code points, не localeCompare)
```

---

## 7. Report guard (§4, §33, рецензія D1)

Чиста функція `guard(text, ctx) → { ok, violations[] }` плюс цикл регенерації (§7.6).
`calibrated_mode` у MVP — **константа `false`**. Змінною середовища її не ввімкнути; для цього колись
знадобиться запис `CalibrationModel` (§59–61).

### 7.1 Нормалізація і межі слів

```ts
function normalize(t: string): string {
  return t.normalize('NFKC')
    .replace(/[    ]/g, ' ')    // NBSP, тонкий пробіл: «1 200 грн»
    .replace(/[’ʼ`]/g, "'")          // апострофи: об'єм, ʼ
    .replace(/[٪﹪％]/g, '%')          // варіанти знака відсотка
    .replace(/\s+/g, ' ');
}
```

**Межі слів — НЕ `\b`.** У JavaScript `\b` визначений лише для ASCII `[A-Za-z0-9_]`, навіть із прапорцем
`u`. Тому `/\bконверсія\b/u` не спрацює ніколи: між пробілом і «к» немає `\b`. Використовуємо:

```ts
const WL = String.raw`[\p{L}\p{N}_']`;
const B0 = String.raw`(?<!${WL})`;       // початок слова
const B1 = String.raw`(?!${WL})`;        // кінець слова
const rx = (body: string, flags = 'giu') => new RegExp(B0 + '(?:' + body + ')' + B1, flags);
```

Усі правила нижче — це тіла `body` для `rx()`. Регістр: `i`, **крім** абревіатур `TAM|SAM|SOM`, які
перевіряються без `i`: тоді «Tam»/«som» не спрацьовують, а межа слова відсікає «TAMPA».

Речення: розбиття за `(?<=[.!?…])\s+`, `\n` і пунктами списку. Правила G1/G2 застосовуються **в межах
речення**.

### 7.2 Лексичні класи

```ts
// Цільові слова (про бізнес-результат або населення)
TARGET_EN = String.raw`conversions?|conversion rates?|convert(?:s|ed|ing)?|sales|revenue|turnover|profits?`
          + String.raw`|market(?:s|\s+share|\s+size)?|customers?|clients?|buyers?|shoppers?|visitors?|users?|audience|people`
TARGET_UK = String.raw`конверс\p{L}*|продаж\p{L}*|вируч\p{L}*|дох[оі]д\p{L}*|прибут\p{L}*|обіг\p{L}*`
          + String.raw`|ринк\p{L}*|ринок|клієнт\p{L}*|покупц\p{L}*|покупець|відвідувач\p{L}*|користувач\p{L}*`
          + String.raw`|аудитор\p{L}*|людей|люди`

// Числові твердження
NUM_PCT   = String.raw`\d+(?:[.,]\d+)?\s?(?:%|percent|per\s?cent|pp|p\.p\.|percentage\s+points?|відсот\p{L}*|процент\p{L}*|в\.\s?п\.)`
NUM_MONEY = String.raw`[$€£₴]\s?\d[\d ,.]*(?:\s?(?:k|m|bn|тис\.?|млн|млрд))?`
          + String.raw`|\d[\d ,.]*\s?(?:k|m|bn|тис\.?|млн|млрд)?\s?(?:USD|EUR|UAH|GBP|грн\.?|гривень|гривні|гривня|доларів|долари|dollars?|euros?|євро)`
NUM_MULT  = String.raw`\d+(?:[.,]\d+)?\s?[x×х]|twice|double[sd]?|triple[sd]?|удвічі|вдвічі|вдвоє|втричі|подвої\p{L}*|потрої\p{L}*`
NUM_FRAC  = String.raw`half|a\s+third|a\s+quarter|majority|половин\p{L}*|третин\p{L}*|чверт\p{L}*|більшість`
// «most» свідомо не входить: «the most important customer task» дав би хибну тривогу
NUM_RATIO = String.raw`\d+\s?(?:of|out\s+of|in|/|з|із|зі|на\s+кожні)\s?\d+`

// Прогнозні дієслова (G2)
PRED_EN = String.raw`(?:will|would|could|can|may|might|should|is\s+going\s+to|likely\s+to|expected\s+to)\s+(?:\p{L}+\s+){0,2}`
        + String.raw`(?:increase|grow|boost|rise|improve|lift|double|drop|fall|decline|decrease|suffer)`
PRED_UK = String.raw`зросте|зростуть|збільшить(?:ся)?|збільшаться|підвищить(?:ся)?|виросте|виростуть|подвоїться`
        + String.raw`|впаде|впадуть|знизить(?:ся)?|зменшить(?:ся)?|покращить(?:ся)?`
        + String.raw`|(?:може|можуть|здатн\p{L}*)\s+(?:\p{L}+\s+)?(?:зрости|збільшити(?:ся)?|підвищити(?:ся)?|покращити|знизити|зменшити|впасти|подвоїти)`
```

### 7.3 Правила

**A. Специфічні правила (спрацьовують завжди, незалежно від чисел)**

| ID | Мова | body | Ловить | Не має ловити |
|---|---|---|---|---|
| R-TAM | обидві | `TAM\|SAM\|SOM` (без `i`) | «Your TAM is 4.2M» | «TAMPA», «Tamil», «som» |
| R-EN-01 | EN | `total\s+addressable\s+market\|market\s+size\|market\s+share\|share\s+of\s+(?:the\s+)?market` | «market size is» | «marketplace» (межа `B1`) |
| R-EN-02 | EN | `conversion(?:\s+rate)?s?\s+(?:will\|would)` | «conversion will rise» | «conversion path» |
| R-EN-03 | EN | `(?:increase\|boost\|improve\|raise\|lift\|decrease\|reduce\|drop)\s+(?:the\s+\|your\s+)?conversions?(?:\s+rates?)?\s+by` | «increase conversion by 12%» | «measure conversion by segment» |
| R-EN-04 | EN | `revenue\s+(?:will\|would\|could)` | «revenue will grow» | |
| R-EN-05 | EN | `customers?\s+(?:lost\|losing)\|(?:lose\|losing\|lost)\s+(?:\d+\s?%?\s+)?(?:of\s+)?(?:your\s+)?customers` | «you are losing 17% of customers» | «customers lost track of the cart» → ловить; це прийнятна хибна тривога, бо формулювання має бути іншим |
| R-EN-06 | EN | `(?:real\|actual)\s+(?:customers\|users\|people)\s+(?:prefer\|choose\|want)` | «83% of real customers prefer» | |
| R-EN-07 | EN | `WCAG[\s-]+(?:compliant\|compliance\s+(?:achieved\|confirmed))\|fully\s+accessible` | «site is WCAG compliant» | «not a complete WCAG compliance audit» |
| R-SYN-PCT | обидві | `(?:NUM_PCT)\s+(?:of\s+)?(?:the\s+)?(?:\p{L}+\s+){0,2}(?:synthetic\|simulated\|lens(?:es)?\|agents?\|journeys?\|sessions?\|evaluations?\|синтетичн\p{L}*\|змодельован\p{L}*\|лінз\p{L}*\|агент\p{L}*\|журнал\p{L}*\|сесі\p{L}*\|оцін\p{L}*)` | «75% of synthetic lenses», «60% журналів» | «9 of 12 synthetic lenses» |
| R-EN-08 | EN | `\d+(?:[.,]\d+)?\s?%\s+confiden\p{L}*\|confidence\s+(?:of\s+)?\d+(?:[.,]\d+)?\s?%\|statistically\s+significant` | «94.3% confidence» | |
| R-UK-01 | UK | `(?:обсяг\|розмір\|місткість)\s+ринку\|частк\p{L}*\s+ринку` | «обсяг ринку становить» | «ринкова ціна» |
| R-UK-02 | UK | `конверс\p{L}*\s+(?:зросте\|збільшиться\|підвищиться\|впаде\|знизиться\|виросте)` | «конверсія зросте» | «шлях до конверсії» |
| R-UK-03 | UK | `(?:збільш\|підвищ\|зрост\|зменш\|зниз\|поліпш\|покращ)\p{L}*\s+(?:\p{L}+\s+)?конверс\p{L}*\s+на` | «підвищить конверсію на 12%» | «виміряти конверсію на сторінці» |
| R-UK-04 | UK | `продаж\p{L}*\s+(?:зростуть\|зросте\|збільшаться\|виростуть\|впадуть\|подвояться)` | «продажі зростуть» | «сторінка продажу» |
| R-UK-05 | UK | `вируч\p{L}*\s+(?:зросте\|збільшиться\|виросте\|впаде)` | «виручка зросте» | |
| R-UK-06 | UK | `втрача\p{L}*\s+(?:\d+\s?%?\s+)?(?:\p{L}+\s+)?(?:клієнт\|покупц)\p{L}*` | «ви втрачаєте 17% клієнтів» | |
| R-UK-07 | UK | `реальн\p{L}*\s+(?:клієнт\|покупц\|користувач)\p{L}*\s+(?:віддають\s+перевагу\|обирають\|хочуть)` | «реальні клієнти обирають» | |
| R-UK-08 | UK | `відповіда\p{L}*\s+WCAG\|WCAG[\s-]+сумісн\p{L}*\|повністю\s+доступн\p{L}*` | «сайт відповідає WCAG» | «не є повним аудитом відповідності WCAG» |
| R-UK-09 | UK | `впевнен\p{L}*\s+\d+(?:[.,]\d+)?\s?%\|\d+(?:[.,]\d+)?\s?%\s+впевнен\p{L}*\|статистично\s+значущ\p{L}*` | «впевненість 94%» | |

У таблиці `\|` — це розділювач альтернатив у регулярці (екрановано для Markdown).

Для R-EN-07 і R-UK-08 спочатку маскується дозволений дисклеймер
(`not a complete WCAG compliance audit`, `не є повним аудитом відповідності WCAG`).

**B. Загальні правила**

```ts
// G1: число-твердження + цільове слово в одному реченні
G1(sentence) := hasAny(sentence, [NUM_PCT, NUM_MONEY, NUM_MULT, NUM_FRAC, NUM_RATIO])
                && hasAny(sentence, [TARGET_EN, TARGET_UK])
                && !allNumericSpansAllowed(sentence)          // див. A1, A2

// G2: прогноз бізнес-результату без числа («продажі зростуть», «may increase conversion»)
G2(sentence) := (has(PRED_EN) || has(PRED_UK))
                && hasAny(sentence, [TARGET_BIZ_EN, TARGET_BIZ_UK])
// TARGET_BIZ = лише conversion|sales|revenue|turnover|profit / конверс|продаж|вируч|дохід|прибут
// (без customers/users: «may confuse users» — це нормальна гіпотеза)
```

**C. Дозволені числові форми (маскуються перед G1)**

```ts
// A1: «N of M synthetic …» / «N з M синтетичних …». Між M і «synthetic» дозволено ≤2 слова,
//     але не real/actual/human/реальних/справжніх/живих.
A1_EN = String.raw`\d+\s?(?:of|out\s+of|/)\s?\d+\s+(?:(?!(?:real|actual|human)(?![\p{L}]))\p{L}+\s+){0,2}`
      + String.raw`(?:synthetic|simulated)\s+\p{L}+`
A1_UK = String.raw`(?:[ув]\s+)?\d+\s?(?:з|із|зі|/)\s?\d+\s+(?:(?!(?:реальн|справжн|живих)\p{L}*)\p{L}+\s+){0,2}`
      + String.raw`(?:синтетичн\p{L}*|змодельован\p{L}*|симульован\p{L}*)\s+\p{L}+`
// A2: оцінки інструментів і наш індекс, а не популяція
A2 = String.raw`(?:priority|пріоритет|score|оцінка|бал\p{L}*|Lighthouse\s+\p{L}+)\s*:?\s*\d+\s?(?:/|of|з|із)\s?100`
```

Відсотки для синтетичних підрахунків **заборонені** правилом R-SYN-PCT: «75% of synthetic lenses» не
проходить A1, а TARGET у такому реченні може й не бути. Відсоток читається як частка людей.

### 7.4 Що маскується до перевірки

1. **Дослівні цитати з сайту.** Підрядок у лапках (`"…"`, `«…»`, `“…”`), що дослівно (після
   `normalize`) міститься у `visible_text` будь-якої захопленої сторінки аудиту, замінюється на `⟦Q⟧`.
   Приклад: `На сторінці: «Безкоштовна доставка клієнтам від 1 500 грн».` Без маскування G1 заблокував
   би правдивий OBSERVED-факт. Цитата, якої на сайті немає, **не** маскується.
2. Спани A1 і A2.
3. Затверджені дисклеймери (§31, §37, §4).

### 7.5 Область застосування

Guard проходять **усі** тексти LLM, що доходять до користувача:
- поля знахідок (`title`, `problem`, `why_it_matters`, `recommended_change`, `how_to_validate`);
- executive summary, strengths;
- текстові поля SiteProfile, які показуються в UI;
- описи лінз;
- варіанти (§30), `reason` і `remaining_risk` порівняльника (§32), `reason_summary` журналів, якщо показується.

Не проходять лише дослівні артефакти сайту в блоці доказу (вони показуються як цитата з міткою
OBSERVED).

### 7.6 Регенерація

```
for each user-facing text field F produced by prompt P:
  attempt = 0
  loop:
    v = guard(F.text)
    if v.ok: break
    if attempt == 2:                                  // 2 невдалі регенерації
      F.text = removeSentences(F.text, v.violating_sentences)
               + marker(lang)                          // EN: "[removed: unsupported quantitative claim]"
                                                       // UK: "[видалено: непідтверджене кількісне твердження]"
      if isEmpty(F.text): F.text = 'UNKNOWN'            // поле, обов'язкове за схемою
      break
    attempt += 1
    F.text = regenerate(P, field=F, feedback={rule_ids, spans}, attempt)
    //   attempt і feedback входять у хеш запиту → кеш не поверне ту саму відповідь
  persist GuardEvent{audit_id, prompt_id, field_path, attempt, rule_ids, span_sha256}
  count regeneration tokens against MAX_AUDIT_TOKENS
```

Повторна перевірка після видалення речень обов'язкова: `guard(finalText).ok === true`, інакше
помилка. UI показує маркер, а не порожнє місце. Кількість GuardEvent — метрика аудиту.

### 7.7 Корпус (`packages/reporting/guard.corpus.ts`)

Обсяг: ≥ 30 заборонених (≥ 12 EN, ≥ 12 UK, ≥ 6 перефразувань без ключових слів §33) і ≥ 30 дозволених
(≥ 10 «пасток», схожих на заборонені). Тест проходить лише тоді, коли **100%** заборонених спрацювали
і **0** дозволених спрацювали. Кожне правило R-*, G1, G2 має ≥ 1 позитив і ≥ 1 негатив у корпусі.

Насіння (мінімальне, розширює реалізатор):

| Заборонено | Правило |
|---|---|
| Conversion will increase by 12% after this change. | R-EN-02, G1, G2 |
| Sales could grow by 15% with a clearer CTA. | G1, G2 |
| This fix may improve conversion. | G2 |
| You are losing 17% of customers at checkout. | R-EN-05, G1 |
| This segment is 24% of your market. | G1 |
| Your TAM is 4.2 million people. | R-TAM |
| Revenue will increase by $3,000 per month. | R-EN-04, G1 |
| 83% of real customers prefer version B. | R-EN-06, G1 |
| Half of your visitors leave before seeing the price. | G1 (NUM_FRAC) |
| Checkout conversions could double. | G2 |
| 75% of synthetic lenses struggled with shipping. | R-SYN-PCT (TARGET немає, тож G1 цього не бачить) |
| The site is WCAG compliant. | R-EN-07 |
| Конверсія зросте на 12% після зміни. | R-UK-02, G1, G2 |
| Продажі зростуть, якщо показати доставку. | R-UK-04, G2 |
| Ви втрачаєте 17% клієнтів на кошику. | R-UK-06, G1 |
| Цей сегмент становить 24% ринку. | G1 |
| Виручка зросте на 3 000 грн на місяць. | R-UK-05, G1 |
| Обсяг ринку — 4,2 млн людей. | R-UK-01 («4,2 млн» без валюти не є NUM_MONEY) |
| Половина відвідувачів іде до того, як побачить ціну. | G1 (NUM_FRAC) |
| Це може збільшити конверсію вдвічі. | G1 (NUM_MULT), G2 |
| 7 із 10 реальних покупців обирають варіант B. | R-UK-07, G1 (A1 не проходить: «реальних») |
| Впевненість 94%: проблема в доставці. | R-UK-09 |
| Сайт відповідає WCAG. | R-UK-08 |

| Дозволено (включно з пастками) | Чому проходить |
|---|---|
| 18 of 24 synthetic evaluations preferred version B. | A1 |
| This issue occurred in 7 of 10 simulated journeys. | A1 |
| 6/8 relevant synthetic journeys searched for delivery information. | A1 (≤ 2 слова між M і synthetic) |
| Recommended for real-world A/B testing of conversion. | немає числа й прогнозного дієслова |
| Likely to affect users who need pricing clarity. | немає числа; G2 не діє на users |
| We visited a store in TAMPA. | межа `B1` |
| Priority 82/100. | A2 |
| Lighthouse performance score 45/100 on mobile. | A2 |
| LCP is 4.2 s on the product page for mobile users. | «4.2 s» не є числом-твердженням |
| Customer tasks: find delivery cost. | немає числа |
| Automated accessibility testing is not a complete WCAG compliance audit. | маскований дисклеймер |
| У 9 з 12 синтетичних лінз виникли труднощі з вибором. | A1_UK |
| 5 з 8 змодельованих журналів відкрили FAQ. | A1_UK |
| На сторінці: «Безкоштовна доставка клієнтам від 1 500 грн». | маскування цитати (§7.4), якщо рядок є у `visible_text` |
| Рекомендовано перевірити A/B-тестом вплив на конверсію. | немає прогнозного дієслова й числа |
| Ціна 1 200 грн видна лише в кошику. | є гроші, але немає TARGET |
| Новачкам може бути незрозуміло, чим відрізняються товари. | немає числа, немає TARGET_BIZ |
| Автоматична перевірка доступності не є повним аудитом відповідності WCAG. | маскований дисклеймер |

---

## 8. Пороги валідації E1–E3 (рецензія E1–E3)

Пороги зафіксовано **до** результатів. Зміна порогу після прогону допускається лише із записом «чому» в
`planning/eval/VALIDATION_PROTOCOLS.md` і в DEVIATION_LOG.

### 8.1 E1 — фікстура §53

```
expected[d] = { categories: Set, pageGroups: Set, deterministic: bool }
detected(d) = ∃ finding f: f.category ∈ expected[d].categories
                         ∧ f.pageGroup ∈ expected[d].pageGroups
                         ∧ (¬expected[d].deterministic ∨ f.confidence = VERIFIED)
```

| d | categories | pageGroups | deterministic |
|---|---|---|---|
| 1 headline | value_proposition, visual_hierarchy | / | ні |
| 2 shipping | shipping, missing_information | product | так |
| 3 jargon | terminology, product_selection | product, category | ні |
| 4 similar products | comparison, product_selection | category, product | ні (доказ детермінований, судження ні) |
| 5 CTA below fold | cta, visual_hierarchy, mobile_usability | /, product | так |
| 6 mobile label | accessibility (`axe:button-name`\|`link-name`\|`label`) | будь-яка | так |
| 7 overflow | mobile_usability | будь-яка | так |
| 8 slow image | performance | будь-яка | так |
| 9 alt | accessibility (`axe:image-alt`) | будь-яка | так |
| 10 late price | pricing | category, product | так |

**Гейт E1:**
- основна фікстура: `Σ detected ≥ 8` **і** усі 7 детермінованих detected як VERIFIED;
- фікстура-двійник (зроблена іншим агентом без доступу до коду детекторів): детерміновані ≥ 6/7,
  разом ≥ 7/10. Кожен промах двійника — тікет на детектор;
- негатив 1 (мутації): для кожного детермінованого дефекту копія фікстури з цим одним виправленим
  дефектом, і детектор дефекту дає **0** знахідок (7/7 мутантів мовчать);
- негатив 2: на «чистій» сторінці (E3a) усі детектори дають 0.

Хибні тривоги на фікстурі (знахідки поза 10 очікуваними) рахуються й показуються. На першому проході
це не гейт.

**Звітування E1 двома числами (G0-7).** Окрім `Σ detected`, завжди друкуються: `E1_det = x/7` і `E1_llm = y/3`, де
`y` рахується в **абляційному** прогоні: детерміновані підказки для №1, №3, №4 (OBSERVED «H1 не згадує категорій»,
«термін ніде не пояснено», «A і B схожі…») не потрапляють ні в промпти, ні в докази. `E1_llm` — показник, не гейт; до
нього прив'язано Pivot S7 (`E1_llm = 0/3` і §66 без true positive, яких не дали б детектори).

### 8.2 E2 — стабільність §56

Умови прогону: 3 аудити того самого **замороженого** знімка (фікстура або локальне дзеркало), кеш LLM
обійдено для кожного прогону (перевіряється `cache_read_tokens = 0` у лічильнику), однакові модель і
версії промптів.

```
top5(r)        = першi 5 знахідок звіту r за §6.5
Cat(r)         = set(f.category for f in top5(r))          // множина різних значень
Pg(r)          = set(f.pageGroup for f in top5(r))
J(X,Y)         = |X∩Y| / |X∪Y|     (J(∅,∅) := 1)
pairs          = {(1,2),(1,3),(2,3)}
Jcat_mean      = mean_{p∈pairs} J(Cat(a),Cat(b));  Jcat_min = min(...)
Jpg_mean, Jpg_min — аналогічно
K3             = { k : k ∈ keys(top3(r)) для ≥2 з 3 прогонів }     // k = finding_key
```

**Гейт E2(а), повний звіт:** `Jcat_mean ≥ 0.6` **і** `Jpg_mean ≥ 0.6` **і** `Jcat_min ≥ 0.43`,
`Jpg_min ≥ 0.43` (≥ 3 спільні з 5) **і** `|K3| ≥ 3`, тобто весь топ-3 відтворюється щонайменше у 2 з 3
прогонів. Нагадування: 0.6 на 5-множинах = ≥ 4 спільні.

**Показник E2(б), лише LLM-знахідки** (без F-DET/F-SUP/F-BRW доказів): ті самі метрики на топ-5
цієї підмножини. Ціль `Jcat_mean ≥ 0.4`. На першому живому проході це не гейт, але результат
записується обов'язково. Без E2(б) не можна стверджувати, що синтетичні лінзи стабільні.

**Порядок (інформативно):** rank-biased overlap `RBO(p = 0.8)` на топ-10 для кожної пари.

### 8.3 E3 — анти-підлабузництво, нічия, деградація

**E3a — чиста сторінка (§57).** ≥ 3 чисті сторінки (головна, товар, лістинг) з чіткою CTA, видимою
ціною й доставкою, сильною ієрархією.
Гейт: 0 знахідок із `confidence ∈ {STRONG, VERIFIED}` серед тих, що не мають F-DET-доказу, **і**
0 детермінованих знахідок з 7 детекторів §8.1. Сторінка отримує стан «No major problem detected here».
HYPOTHESIS-знахідки дозволені, але рахуються.
Специфічність (G0-9, гейт): на кожній чистій сторінці **0** LLM-знахідок категорій `terminology` і `value_proposition`
будь-якого рівня **і** ≤ **2** HYPOTHESIS-знахідки без F-DET/F-SUP/F-BRW доказу. Чисті сторінки зібрані в міні-магазин
`fixtures/shop-clean` (головна, лістинг, товар, доставка, про нас).

**E3b — майже ідентичні варіанти (§58, §68).** Протокол порівняння:

```
for lens in lenses (12):
  v1 = judge(lens, first=A, second=B)      // схема: preferred ∈ {first, second, none}, strength
  v2 = judge(lens, first=B, second=A)
  map to A/B/none
  verdict(lens) = X   if v1 == v2 == X ∈ {A,B} and max(strength) ≥ moderate
                  none otherwise
NMD_share  = |{lens : verdict = none}| / 12
raw_NMD    = |{judgments = none}| / 24                 // до правила узгодженості, показник
first_share = |{decisive raw judgments choosing 'first'}| / |{decisive raw judgments}|
```

Набір пар: ≥ 3 майже ідентичні (пунктуація; синонім з тим самим змістом; регістр або пробіли) + 1 A-vs-A
(байт-ідентичні) + 1 позитивний контроль.

| Умова | Поріг | Гейт |
|---|---|---|
| NMD_share на кожній майже ідентичній парі | ≥ 0.50 | так |
| A-vs-A: raw_NMD | ≥ 0.90 | так |
| Позитивний контроль (B = A + ціна й доставка біля CTA): лінзи з verdict = B | ≥ 8 з 12, і A — ≤ 1 з 12 | **так**; без нього E3b не зараховується |
| first_share на пулі A-vs-A + майже ідентичні | ∈ [0.35, 0.65], якщо рішучих ≥ 30; інакше «недостатньо рішучих» | так (коли n ≥ 30) |
| Order-consistency на позитивному контролі | показник | ні |

Жодних p-values у звіті й UI. Формулювання — «B preferred in N of 12 synthetic lens verdicts (both
orders)» + дисклеймер §31.

**E3c — деградована копія (§67).** База (`original`) — **чистий магазин** `fixtures/shop-clean`, а не фікстура з 10
дефектами (у ній доставка вже схована й CTA вже нижче згину — нікуди деградувати); `degraded` — та сама з 5 змінами
(G0-9, DEV-16). Для кожного виміру окремо записується, чи `worse(dim)` дав детектор (F-DET), чи лише LLM.
П'ять змінених вимірів і відображення на категорії:

| Вимір | Категорії |
|---|---|
| shipping removed | shipping, missing_information |
| CTA less visible | cta, visual_hierarchy |
| vague headline | value_proposition |
| comparison help removed | comparison, product_selection |
| trust hidden | trust |

```
D(site, dim) = Σ priority(f) for f in findings(site) with f.category ∈ cats(dim)
worse(dim)   = D(degraded, dim) ≥ D(original, dim) + 5
             ∨ ∃ VERIFIED або STRONG знахідка в cats(dim) у degraded, якої немає (за finding_key) в original
```

Гейт: `Σ worse(dim) ≥ 4` з 5. Прогін «сліпий»: два окремі аудити на нейтральних хостах
(`site-a.test`, `site-b.test`). Слово «degraded» не повинне бути ні в URL, ні в тексті, ні в метаданих.
Інформативно: для решти 12 категорій записується `|ΔD|`. Великі зміни в незмінених вимірах — це шум
рейтингу.

---

## 9. Вибір лінз за різноманіттям (§9, §17, §18, рецензія C5)

### 9.1 Нормалізація й відстань

Вектор лінзи: 10 змінних §8 у фіксованому порядку
`[ck, ps, tr, ds, dp, vs, ct, ra, cp, sp]` =
`category_knowledge, price_sensitivity, trust_requirement, decision_speed, detail_preference,
visual_sensitivity, comparison_tendency, risk_aversion, convenience_priority, social_proof_need`.

- Значення вже в [0, 1] за схемою. `clamp01` на вході, `unknown` → 0.5 + прапорець.
- **Без min-max перемасштабування по набору.** Якщо LLM дала всім кандидатам ds від 0.45 до 0.50,
  min-max роздув би різницю 0.05 до 1.0 і шум почав би домінувати.
- Відстань: `d(a,b) = ‖a − b‖₂ / √10 ∈ [0, 1]`.

### 9.2 Дедуплікація (до вибору)

```
goalSim(a,b) = Jaccard( tokens(normalize(a.primary_goal)), tokens(normalize(b.primary_goal)) )
               // токени: lowercase, без стоп-слів EN/UK, стем — перші 5 літер
duplicate(a,b) = d(a,b) < 0.15 ∧ goalSim(a,b) ≥ 0.6
```

З кожної групи дублікатів лишається лінза з меншим `stableId = sha256(canonicalJSON(lens))`.

### 9.3 Обов'язкові полюси

| Полюс | Предикат | Екстремальність (для вибору серед задовольнячих) |
|---|---|---|
| P1 novice | ck ≤ 0.30 | 1 − ck |
| P2 expert | ck ≥ 0.70 | ck |
| P3 price-sensitive | ps ≥ 0.70 | ps |
| P4 price-insensitive | ps ≤ 0.30 | 1 − ps |
| P5 fast | ds ≥ 0.70 ∧ dp ≤ 0.50 | (ds + 1 − dp)/2 |
| P6 research-heavy | ds ≤ 0.30 ∧ dp ≥ 0.60 | (1 − ds + dp)/2 |
| P7 skeptical (для журналів §19) | tr ≥ 0.70 ∨ ra ≥ 0.70 | max(tr, ra) |

### 9.4 Алгоритм

```
input: candidates C (18), k = clamp(LENS_COUNT ?? 12, 8, 20)
C ← dedup(C)
S ← ∅
for pole in [P1..P7]:                                   // фіксований порядок
  if ∃ s∈S : pole.pred(s): continue                     // одна лінза може закрити кілька полюсів
  Q ← {c ∈ C∖S : pole.pred(c)}
  if Q = ∅:
     flag(pole_unmet: pole)                             // один раз попросити генератор про цей полюс;
     Q ← argmin_c distanceToPole(c, pole)               //   якщо знову ні — найближчий кандидат + прапорець
  pick c* = argmax_{c∈Q} ( extremity(c,pole), minDist(c,S), −stableId(c) )   // лексикографічно
  S ← S ∪ {c*}
while |S| < k and C∖S ≠ ∅:                              // farthest-point
  c* = argmax_{c∈C∖S} ( minDist(c,S), −stableId(c) )
  S ← S ∪ {c*}
if |S| < k: flag(insufficient_candidates)               // не домальовувати лінзи
return S
// minDist(c, ∅) := 1
```

`distanceToPole` — відстань до порогу предиката (наприклад, для P1 `max(0, ck − 0.30)`).

Юніт-тести: (1) усі 7 полюсів покриті, коли кандидати це дозволяють; (2) результат інваріантний до
перестановки входу; (3) дублікати не потрапляють разом; (4) набір, де жоден кандидат не має ps ≥ 0.7, дає
`pole_unmet: P3`, а не мовчазний успіх; (5) k = 8 і k = 20 на межах; (6) чистий farthest-point без
кроку полюсів на спеціально побудованому наборі пропускає P4, а наш алгоритм — ні. Цей тест і доводить
потребу в C5.

---

## 10. Матриця сценаріїв і журнали (§16, §18, §19)

### 10.1 Типи задач і релевантність

LLM класифікує кожну задачу (4–7, §16) в `task_type`. Релевантність рахує код:

```
r(lens, task) = clamp01( Σ_j W[task_type][j] · f_j(lens) )   // Σ_j W = 1
f_j = x_j або (1 − x_j) — позначено «1−» у таблиці
```

| task_type | ваги |
|---|---|
| understand_offering | (1−ck) .40, vs .20, ds .20, cp .20 |
| suitability | (1−ck) .35, dp .25, ra .20, tr .20 |
| choose_between | ct .40, dp .25, (1−ck) .20, ps .15 |
| total_price | ps .45, ra .20, dp .20, ct .15 |
| delivery | cp .35, ra .25, ps .20, ds .20 |
| credibility | tr .40, sp .30, ra .30 |
| add_to_cart | ds .35, cp .30, ck .20, (1−ra) .15 |
| other | по 0.10 на кожну з 10 змінних |

**Важливі задачі:** `task_type ∈ {understand_offering, choose_between, total_price, delivery,
add_to_cart}` плюс задача, що відповідає `primary_conversion_goal`.

### 10.2 Побудова матриці snapshot-сесій (24–40)

```
N = clamp( round(2.5 · |L|), 24, 40 )            // 12 лінз → 30
M ← ∅                                            // множина (lens, task)
1. for lens in L:           add argmax_t r(lens,t)                       // кожна лінза ≥1
2. for t in important:      while lenses(M,t) < 4: add argmax_{l∉lenses(M,t)} r(l,t)
   for t in other tasks:    while lenses(M,t) < 2: add ...
3. for t in important:      ensure ∃ P1 і ∃ P2 серед lenses(M,t)          // новачок і експерт на кожній важливій
   for pole in P3..P6:      ensure pole присутній у ≥2 сесіях M
4. while |M| < N:           add argmax_{(l,t)∉M} r(l,t)
tie-break скрізь: (r desc, stableId(lens) asc, task_id asc)
if |M| > 40 after 1–3:      зменшити «4» до «3» в кроці 2 і повторити; якщо знову > 40 → flag(matrix_overflow), обрізати крок 3 для «other»
```

Пристрій: у кожній важливій задачі ≥ 1 сесія mobile (390×844, §38), загалом ≥ 40% сесій mobile.
Призначення детерміноване: у межах задачі сесії за спаданням r чергуються `mobile, desktop, …`.

Перевірка покриття (функція повертає список порушень, порожній = OK): кожна лінза ≥ 1; кожна важлива
задача ≥ 4 лінзи (або ≥ 3 з прапорцем); P1 і P2 на кожній важливій; P3–P6 кожен ≥ 2 сесії;
24 ≤ |M| ≤ 40.

### 10.3 Вибір живих журналів (8 фіксованих + до 8 адаптивних)

Фіксовані слоти (§19). Для кожного слота — пара (lens, task) із максимальною r серед тих, що
задовольняють предикат. Трійки (lens, task, device) не повторюються.

| # | Слот | Предикат | Пристрій |
|---|---|---|---|
| 1 | main purchase | task = add_to_cart або primary goal | desktop |
| 2 | novice | P1, важлива задача | mobile |
| 3 | expert | P2, важлива задача | desktop |
| 4 | price-conscious | P3, task ∈ {total_price, delivery} | desktop |
| 5 | skeptical | P7, task = credibility (або будь-яка важлива) | desktop |
| 6 | mobile | task слота 1, інша лінза | mobile |
| 7 | comparison | task = choose_between, max ct | desktop |
| 8 | shipping/pricing discovery | task ∈ {delivery, total_price}, інша лінза, ніж у слоті 4 | mobile |

Якщо для слота немає пари → найближча за `distanceToPole` + прапорець `slot_relaxed`. Не пропускати
мовчки.

Адаптивні 9–16 (після snapshot-етапу й попередньої агрегації):

```
cand = findings with confidence = HYPOTHESIS ∧ prelim_priority ≥ 50 ∧ сторінка досяжна з головної
       ∪ snapshot sessions with success ∈ {false, partial} на важливій задачі
rank by prelim_priority desc, stableId asc
while count < 16 ∧ budget_remaining ≥ 1.2 · est_journey_tokens:
    run journey for next cand (lens і task з найбільшою r, що торкаються сторінки)
```

Мета адаптивних журналів — **підтвердити або спростувати** гіпотези (перевести в STRONG або зняти), а
не шукати нові. `max_actions = 8` (§16). Не-GET заблоковано (рецензія B3): задача `add_to_cart`
вважається успішною, коли знайдено доступну кнопку додавання і ціна та доставка відомі до неї.
Кожен заблокований запит логується як доказ.

`est_journey_tokens` — медіана фактичних токенів уже виконаних журналів цього аудиту (до першого —
80k, FEASIBILITY §5).
