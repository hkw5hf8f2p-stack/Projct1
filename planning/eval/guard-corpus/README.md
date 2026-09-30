# Dev-корпус report guard (S4, D1)

`cases.jsonl` — регресійний набір автора guard (sl-llm-engineer); НЕЗАЛЕЖНОЇ оцінки не дає (її дає запечатаний корпус sl-critic, `planning/sealed/guard`).
Рядок: `{lang, field, text, expected: "reject"|"pass", category, evidence_values?: string[]}`; `evidence_values` — білий список чисел структурного правила
(значення з доказів/скорингу; для «pass» — числа, які дослівно є на сторінці).
Категорії ключових перевірок: `uk_boundary` (UK-речення, які guard з ASCII-межею слова пропускає — G0-26), `forecast_no_number`, `whitelist_trap`
(число «виправдане» списком, але стоїть поруч із конверсією/продажами/клієнтами), `structural_number` / `structural_numeral_word`, `n_of_m_synthetic`, `priority_form`, `homonym` («TAMPA»).
Тести: `packages/llm/test/report-guard.test.ts`, `scripts/guard-sealed.test.ts` (той самий раннер, що й для запечатаного). Після заморожування guard корпус не правиться
(промах запечатаного корпусу → новий рядок сюди в наступному спринті, не ретроспективно).
