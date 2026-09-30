#!/usr/bin/env bash
# Запуск команди від не-root користувача `sitelens` (Chromium-пісочниця не стартує під root, DEV-13/DEV-25).
# Середовище — білий список (жодних секретів родителя). Використання: bash scripts/run-as-sitelens.sh pnpm test
# SL_PASS_PROXY=1 — додатково передати HTTPS_PROXY і копію публічного CA-бандла (для мережевих проб doctor / npm view).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
id sitelens >/dev/null 2>&1 || useradd -m -s /bin/bash sitelens
mkdir -p "$ROOT/planning/qa/artifacts"
chmod -R a+rwX "$ROOT/planning/qa/artifacts"
# S2: data/ (Postgres, артефакти, PID-файли, логи) належить sitelens — Postgres і браузер не стартують під root
install -d -o sitelens -g "$(id -gn sitelens)" "$ROOT/data"
cd "$ROOT"
ENVV=(HOME=/home/sitelens "PATH=$PATH" "PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" CI=true)
[ -n "${DOCTOR_OUT:-}" ] && ENVV+=("DOCTOR_OUT=$DOCTOR_OUT")
# X-1: тести пишуть у planning/qa/artifacts лише з SL_WRITE_ARTIFACTS=1 (інакше — os.tmpdir()/sitelens-artifacts-<uid>)
[ -n "${SL_WRITE_ARTIFACTS:-}" ] && ENVV+=("SL_WRITE_ARTIFACTS=$SL_WRITE_ARTIFACTS")
# SL_PASS_VARS="A B" — додатково передати перелічені змінні (S2: DATABASE_URL, ACCESS_TOKEN, SITELENS_FIXTURE_* тощо); решта env відкидається
for v in ${SL_PASS_VARS:-}; do [ -n "${!v:-}" ] && ENVV+=("$v=${!v}"); done
if [ "${SL_PASS_PROXY:-0}" = "1" ]; then
  for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do [ -n "${!v:-}" ] && ENVV+=("$v=${!v}"); done
  if [ -n "${SSL_CERT_FILE:-}" ] && [ -r "$SSL_CERT_FILE" ]; then
    install -m 644 "$SSL_CERT_FILE" /tmp/sitelens-ca.crt
    ENVV+=(SSL_CERT_FILE=/tmp/sitelens-ca.crt CURL_CA_BUNDLE=/tmp/sitelens-ca.crt NODE_EXTRA_CA_CERTS=/tmp/sitelens-ca.crt npm_config_cafile=/tmp/sitelens-ca.crt)
  fi
fi
exec runuser -u sitelens -- env -i "${ENVV[@]}" "$@"
