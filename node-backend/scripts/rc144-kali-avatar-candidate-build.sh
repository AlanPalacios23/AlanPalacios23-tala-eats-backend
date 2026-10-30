#!/usr/bin/env bash
# RC144: prepare candidate ONLY (new release's node_modules/dist). Never deploy.
set -Eeuo pipefail
set +x
export GIT_OPTIONAL_LOCKS=0
umask 077
SHA="${1:-}"
[[ "$#" -eq 1 && "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
 echo 'RC144_CANDIDATE=HOLD_SHA_REQUIRED';exit 2;
}
[[ "$(id -un)" == tala-node-stage && "$HOME" == /home/tala-node-stage ]] || {
 echo 'RC144_CANDIDATE=HOLD_SERVICE_USER';exit 2;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || {
 echo 'RC144_CANDIDATE=HOLD_NODE24';exit 2;
}
ROOT="$HOME/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
[[ -d "$WORK" && ! -L "$WORK" && ! -L "$ROOT" ]] || {
 echo 'RC144_CANDIDATE=HOLD_EXACT_REPO_CHECKOUT_REQUIRED';exit 2;
}
[[ "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" ]] || {
 echo 'RC144_CANDIDATE=HOLD_WRONG_SCRIPT_SOURCE';exit 2;
}
actual="$(git -C "$ROOT" rev-parse HEAD)" || exit 2
tracked="$(git -C "$ROOT" status --porcelain --untracked-files=no)" || exit 2
[[ "$actual" == "$SHA" && -z "$tracked" ]] || {
 echo 'RC144_CANDIDATE=HOLD_SHA_OR_DIRTY_TREE';exit 2;
}
cd "$WORK"
npm ci --no-audit --no-fund
npm audit --omit=dev --audit-level=high --no-fund
# Unit verification must NEVER inherit the production .env or credentials.
env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH"  NODE_ENV=staging HOST=127.0.0.1 PORT=18190  DATABASE_URL='postgresql://tala_node_stage:NoRealAccess@127.0.0.1:15435/tala_node_stage'  REDIS_URL='redis://:NoRealAccess@127.0.0.1:16379/0'  STRIPE_LIVE_ENABLED=false STRIPE_FINANCIAL_WRITES_ENABLED=false  STRIPE_LIVE_RELEASE_APPROVED=false STRIPE_REFUNDS_ENABLED=false  STRIPE_CONNECT_TRANSFERS_ENABLED=false  STRIPE_MANUAL_SETTLEMENT_APPROVED=false  TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED=false  DRIVER_AVATAR_UPLOAD_ENABLED=false  npm run verify
[[ -s "$WORK/dist/server.js" && -s "$WORK/dist/driver-avatar.js" &&
   -s "$WORK/dist/live/production-worker.js" ]] || {
 echo 'RC144_CANDIDATE=HOLD_COMPILE_OUTPUT';exit 2;
}
echo "RC144_AVATAR_CANDIDATE_SHA=$SHA"
echo 'RC144_AVATAR_CANDIDATE=PASS_NOT_DEPLOYED'
echo 'RC144_PRODUCTION_PM2_STRIPE_PG_ENV=UNCHANGED'
