#!/usr/bin/env bash
# Заморожування report guard перед прогоном запечатаного корпусу (G0-15, S4 кр. 4). НЕ комітить і НЕ запускає запечатаний корпус.
# Порядок для оркестратора:
#   1) bash scripts/freeze-guard.sh            # lint + typecheck + тести guard + маніфест planning/eval/guard-freeze.sha256
#   2) git add -A packages/llm packages/reporting packages/schemas planning/eval scripts eslint.config.js
#      git commit -m "S4: freeze report guard"      # + git tag guard-freeze-s4  (розкриття корпусу — лише після тегу)
#   3) QA:  SL_WRITE_ARTIFACTS=1 pnpm exec tsx scripts/guard-sealed.ts final   # SHA корпусу + збіг маніфесту, друк агрегатів
# Після кроку 1 жодна правка guard-файлів не допускається: `guard-files.ts check` тоді падає, а результат помічається freeze_manifest_match=false.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm run lint
pnpm run typecheck
pnpm exec vitest run --configLoader runner packages/llm packages/reporting scripts
pnpm exec tsx scripts/guard-files.ts write
pnpm exec tsx scripts/guard-files.ts hash
echo "Далі: закоміть заморожування (див. заголовок скрипта) і передайте QA. Запечатаний корпус цей скрипт не чіпає."
