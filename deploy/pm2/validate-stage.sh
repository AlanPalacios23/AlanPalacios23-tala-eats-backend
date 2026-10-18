#!/usr/bin/env bash
# Shared fail-closed guard for the dedicated PM2 staging VPS (never Kali LIVE).
# This file is sourced by both the deploy script and PM2 API/worker launchers.
APP_CONFIG="$HOME/.config/talaeats-pm2-stage.env"
if [[ ! -f "$APP_CONFIG" || -L "$APP_CONFIG" ]]; then
  echo "STAGE_CONFIG_MISSING" >&2
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
[[ "${ENVIRONMENT:-}" == "production" && "${DEBUG:-false}" == false ]] || {
  echo "STAGE_MODE_INVALID" >&2; exit 78;
}
for flag in STRIPE_ENABLED STRIPE_CONNECT_ENABLED STRIPE_CONNECT_SELF_SERVICE_ENABLED WITHDRAWALS_PREVIEW_ENABLED WITHDRAWALS_EXECUTION_ENABLED WITHDRAWALS_LIVE_ENABLED REQUIRE_ONLINE_PAYMENTS CASH_CHECKOUT_ENABLED SEED_DEMO_DATA AUTO_MIGRATE_ON_START; do
  [[ "${!flag:-false}" == false ]] || { echo "STAGE_FEATURE_DISABLED_REQUIRED: $flag" >&2; exit 78; }
done
for secret in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET MERCADO_PAGO_ACCESS_TOKEN MERCADO_PAGO_WEBHOOK_SECRET PAYOUT_API_TOKEN; do
  [[ -z "${!secret:-}" ]] || { echo "STAGE_PAYMENT_CREDENTIALS_FORBIDDEN" >&2; exit 78; }
done
# Never allow this candidate to connect to remote/production DB or Redis,
# or to read the production media directory, even through a symlink.
python3.13 - <<'PY'
import os
from pathlib import Path
from urllib.parse import urlsplit

db = urlsplit(os.environ.get("DATABASE_URL", ""))
redis = urlsplit(os.environ.get("REDIS_URL", ""))
media = Path(os.environ.get("MEDIA_DIR", "/")).resolve()
expected_media = (Path.home() / "talaeats-stage-media").resolve()
if not (db.scheme in {"postgresql", "postgresql+psycopg"}
        and db.hostname in {"localhost", "127.0.0.1"}
        and db.path == "/talaeats_stage"):
    raise SystemExit("STAGE_DB_ISOLATION_REQUIRED")
if not (redis.scheme in {"redis", "rediss"}
        and redis.hostname in {"localhost", "127.0.0.1"}
        and redis.path == "/1"):
    raise SystemExit("STAGE_REDIS_ISOLATION_REQUIRED")
if media != expected_media or not os.environ.get("MEDIA_DIR"):
    raise SystemExit("STAGE_MEDIA_ISOLATION_REQUIRED")
PY
