
## S4 — журнали агента (sl-core-engineer)
- `packages/browser/src/agent/action-filter.ts` (чисті функції: `denyUrl`, `classifyElementText`, `checkAction`, `checkElement`) і `journey.ts` (`runJourney`, `runJourneys`, `cartVerdict`, `buildJourneyEvidence`). Агент — `AgentDriver` (LLM/replay/scripted); код виконує й забороняє. Журнал → `<runDir>/journeys/<lens>__<task>/{journey,session,evidence}.json` (+ `step-NN.png`, якщо `writeShots`).
- Три шари: фільтр елемента до кліку → `context.route` (GET deny-list, cross-origin навігація) → `secureLaunch` (не-GET). Контроль `__controlNoFilter` вимикає лише перші два; не-GET усе одно блокується.
- Успіх «кошик» рахує код (DEV-73); «В кошик» на сторінці — `found_not_clicked`. Докази: SYNTHETIC (friction з перевіреною цитатою), OBSERVED `journey_cart_reachable` (ET-SUP), `browser_failure` (reproduced_by_replay=false).
- Чого нема (unverified): живі сайти (throttle/UA підключено за контрактом `auditSite`, не запускалось), якість справжнього LLM, replay браузерного збою.
- `auditSite({ onPage })`: колбек прогресу `PageProgress` (`index, total_limit, url, path, page_id, page_type, page_error, capture_complete`); його збій ігнорується.
