# Priority cases — розраховані випадки пріоритету (S4, scoring-v1)

Автор: `sl-eval-science`, 30.09.2026. Формула й таблиці — `SCORING_SPEC.md` §3–§6, §11; відхилення DEV-4, DEV-59, DEV-60.
Кожен рядок нижче перевіряє тест (`packages/scoring/test/*.test.ts`, `packages/reporting/test/build-report.test.ts`);
числа в цьому файлі не редагуються вручну — лише з виходу тестів/артефактів.

**Priority — індекс ранжування, не розмір ефекту.** Показується як «Priority NN/100».

`priority = min( roundHalfUp(100·Σ_{i∈A} W_i·c_i / Σ_{i∈A} W_i), cap )`, `cap` лише для HYPOTHESIS:
`round(100·(0.30·sev + 0.20·fun + 0.15)/0.65)` (DEV-60). Для VERIFIED `lens_coverage`/`session_frequency` — N/A.

## 1. Граничні й контрольні випадки (юніт-тести)

| # | Випадок | Очікування | Тест |
|---|---|---|---|
| 1 | C1: sev = fun = ev = 1, без лінз/сесій (VERIFIED) | **100**; стара §25 дала б 65 | `priority.test.ts` C1 |
| 2 | C1 наскрізно: checkout на /cart + MOD-BLOCKER → sev 1.0, fun 1.0, ET-DET | **100**, VERIFIED | C1 aggregate |
| 3 | §6.4 приклад 1: axe image-alt (critical) на товарі | sev 0.75, fun 0.80 → **82** | §6.4 |
| 4 | §6.4 приклад 2: доставка схована + блокер у журналі | sev 0.85, fun 0.90 → **90**, VERIFIED | §6.4 |
| 5 | §6.4 приклад 3: жаргон, 14/9/2 бачили, 6/5 повідомили | lens 5/9, freq 6/14, ev 0.70 → **59**, STRONG | §6.4 |
| 6 | §6.4 приклад 4: чиста INFERRED, 10 бачили, 0 повідомили | 34.5 → **35** (з EPS; без EPS 34), HYPOTHESIS, cap 69 | §6.4 |
| 7 | Асиметрія: HYPOTHESIS, 12/12 лінз в 1 контексті, sev 0.80, fun 0.80 vs VERIFIED cta below_fold | без кепу **86 > 85** (контрприклад); з кепом 85, ранг нижче VERIFIED | асиметрія |
| 8 | Те саме, але 2 контексти (STRONG) | кепу немає (рівновага §6.4) | асиметрія |
| 9 | VERIFIED + SYNTHETIC-доказ | priority не змінюється (інв. 4); виявив дефект типу сторінки, виправлено | §6.2 |
| 10 | Немає сесій (S_exp = ∅), гіпотеза trust на головній | lens = freq = 0 **застосовні**, без бонусу перерозподілу | §6.2 |
| 11 | Усі дозволені N/A (VERIFIED, усі 0) | Σ W = 0.65 → 0; покриття в VERIFIED або значення > 1 → помилка | §6.2 |
| 12 | Нічия (cta below_fold vs competing_ctas, рівні числа) | порядок за `finding_key` (code points) | §6.2 |
| 13 | Монотонність: кожен компонент ↑ для STRONG і HYPOTHESIS | priority не спадає | §6.2 |
| 14 | C2: 3 «replay-прогони» з мітками low/high/medium і різною силою формулювань | ідентичні пріоритети; зміна **категорії** — змінює (контроль) | `aggregate.test.ts` C2 |
| 15 | Детермінізм: 6 перестановок доказів і 6 перестановок сесій | байт-ідентичний вихід; зміна одного факту — інший вихід | `aggregate.test.ts` |

Severity-таблиця (10 рядків, включно з axe minor на `other` → 0.10, Lighthouse opportunities + oversized_image → підлога
0.45 − 0.10 = 0.35) і воронка на типах S1a (5 рядків, DEV-59) — `priority.test.ts` «§3/§4».

