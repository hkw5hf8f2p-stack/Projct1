#!/usr/bin/env bash
# Запуск команди від не-root користувача `sitelens` (Chromium-пісочниця не стартує під root, DEV-13/DEV-19).
# Середовище — білий список (жодних секретів родителя). Використання: bash scripts/run-as-sitelens.sh pnpm test
# SL_PASS_PROXY=1 — додатково передати HTTPS_PROXY і копію публічного CA-бандла (для мережевих проб doctor / npm view).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
id sitelens >/dev/null 2>&1 || useradd -m -s /bin/bash sitelens
mkdir -p "$ROOT/planning/qa/artifacts"
chmod -R a+rwX "$ROOT/planning/qa/artifacts"
cd "$ROOT"
ENVV=(HOME=/home/sitelens "PATH=$PATH" "PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" CI=true)
[ -n "${DOCTOR_OUT:-}" ] && ENVV+=("DOCTOR_OUT=$DOCTOR_OUT")
if [ "${SL_PASS_PROXY:-0}" = "1" ]; then
  for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do [ -n "${!v:-}" ] && ENVV+=("$v=${!v}"); done
  if [ -n "${SSL_CERT_FILE:-}" ] && [ -r "$SSL_CERT_FILE" ]; then
    install -m 644 "$SSL_CERT_FILE" /tmp/sitelens-ca.crt
    ENVV+=(SSL_CERT_FILE=/tmp/sitelens-ca.crt CURL_CA_BUNDLE=/tmp/sitelens-ca.crt NODE_EXTRA_CA_CERTS=/tmp/sitelens-ca.crt npm_config_cafile=/tmp/sitelens-ca.crt)
  fi
fi
exec runuser -u sitelens -- env -i "${ENVV[@]}" "$@"
