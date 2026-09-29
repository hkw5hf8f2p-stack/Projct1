# packages/schemas і міграція 001 (S1b, критерій 5)

Zod (v3.25.76) — єдине джерело контрактів для S2 (БД/черга) і S3 (LLM). SQL — `packages/db/migrations/001_init.sql`
(PostgreSQL, лише таблиці продукту; схему `pgboss` створює pg-boss, DEV-1). Міграція **не виконувалась на живій БД**:
синтаксис перевірено парсером libpg_query; виконання на порожній БД — задача S2.

## Маппінг §8 → схема → таблиця
| Сутність (SPEC) | Zod (`src/`) | Таблиця |
|---|---|---|
| AuditRun §8, DEV-11 (`llm_mode`, `stage_status`) | `entities.ts: AuditRun` | `audit_runs` |
| PageArtifact §8 | `PageArtifactCapture` (форма S1a, `audit_run_id`/`created_at` = null), `PageArtifact` (збережена) | `page_artifacts` |
| SiteProfile §8, §15 | `SiteProfile` | `site_profiles` |
| Task §16 (`customer_tasks[]` профілю) | `Task` | `customer_tasks` |
| BehavioralLens §8 (10 змінних 0..1, без market share) | `BehavioralLens` | `behavioral_lenses` |
| Scenario §18 | `Scenario` | `scenarios` |
| Session §21–§22 | `SyntheticSession`, `AgentStep`, `SessionResultLlm` (вихід LLM без службових полів) | `synthetic_sessions` |
| Evidence §23 + SCORING §1 | `evidence.ts: Evidence` (форма S1a), `EvidenceRecord` (+`audit_run_id`), `tierOf()` | `evidence` |
| Finding §24–§25 | `finding.ts: Finding` (підмножина S1a + поля S3/S4), `finding-key.ts` | `findings`, `finding_evidence` (`role` support/counter) |
| Recommendation §25, §30 | `Recommendation` | `recommendations` |
| LlmCall §35, §52 | `LlmCall` | `llm_calls` (кеш за `prompt_version, model, request_hash`) |
| Variant, Comparison §30–§31 | `later.ts` — **later (S6, DEV-14)** | немає |
| Calibration §59 | — | немає (DEV-15) |

Enum-и (`enums.ts`): `source_class`, `evidence type`, ET-* (з ET-INC, DEV-19), родини F-*, `confidence`, 17 категорій §22,
`claim_kind` (закритий на категорію + `axe:<rule>` + `general`), `page_type` (набір класифікатора S1a), `stage` воронки,
`task_type`, статуси. У SQL — `CHECK`; тест звіряє списки з Zod.

## Інваріанти, які схема вміє порушити (обидва шари: Zod і CHECK)
- OBSERVED/BENCHMARKED без `browser_failure` мають `detector_id, claim_kind, assertion, capture_complete, capture_context`.
- SYNTHETIC: `session_id, lens_id, task_id, level`; SYNTHETIC/INFERRED ніколи не `self_confirming`.
- Твердження відсутності при `capture_complete=false` не може бути `self_confirming` і не ET-DET (DEV-17/19); позиційне при `banner_state=open` — теж.
- Finding: ≥ 1 доказ (у БД — відкладений constraint trigger на `finding_evidence`), F-INC без F-DET ⇒ лише HYPOTHESIS, F-DET ⇒ strength 1, ключ = поля.
- `llm_mode=none` ⇒ LLM-етапи лише `skipped` з `reason`.

## Відхилення
DEV-38 (формат `finding_key` без `stage`), DEV-39 (набір таблиць, `Project` немає, `PageType` = набір S1a, `text` id, CHECK замість enum).

## Межі / неперевірене
- Міграція не виконана на живій БД (S2). Zod-предикати `Evidence`/`Finding` перевірені на 4 наборах S1a (shop, shop-clean, twin, twin2) і на навмисно зіпсованих зразках.
- Артефакти S1a не містять ET-INC/absence з неповним захопленням — цей шлях покритий лише синтетичними зразками тесту.
- Імпорт артефактів S1a у БД: `audit_run_id` для Evidence/Finding і `id = findingId(finding_key)` проставляє імпортер (S2).
- Числові поля Friction (`severity`) в LLM — лише мітка low/medium/high; числову severity ставить код (SCORING §3).