## 2. Фікстура `shop` без LLM (`planning/qa/artifacts/sprint-4/report-fixture-nollm.json`)

| Ранг | finding_key | Впевненість | severity | funnel | lens | freq | ev | формула | cap | **priority** |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `pricing\|category\|not_in_first_viewport` | VERIFIED | 0.85 (category, PRIMARY +0.05) | 0.9 (price_shipping_confidence) | N/A | N/A | 1 | 90 | — | **90** |
| 2 | `pricing\|product\|not_in_first_viewport` | VERIFIED | 0.85 (category, PRIMARY +0.05) | 0.9 (price_shipping_confidence) | N/A | N/A | 1 | 90 | — | **90** |
| 3 | `cta\|product\|below_fold` | VERIFIED | 0.8 (category, PRIMARY +0.05) | 0.8 (evaluate_product) | N/A | N/A | 1 | 85 | — | **85** |
| 4 | `accessibility\|*\|axe:button-name\|header/button` | VERIFIED | 0.75 (axe critical, PRIMARY +0.05) | 0.9 (price_shipping_confidence) | N/A | N/A | 1 | 85 | — | **85** |
| 5 | `shipping\|product\|deep_link_only` | VERIFIED | 0.75 (category, PRIMARY +0.05) | 0.9 (price_shipping_confidence) | N/A | N/A | 1 | 85 | — | **85** |
| 6 | `accessibility\|product\|axe:image-alt\|main/img` | VERIFIED | 0.75 (axe critical, PRIMARY +0.05) | 0.8 (evaluate_product) | N/A | N/A | 1 | 82 | — | **82** |
| 7 | `mobile_usability\|product\|horizontal_overflow` | VERIFIED | 0.7 (category, PRIMARY +0.05) | 0.8 (evaluate_product) | N/A | N/A | 1 | 80 | — | **80** |
| 8 | `performance\|/\|oversized_image` | VERIFIED | 0.6 (category; мережа 0.45 < 0.55) | 0.3 (landing) | N/A | N/A | 1 | 60 | — | **60** |

Детерміновані дефекти EXPECTED №2, 5, 6, 7, 8, 9, 10: **7/7 VERIFIED, усі в топ-10** (`report-fixture-nollm-e1.json`).
Контроль: без доказів `horizontal_overflow` рахунок падає до 6/7. `shop-clean`: 0 знахідок, 5 позитивних.

**Спостереження (не гейт, для гейту S4):** наскрізна axe `button-name` у шапці отримує етап `price_shipping_confidence`
(0.90), бо серед уражених сторінок є `/help/shipping` (`info_shipping`) — правило «максимальний етап» §4.2. Кнопка меню
без назви ранжується поруч із прихованою доставкою. Це наслідок правила, а не дефект коду; чи змінювати правило для
наскрізних знахідок (напр. етап за медіаною/найчастішим типом) — рішення до scoring-v2, лише із записом.

## 3. Приклад із гіпотезами (`packages/schemas/examples/report.fixture.json`, ПРИКЛАДНІ LLM-дані, не модель)

| Ранг | finding_key | Впевненість | severity | funnel | lens | freq | ev | формула | cap | **priority** |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | `shipping\|product\|deep_link_only` | VERIFIED | 0.85 (+PRIMARY, +BLOCKER) | 0.9 | N/A | N/A | 1 | 90 | — | **90** |
| 9 | `comparison\|category\|general` | HYPOTHESIS | 0.6 | 0.7 (select) | 0.5 | 0.5 | 0.7 | 60 | 72 | **60** |
| 10 | `terminology\|category\|general` | STRONG | 0.5 | 0.55 (browse) | 0.75 | 0.5 | 0.7 | 59 | — | **59** |
| 11 | `value_proposition\|/\|general` | HYPOTHESIS | 0.8 | 0.3 (landing) | 0 | 0 | 0.3 | 35 | 69 | **35** |

Усі 7 детермінованих лишаються VERIFIED у топ-10 поруч із гіпотезами. Якість цих гіпотез — ⏭️ live pass (OQ-1):
приклад доводить плумбінг і контракт, не модель.
