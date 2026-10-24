#!/usr/bin/env bash
# RC8.11 authorized in-place PM2 stage-only release.
# This wrapper NEVER migrates database or enables Stripe LIVE / Connect.
# Uses audited RC8 promoter (PG15 backup+restore and automatic rollback on
# failure during PM2 cutover), and RC8.9 post-deploy read-only audit.
set -Eeuo pipefail
set +x
umask 077
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
 echo 'USAGE: bash scripts/rc811-kali-stage-promote.sh --plan|--apply|--verify SHA [I_APPROVE_RC811_STAGE_PM2_ONLY]'
 exit 2
fi
MODE="$1"; SHA="$2"; APPROVAL=""
if [[ "$#" -eq 3 ]]; then APPROVAL="$3"; fi
[[ "$MODE" == '--plan' || "$MODE" == '--apply' || "$MODE" == '--verify' ]] || exit 2
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'RC811_FULL_SHA_REQUIRED'; exit 2; }
[[ "$(id -un)" == 'tala-node-stage' && "$(id -u)" != 0 &&
   "$HOME" == '/home/tala-node-stage' ]] || {
 echo 'RC811_ABORT=STAGE_OPERATOR_ONLY'; exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"; WORK="$ROOT/node-backend"
[[ -d "$WORK" && ! -L "$ROOT" && ! -L "$WORK" ]] ||
 { echo 'RC811_ABORT=RELEASE_NOT_PREPARED'; exit 1; }
[[ "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" ]] ||
 { echo 'RC811_ABORT=WRONG_RELEASE_SOURCE'; exit 1; }
cd "$WORK"
if [[ "$MODE" == '--verify' ]]; then
 bash scripts/rc811-kali-stage-candidate.sh --verify "$SHA"
 exit 0
fi
bash scripts/rc811-kali-stage-candidate.sh --plan "$SHA"
if [[ "$MODE" == '--plan' ]]; then
 echo 'RC811_STAGE_DEPLOYMENT_PLAN=PASS_READ_ONLY'
 exit 0
fi
[[ "$APPROVAL" == 'I_APPROVE_RC811_STAGE_PM2_ONLY' ]] || {
 echo 'RC811_ABORT=EXPLICIT_STAGE_ONLY_APPROVAL_REQUIRED'; exit 2;
}
echo 'RC811_STAGE_PROMOTION_BEGIN'
echo 'RC811_DATABASE_MIGRATIONS=NOT_AUTOMATIC'
# Existing promoter stops only owned API+worker after candidate gates,
# verified backup AND restore; it restarts prior SHAs on cutover failure.
bash scripts/rc8-kali-public-pm2-upgrade.sh --apply "$SHA" I_APPROVE_RC8_PUBLIC_PM2_STAGE_ONLY
echo 'RC811_PM2_PROMOTION=PASS'
# No automatic rollback after this point: if stage has accepted live client
# traffic, rolling back code requires operator review of persisted orders.
if ! bash scripts/rc89-stage-postdeploy-check.sh "$SHA"; then
 echo 'RC811_POSTDEPLOY_AUDIT=FAIL_CLOSED'
 echo 'RC811_ACTION=STOP_AND_REVIEW_ORDERS_BEFORE_ROLLBACK'
 exit 1
fi
echo 'RC811_POSTDEPLOY_READ_ONLY=PASS'
echo 'RC811_STAGE_SHA=$SHA'
echo 'RC811_LIVE_PAYMENTS_AND_PAYOUTS=NOT_ENABLED'
echo 'RC811_COMMERCIAL_LAUNCH_APPROVED=NO'
