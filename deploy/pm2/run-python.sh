#!/usr/bin/env bash
# Loads only a local 0600 environment file and starts the Python API or worker.
set -Eeuo pipefail
umask 077
APP_CONFIG="$HOME/.config/talaeats-pm2-stage.env"
if [[ ! -f "$APP_CONFIG" || -L "$APP_CONFIG" ]]; then
  echo "STAGE_CONFIG_MISSING: $APP_CONFIG" >&2
  exit 78
fi
if [[ "$(stat -c %u "$APP_CONFIG")" != "$(id -u)" || "$(stat -c %a "$APP_CONFIG")" != "600" ]]; then
  echo "STAGE_CONFIG_PERMISSIONS_INVALID" >&2
  exit 78
fi
# shellcheck disable=SC1090
set -a
source "$APP_CONFIG"
set +a
[[ "${ENVIRONMENT:-}" == "production" ]] || { echo "ENVIRONMENT must be production" >&2; exit 78; }
[[ "${DATABASE_URL:-}" == postgresql* && -n "${REDIS_URL:-}" ]] || {
  echo "Separate staging PostgreSQL and Redis are required" >&2; exit 78;
}
[[ "${STRIPE_ENABLED:-false}" == false && "${STRIPE_CONNECT_ENABLED:-false}" == false &&
   "${STRIPE_CONNECT_SELF_SERVICE_ENABLED:-false}" == false &&
   "${WITHDRAWALS_EXECUTION_ENABLED:-false}" == false &&
   "${WITHDRAWALS_LIVE_ENABLED:-false}" == false ]] || {
  echo "STAGING_PAYMENT_GUARD: Stripe and withdrawals disabled" >&2; exit 78;
}
[[ -z "${STRIPE_SECRET_KEY:-}" && -z "${MERCADO_PAGO_ACCESS_TOKEN:-}" ]] || {
  echo "STAGING_PAYMENT_GUARD: no payment credentials on staging" >&2; exit 78;
}
[[ "${AUTO_MIGRATE_ON_START:-false}" != true && "${SEED_DEMO_DATA:-false}" == false ]] || {
  echo "No auto migrations or seed from PM2" >&2; exit 78;
}
case "${1:-}" in
  api)
    exec .venv/bin/python -m uvicorn app.main:app \
      --host 127.0.0.1 --port 18090 --workers 2 \
      --proxy-headers --forwarded-allow-ips 127.0.0.1 \
      --timeout-graceful-shutdown 25
    ;;
  worker)
    exec .venv/bin/python -m app.worker
    ;;
  *)
    echo "Usage: run-python.sh api|worker" >&2
    exit 2
    ;;
esac
