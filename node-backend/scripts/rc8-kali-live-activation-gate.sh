#!/usr/bin/env bash
# RC8 Stripe LIVE activation gate. READ-ONLY. No payments or service changes.
# Usage: bash scripts/rc8-kali-live-activation-gate.sh --plan|--require-ready
set -Eeuo pipefail
set +x
umask 077

case "${1:-}" in --plan|--require-ready) MODE="$1";; *)
  echo "USAGE --plan|--require-ready"; exit 2;; esac
[[ $# == 1 ]] || exit 2
[[ "$(id -un)" == "tala-node-stage" &&
   "$HOME" == "/home/tala-node-stage" ]] || {
  echo "RC8_GATE=REFUSE_NOT_STAGE_OPERATOR"; exit 1;
}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$ROOT" == "$HOME/tala-node-releases/"*/node-backend &&
   ! -L "$ROOT" ]] || {
  echo "RC8_GATE=REFUSE_UNREVIEWED_SOURCE"; exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in git node pm2 curl; do
  command -v "$cmd" >/dev/null || {
    echo "RC8_GATE=REFUSE_MISSING_$cmd";exit 1;
  }
done
SHA="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ "$ROOT" == "$HOME/tala-node-releases/$SHA/node-backend" ]] || {
  echo "RC8_GATE=REFUSE_RELEASE_SHA_PATH_MISMATCH"; exit 1;
}
echo "RC8_CANDIDATE_SHA=$SHA"

# Specific readiness evidence only. Never inspect or echo private credentials.
[[ -f "$ROOT/dist/live/guard.js" &&
   -f "$ROOT/dist/live/financial-readiness.js" ]] || {
  echo "RC8_CODE_COMPILED=NO";exit 1;
}
echo "RC8_CODE_COMPILED=YES"

# Independent runtime is required to serve customers. RC8 currently
# contains isolated library primitives, not a complete LIVE application.
if [[ -f "$ROOT/dist/live/server.js" &&
      -f "$ROOT/dist/live/worker-runner.js" ]]; then
  echo "RC8_INDEPENDENT_LIVE_RUNTIME=PRESENT_UNVERIFIED"
else
  echo "RC8_INDEPENDENT_LIVE_RUNTIME=MISSING"
fi

if [[ -f "$ROOT/dist/live/refunds.js" &&
      -f "$ROOT/dist/live/disputes.js" ]]; then
  echo "RC8_REFUND_DISPUTE_AUTOMATION=PRESENT_UNVERIFIED"
else
  echo "RC8_REFUND_DISPUTE_AUTOMATION=MISSING"
fi

if [[ -f "$ROOT/dist/live/connect-v2.js" ]]; then
  echo "RC8_CONNECT_V2_SETTLEMENT=PRESENT_UNVERIFIED"
else
  echo "RC8_CONNECT_V2_SETTLEMENT=MISSING"
fi

if [[ -f "$ROOT/dist/live/fiscal-guard.js" ]]; then
  echo "RC8_FISCAL_REVIEW=PRESENT_UNVERIFIED"
else
  echo "RC8_FISCAL_REVIEW=MISSING"
fi

if [[ -f "$ROOT/docs/RC8-LIVE-E2E-SIGNED-OFF.md" ]]; then
  echo "RC8_SIGNED_TEST_PAYMENT_E2E=REVIEW_DOCUMENT_PRESENT"
else
  echo "RC8_SIGNED_TEST_PAYMENT_E2E=NO_DOCUMENT"
fi

# CRITICAL: prerequisites cannot be inferred from file existence.
# No source-only automation may authorize real money movement.
echo "RC8_STRIPE_LIVE_READINESS=NO_GO"
echo "RC8_PUBLIC_PM2_CHANGES=NONE"
echo "RC8_MONEY_TRANSFERS=NONE"
if [[ "$MODE" == --require-ready ]]; then
  echo "RC8_LIVE_ACTIVATION_REFUSED=MANUAL_RELEASE_AND_E2E_REQUIRED"
  exit 3
fi
echo "RC8_READ_ONLY_PLAN=PASS"
