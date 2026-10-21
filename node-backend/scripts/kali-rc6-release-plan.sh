#!/usr/bin/env bash
# RC6 read-only plan for the isolated Kali Node staging installation.
# This script NEVER checks out code, migrates DB, restarts PM2 or enables payments.
set -Eeuo pipefail
if [[ "$#" -ne 2 || "$1" != "--plan" || ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'USAGE: bash scripts/kali-rc6-release-plan.sh --plan <REVIEWED_FULL_SHA>'
  exit 2
fi
EXPECTED="$2"
[[ "$(id -un)" == 'tala-node-stage' && "$(id -u)" != 0 &&
   "$HOME" == '/home/tala-node-stage' ]] || { echo 'ABORT_STAGE_USER_ONLY'; exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(git -C "$ROOT" rev-parse --show-toplevel)"
[[ "$ROOT" == "$REPO/node-backend" &&
   "$REPO" == "$HOME/tala-node-releases/$EXPECTED" &&
   ! -L "$REPO" && ! -L "$ROOT" ]] || {
  echo 'ABORT_RC6_MUST_RUN_FROM_SHA_PINNED_WORKTREE'; exit 1;
}
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$EXPECTED" &&
   -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || {
  echo 'ABORT_RC6_SHA_OR_DIRTY_WORKTREE'; exit 1;
}
for tool in git node npm pm2 curl python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ABORT_RC6_MISSING_$tool"; exit 1;
  }
done
node -e "const p=process.versions.node.split('.').map(Number);if(p[0]!==24||p[1]<11)process.exit(1)" || {
  echo 'ABORT_RC6_NODE24_REQUIRED'; exit 1;
}
ENVFILE="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENVFILE" && ! -L "$ENVFILE" &&
   "$(stat -c '%a' "$ENVFILE")" == 600 &&
   "$(stat -c '%u' "$ENVFILE")" == "$(id -u)" ]] || {
  echo 'ABORT_RC6_PRIVATE_STAGE_ENV'; exit 1;
}
# Live finance or an unexpected local database is never acceptable.
node --env-file="$ENVFILE" --input-type=module - <<'JS'
const p=new URL(process.env.DATABASE_URL||'https://invalid');
const r=new URL(process.env.REDIS_URL||'https://invalid');
const valid=process.env.NODE_ENV==='staging' &&
 process.env.HOST==='127.0.0.1'&&process.env.PORT==='18190' &&
 process.env.STRIPE_FINANCIAL_WRITES_ENABLED==='false' &&
 !String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_') &&
 ['postgres:','postgresql:'].includes(p.protocol) &&
 p.hostname==='127.0.0.1'&&p.port==='15435' &&
 p.username==='tala_node_stage'&&p.pathname==='/tala_node_stage'&&!!p.password &&
 r.protocol==='redis:'&&r.hostname==='127.0.0.1' &&
 r.port==='16379'&&r.pathname==='/0'&&!!r.password;
if(!valid)process.exit(2);
JS
echo 'RC6_ISOLATED_STAGE_ENV=PASS'
# The source-only check requires NO database/network access.
node scripts/rc6-schema-gate.mjs --check
node scripts/release-readiness.mjs --stage
# Reuse the native preflight which verifies the ACTIVE API/worker, ports and disk.
bash scripts/kali-stage-first-release-preflight.sh --plan
python3 scripts/kali-stage-migration-static-audit.py --check
bash scripts/kali-stage-migrate.sh --preflight
echo 'RC6_CANDIDATE_SHA='"$EXPECTED"
echo 'RC6_PREFLIGHT_NO_MUTATIONS=PASS'
echo 'RC6_MIGRATIONS_NOT_APPLIED_BY_THIS_SCRIPT=YES'
echo 'NEXT_MANUAL_GATES=BACKUP_RESTORE_SQL_REVIEW_MIGRATION_PM2_PROMOTION'
echo 'COMMERCIAL_PRODUCTION_AUTHORIZED=NO'
