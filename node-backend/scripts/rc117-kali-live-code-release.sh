#!/usr/bin/env bash
# RC11.7 guarded LIVE code release. NO test payments or LIVE money changes.
# Run from exact SHA release: --plan SHA, --apply SHA OLD_SHA I_APPROVE_RC117_LIVE_CODE_ONLY, --verify SHA.
set -Eeuo pipefail
set +x
umask 077
if [[ $# -lt 2 ]];then echo RC117_CODE_RELEASE=HOLD_INVALID_ARGUMENTS;exit 2;fi
mode="$1";sha="$2"
if [[ ! "$mode" =~ ^--(plan|apply|verify)$ || ! "$sha" =~ ^[a-f0-9]{40}$ ]];then
 echo RC117_CODE_RELEASE=HOLD_INVALID_ARGUMENTS;exit 2
fi
case "$mode" in
 --plan|--verify)
  [[ $# -eq 2 ]] || { echo RC117_CODE_RELEASE=HOLD_ARGUMENTS;exit 2; };;
 --apply)
  [[ $# -eq 4 && "$3" =~ ^[a-f0-9]{40}$ &&
     "$4" == I_APPROVE_RC117_LIVE_CODE_ONLY ]] ||
    { echo RC117_CODE_RELEASE=HOLD_EXPLICIT_APPROVAL_REQUIRED;exit 2; };;
esac
[[ "$(id -un)" == tala-node-stage && "$(id -u)" != 0 &&
    "$HOME" == /home/tala-node-stage ]] ||
 { echo RC117_CODE_RELEASE=HOLD_SERVICE_USER;exit 2; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in node npm git pm2 curl python3; do
 command -v "$cmd" >/dev/null ||
  { echo "RC117_CODE_RELEASE=HOLD_DEPENDENCY_$cmd";exit 2; }
done
[[ "$(node --version)" =~ ^v24\. ]] ||
 { echo RC117_CODE_RELEASE=HOLD_NODE_24_REQUIRED;exit 2; }
root="$HOME/tala-node-releases/$sha"
work="$root/node-backend"
[[ -d "$root" && ! -L "$root" && -d "$work" && ! -L "$work" &&
   "$(git -C "$root" rev-parse HEAD)" == "$sha" &&
   -z "$(git -C "$root" status --porcelain --untracked-files=no)" ]] ||
 { echo RC117_CODE_RELEASE=HOLD_PINNED_RELEASE_MISSING;exit 2; }
cd "$work"
[[ -s package-lock.json &&
   -s scripts/rc114-kali-live-code-cutover.sh &&
   -s scripts/rc117-kali-live-public-preflight.mjs ]] ||
 { echo RC117_CODE_RELEASE=HOLD_RELEASE_FILES;exit 2; }
if [[ "$mode" != --verify ]];then
 echo RC117_CODE_PREPARE=START
 npm ci --no-audit --no-fund
 # The full node:test suite imports dist/config.js in several test modules.
 # It requires an env even though no test may touch LIVE funds. Use synthetic
 # staging-shaped, deliberately invalid credentials in a scrubbed subprocess.
 # NEVER load the real LIVE env into unit tests and never contact Stripe.
 echo RC117_ISOLATED_TEST_ENV=SYNTHETIC_NO_LIVE_SECRETS
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
   NODE_ENV=staging HOST=127.0.0.1 PORT=18190 \
   DATABASE_URL="postgresql://tala_node_stage:RC117SyntheticNonProductionNoAccess@127.0.0.1:15435/tala_node_stage" \
   REDIS_URL="redis://:RC117SyntheticNonProductionNoAccess@127.0.0.1:16379/0" \
   STRIPE_FINANCIAL_WRITES_ENABLED=false STRIPE_LIVE_ENABLED=false \
   STRIPE_LIVE_RELEASE_APPROVED=false STRIPE_REFUNDS_ENABLED=false \
   STRIPE_CONNECT_TRANSFERS_ENABLED=false STRIPE_MANUAL_SETTLEMENT_APPROVED=false \
   STAGE_PICKUP_CASH_CHECKOUT_ENABLED=false STAGE_DELIVERY_CASH_CHECKOUT_ENABLED=false \
   STAGE_DRIVER_DELIVERY_ENABLED=false STAGE_DELIVERY_STRIPE_TEST_ENABLED=false \
   STAGE_STRIPE_TEST_CHECKOUT_ENABLED=false \
   npm run verify
 test -s dist/server.js
 test -s dist/live/production-worker.js
 bash scripts/rc114-kali-live-code-cutover.sh --plan "$sha"
 echo RC117_CODE_PREPARE=PASS
fi
if [[ "$mode" == --plan ]];then
 echo RC117_DEPLOYMENT=READY_FOR_EXPLICIT_CODE_ONLY_APPROVAL
 echo RC117_MONEY_FLAGS=UNCHANGED
 exit 0
fi
if [[ "$mode" == --apply ]];then
 bash scripts/rc114-kali-live-code-cutover.sh --apply "$sha" "$3" \
  I_APPROVE_RC114_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY
 # RC11.4 rolls back on its own switching errors. Extend rollback to the
 # post-switch public PWA probe; do not leave a partially green deployment.
 if ! bash scripts/rc114-kali-live-code-cutover.sh --verify "$sha" ||
    ! node --env-file="$HOME/.config/talaeats-node-live.env" \
      scripts/rc117-kali-live-public-preflight.mjs "$sha";then
  echo RC117_POST_SWITCH_GATE=HOLD_TRY_ROLLBACK
  bash scripts/rc114-kali-live-code-cutover.sh --rollback "$sha" \
    I_APPROVE_RC114_ROLLBACK_PREVIOUS_TWO_PM2 || \
   echo RC117_ROLLBACK=FAILED_MANUAL_INTERVENTION_REQUIRED
  exit 1
 fi
else
 bash scripts/rc114-kali-live-code-cutover.sh --verify "$sha"
 node --env-file="$HOME/.config/talaeats-node-live.env" \
  scripts/rc117-kali-live-public-preflight.mjs "$sha"
fi
echo RC117_BACKEND_AND_PUBLIC_PWA_HTTP=PASS
echo RC117_LIVE_CODE_RELEASE=PASS
echo RC117_PRODUCTION_PAYMENTS_OR_WITHDRAWALS_NEWLY_ACTIVATED=NO
echo RC117_REAL_COMMERCIAL_E2E=NOT_YET_VERIFIED
