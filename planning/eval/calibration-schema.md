# Схема калібрування (SPEC §59–§61) — ДОКУМЕНТ, не міграції

Статус: **лише проєкт схеми** (DEV-15, G0-22). У `packages/db/migrations/` немає жодної таблиці калібрування; у MVP вони не мають споживача.
Схему буде переписано в міграцію лише коли з'являться реальні дані (GA4/Search Console/Shopify/A-B), тобто після MVP.

## Навіщо (і чого це НЕ дозволяє)
Калібрування відповідає на питання §60: які синтетичні сигнали корелюють із реальними ефектами; які лінзи й категорії передбачають напрямок;
які моделі систематично перебільшують. **Кількісні прогнози (uplift, %, виручка) заборонені, доки немає калібрувальної вибірки** (§61).
Без вибірки продукт повертає рівно `INSUFFICIENT CALIBRATION DATA`. Ці таблиці — єдине місце в системі, де реальні числа конверсії взагалі
можуть з'явитись; вони не читаються звітом MVP, не мають зв'язку з полями `Finding.priority` і не додають колонок market share / TAM / uplift
у таблиці MVP (SPEC §8).

## Сутності (§59) і поля (§60)

Ключі — `text` (як у решті схеми), час — `timestamptz`, пропорції — `double precision` у [0, 1], лічильники — `integer`/`bigint` ≥ 0.

### RealSegment
Сегмент реальних відвідувачів у джерелі даних (не синтетична лінза).
| поле | тип | примітка |
|---|---|---|
| id | text PK | |
| site_domain | text | `audit_runs.domain` |
| source | text | `ga4` \| `search_console` \| `shopify` \| `custom_analytics` \| `session_recordings` |
| definition_json | jsonb | як сегмент визначено в джерелі (фільтри, вікно дат) — відтворюваність |
| created_at | timestamptz | |

### RealSessionMetric
Агреговані метрики сегмента за період (без персональних даних, R-11: лише агрегати; сирі сесії й записи не зберігаються).
| поле | тип | примітка |
|---|---|---|
| id | text PK | |
| segment_id | text FK → RealSegment | |
| period_start, period_end | timestamptz | |
| sessions | integer | обсяг вибірки |
| conversions | integer | ≥ 0, ≤ sessions |
| purchase_events | integer | nullable (подія покупки, якщо є) |
| metric_json | jsonb | додаткові метрики джерела (bounce, глибина) |
| collected_at | timestamptz | знімок джерела — відтворюваність |

### Experiment
Реальний експеримент (A/B) на сайті, з якого взято аудит.
| поле | тип | примітка |
|---|---|---|
| id | text PK | |
| audit_run_id | text FK → audit_runs | «website state» на момент аудиту (знімок §35) |
| finding_id | text | FK (audit_run_id, finding_id) → findings |
| recommended_change | text | що змінювали (посилання на recommendations.id) |
| synthetic_comparison_id | text | nullable; порівняння S6 (варіанти) — «synthetic comparison» |
| started_at, ended_at | timestamptz | «experiment duration» |
| tool | text | де проведено (Google Optimize-аналог, власний split тощо) |
| preregistered | boolean | чи зафіксовано гіпотезу до запуску (захист від p-hacking) |

### ExperimentVariant
| поле | тип | примітка |
|---|---|---|
| id | text PK | |
| experiment_id | text FK → Experiment | |
| role | text | `control` \| `variant` |
| sample_size | integer | «sample sizes» |
| conversions | integer | |
| conversion_rate | double precision | = conversions / sample_size (перевіряється CHECK) |

### ExperimentResult
| поле | тип | примітка |
|---|---|---|
| experiment_id | text PK/FK | |
| direction | text | `positive` \| `negative` \| `flat` \| `inconclusive` — спостережуваний напрямок |
| effect_pp | double precision | ефект у процентних пунктах (реальний, спостережений) |
| ci_low_pp, ci_high_pp | double precision | «confidence interval» |
| ci_level | double precision | напр. 0.95 |
| method | text | тест/метод оцінки |
| sufficient_power | boolean | чи вибірка достатня для висновку |
| synthetic_direction | text | напрямок, який передбачив синтетичний компаратор (для порівняння) |
| agreement | boolean | збіг синтетичного й реального напрямку |

## Похідні таблиці «що ми вчимо» (§60) — обчислення, не сирі дані
Агрегати над ExperimentResult ⨝ findings ⨝ синтетичними сесіями: (а) кореляція «частка лінз із фрикцією у знахідці» ↔ реальний напрямок;
(б) корисність лінзи (чи її присутність змінює передбачення); (в) прогностичність категорій; (г) систематичне перебільшення моделі
(порівняння синтетичної «сили» й реального ефекту). Зберігаються як представлення або матеріалізації з `computed_at` і `n`.

## Інваріанти (для майбутньої міграції)
1. `conversions ≤ sample_size`; `conversion_rate = conversions / sample_size` (CHECK з допуском).
2. Результат без `sufficient_power = true` не потрапляє в калібрувальну вибірку.
3. Кількісна відповідь продукту дозволена лише коли `n` порівнянних експериментів ≥ порогу, зафіксованого до першого прогнозу; інакше —
   літерал `INSUFFICIENT CALIBRATION DATA`. Діапазон, не точкове число; поруч — `n` і рівень довіри калібрування (SPEC §61).
4. Жодних зв'язків «синтетична знахідка → відсоток» у звіті MVP; guard звіту (sl-eval-science) блокує відсотки/uplift без цієї вибірки.
5. Персональні дані відвідувачів (ідентифікатори, IP, записи сесій) не зберігаються; лише агрегати сегмента.
6. Видалення аудиту (F3) каскадом видаляє й пов'язані експерименти цього аудиту лише за явною згодою: реальні результати — окрема цінність.

## Що відкрито
Формат ідентифікації сайту між аудитами (домен vs. власне «property» у джерелі), політика ретеншну реальних метрик, поріг вибірки для
першого кількісного прогнозу — рішення власника після MVP (OQ-серія; тут не вирішується).
