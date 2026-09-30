# VALIDATION_PROTOCOLS — пороги, журнал змін, протоколи §66/§67

Власник: `sl-eval-science`. Пороги — `planning/eval/SCORING_SPEC.md` §8 і §12; реалізація — `pnpm validate` (`scripts/validate.ts`).
Правило: пороги фіксуються ДО результатів; зміна після прогону — лише рядком у §2 із «чому» і рядком у `DEVIATION_LOG.md`.

## 1. Зафіксовані пороги (станом на 30.09.2026, до першого прогону validate)
| Перевірка | Гейт | Джерело |
|---|---|---|
| E1 | детерміновані 7/7 (VERIFIED, F-DET); сума ≥ 8 (у dev — показник; `--strict-live` — гейт); E1_llm — показник | §8.1, §12.2, DEV-75 |
| E2 валідність | 3 прогони, `cache_mode=bypass`, `cache_read_tokens=0`, читань кешу 0; інакше «недійсний» | §8.2 |
| E2(а) | Jcat_mean ≥ 0.6, Jpg_mean ≥ 0.6, Jcat_min ≥ 0.43, Jpg_min ≥ 0.43, \|K3\| ≥ 3 | §8.2 |
| E2(б), RBO | показники (ціль J ≥ 0.4) | §8.2, G0-8 |
| E3a | 0 STRONG/VERIFIED без F-DET; 0 F-DET; 0 LLM terminology/value_proposition; ≤ 2 LLM HYPOTHESIS на сторінку | §8.3, G0-9 |
| E3c | worse у ≥ 4 з 5 (worse: ΔD ≥ 5 або нова STRONG/VERIFIED); dev: ≥ 2 виміри дав код | §8.3, §12.2 |
| E4 | `used ≤ MAX_AUDIT_TOKENS`; лічильник звіту = клієнта; банер ⇔ зупинка | E4, §12.3 |
| Валідація | `MAX_VALIDATE_TOKENS` (за замовчуванням 2 000 000) — жорсткий стоп | S4 |

## 2. Журнал змін порогів
| Дата | Поріг | Було → Стало | Чому (з посиланням на результат) | DEV |
|---|---|---|---|---|
| — | — | змін немає | — | — |

## 3. Протокол §66 (реальний сайт) — ⏭️ live pass
Шаблон: `planning/eval/protocol-66-template.md` (прихований список ДО аудиту; класи TP / NOVEL / WEAK / FP / MISSED).
Виконується у S7 після OQ-1 (ключ LLM) і OQ-4; сайт — не з `planning/security/live-dev-sites.md` (G0-13). У dev не виконувався.

## 4. Протокол §67 (деградована копія)
Dev-обв'язка: `fixtures/shop-clean` проти `fixtures/shop-clean-degraded` на нейтральних хостах `site-a.test` / `site-b.test`
(DEV-74), `pnpm validate` → блок `[E3c]`. Копія живого сайту — лише сайту власника й лише в живому проході.

## 5. Протокол §68 (майже ідентичні варіанти, E3b) — S6.
