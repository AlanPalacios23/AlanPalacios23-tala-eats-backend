#!/usr/bin/env bash
# RC7 preflight only: no deployment, no secrets, no payments, no migrations.
set -Eeuo pipefail
set +x
umask 077
API="https://talaeats.alan-palacios-dev.com/api/v1/ready"
LOCAL="http://127.0.0.1:18190/api/v1/ready"

if [[ "$(id -un)" != "tala-node-stage" ]]; then
  echo "RC7_PREFLIGHT_ABORT=RUN_AS_tala-node-stage"
  exit 1
fi
ENV_FILE="$HOME/.config/talaeats-node-staging.env"
if [[ -L "$ENV_FILE" || ! -f "$ENV_FILE" ||
      "$(stat -c '%a' "$ENV_FILE")" != "600" ||
      "$(stat -c '%u' "$ENV_FILE")" != "$(id -u)" ]]; then
  echo "RC7_PREFLIGHT_ABORT=PRIVATE_ENV_PERMISSIONS"
  exit 1
fi
if ! grep -Eq '^STRIPE_FINANCIAL_WRITES_ENABLED=false$' "$ENV_FILE"; then
  echo "RC7_PREFLIGHT_ABORT=FINANCIAL_WRITES_MUST_BE_FALSE"
  exit 1
fi
if grep -Eq '^STAGE_STRIPE_TEST_CHECKOUT_ENABLED=true$' "$ENV_FILE"; then
  echo "RC7_PREFLIGHT_ABORT=CHECKOUT_MUST_REMAIN_DISABLED_DURING_PREFLIGHT"
  exit 1
fi

check_ready(){
  local url="$1" label="$2" out
  out="$(curl -fsS --retry 1 --connect-timeout 4 --max-time 12 "$url")"
  printf '%s' "$out" | python3 -c '
import json,sys
body=json.load(sys.stdin)
assert body.get("ready") is True
assert body.get("database") is True
assert body.get("redis") is True
assert body.get("workerOnline") is True
assert body.get("productionReady") is False
assert body.get("financialWrites") is False
assert body.get("onlinePaymentsEnabled") is False
assert body.get("environment") == "staging"
assert body.get("digitalPaymentProvider") == "stripe"
' || { echo "RC7_PREFLIGHT_ABORT=${label}_WRONG_ENVIRONMENT"; exit 1; }
  echo "RC7_${label}_READINESS=PASS"
}

check_ready "$LOCAL" LOCAL
check_ready "$API" PUBLIC
for unit in tala-node-stage-pg15.service tala-node-stage-redis.service tala-node-stage-pm2.service; do
  if ! systemctl --user is-active --quiet "$unit"; then
    echo "RC7_PREFLIGHT_ABORT=UNIT_DOWN"
    exit 1
  fi
done
echo "RC7_STAGE_USER_UNITS=PASS"
echo "RC7_ENV_PRIVATE_0600=PASS"
echo "RC7_LIVE_PAYMENT_WRITES_DISABLED=YES"
echo "RC7_CHECKOUT_NOT_ACTIVATED=YES"
echo "RC7_PREFLIGHT_READ_ONLY=PASS"
echo "NEXT=Install a reviewed SHA with separate backup/rollback; test Stripe TEST before any LIVE approvals"
