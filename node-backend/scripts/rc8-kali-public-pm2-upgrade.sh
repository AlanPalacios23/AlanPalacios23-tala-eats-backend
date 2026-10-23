#!/usr/bin/env bash
# RC8 IN-PLACE PUBLIC PM2 rollout via the existing, audited Node stage promoter.
# Same 127.0.0.1:18190 API, existing Cloudflared domain, PG15 & Redis8.
# NO Docker, NO new PM2 process, NO LIVE charges, no automatic DB migration.
# --apply is the ONLY mutating operation, and includes backup/restore/rollback.
set -Eeuo pipefail
set +x
umask 077
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
MODE="${1:-}"
SHA="${2:-}"
APPROVAL="${3:-}"
[[ "$MODE" == "--plan" || "$MODE" == "--apply" || "$MODE" == "--verify" ]] || {
  echo "USAGE: bash scripts/rc8-kali-public-pm2-upgrade.sh --plan|--apply|--verify <FULL_SHA> [I_APPROVE_RC8_PUBLIC_PM2_STAGE_ONLY]"
  exit 2
}
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "ABORT_RC8_FULL_SHA_REQUIRED"; exit 2; }
[[ "$(id -un)" == "tala-node-stage" && "$HOME" == "/home/tala-node-stage" ]] || {
  echo "ABORT_RC8_STAGE_ACCOUNT_REQUIRED"; exit 1;
}
CANDIDATE="$HOME/tala-node-releases/$SHA/node-backend"
ROOT="$HOME/tala-node-releases/$SHA"
[[ -d "$CANDIDATE" && ! -L "$CANDIDATE" && ! -L "$ROOT" ]] || {
  echo "ABORT_RC8_SOURCE_ABSENT_OR_SYMLINK"; exit 1;
}
[[ "$(git -C "$ROOT" rev-parse --verify HEAD)" == "$SHA" ]] || {
  echo "ABORT_RC8_CANDIDATE_SHA_MISMATCH"; exit 1;
}
cd "$CANDIDATE"
[[ -f src/live/isolated-app.ts &&
   -f src/live/webhook-inbox.ts &&
   -f src/live/worker-runner.ts ]] || {
  echo "ABORT_RC8_LIVE_MODULES_MISSING"; exit 1;
}
# Existing public runtime is a stage-controlled PM2 process. Not a payment go-live.
# Never elevate NODE_ENV, use live keys, or set financial writes to true.
ENVFILE="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENVFILE" && ! -L "$ENVFILE" &&
   "$(stat -c '%a' "$ENVFILE")" == 600 ]] || {
  echo "ABORT_RC8_PRIVATE_STAGE_CONFIG"; exit 1;
}
# First stage promoter enforces the full environment/PG15/Redis8/PM2 identity,
# complete fresh DB backup, isolated restore rehearsal, and rollback.
if [[ "$MODE" == "--plan" ]]; then
  bash scripts/kali-stage-first-pm2-promote.sh --plan "$SHA"
  echo "RC8_PUBLIC_PM2_PLAN=PASS"
  echo "STRIPE_LIVE_CHARGES=NOT_ENABLED"
  exit 0
fi
if [[ "$MODE" == "--apply" ]]; then
  [[ "$APPROVAL" == "I_APPROVE_RC8_PUBLIC_PM2_STAGE_ONLY" ]] || {
    echo "ABORT_RC8_PUBLIC_PM2_APPROVAL_REQUIRED"; exit 2;
  }
  export TALA_STAGE_FIRST_PROMOTE_APPROVAL=I_APPROVE_FIRST_NODE_STAGE_PM2_ONLY
  export TALA_STAGE_BACKUP_APPROVAL=I_APPROVE_STAGE_DB_BACKUP_ONLY
  export TALA_STAGE_RESTORE_APPROVAL=I_APPROVE_ISOLATED_STAGING_RESTORE_TEST
  bash scripts/kali-stage-first-pm2-promote.sh --apply "$SHA"
fi
bash scripts/kali-stage-postdeploy-smoke.sh "$SHA"
# Public URL must still route to the current PM2 (the old Cloudflared tunnel).
curl --fail --silent --show-error --max-time 12 \
  https://talaeats.alan-palacios-dev.com/api/v1/ready |
node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
  try {const v=JSON.parse(s);process.exit(
    v.ready===true&&v.database===true&&v.redis===true&&
    v.workerOnline===true&&v.productionReady===false&&
    v.financialWrites===false&&v.onlinePaymentsEnabled===false&&
    v.digitalPaymentProvider==="stripe" ?0:1)}catch{process.exit(1)}
})' || {
  echo "RC8_PUBLIC_DOMAIN_READY_CHECK=FAILED_REVIEW_PROXY"; exit 1;
}
echo "RC8_PUBLIC_PM2_ACTIVE_SHA=$SHA"
echo "RC8_EXISTING_PUBLIC_DOMAIN=PASS"
echo "RC8_PUBLIC_NODE_API_WORKER=PASS"
echo "RC8_FINANCIAL_WRITES=OFF"
echo "RC8_STRIPE_LIVE=NOT_ACTIVATED"
