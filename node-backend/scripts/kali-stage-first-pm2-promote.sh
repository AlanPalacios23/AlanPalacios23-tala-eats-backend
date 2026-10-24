#!/usr/bin/env bash
# First-time promotion of a built Node.js staging candidate to PM2 in Kali.
# NO CI/CD, NO Docker, NO production API, NO Stripe financial writes.
# --plan is read-only. --apply requires an explicit stage-only approval.
# Never applies Prisma migrations: run the separate backup/restore+migrate gate.
set -Eeuo pipefail
MODE="--plan"
EXPECTED_SHA=""
if [[ "$#" == 2 ]]; then
  MODE="$1"
  EXPECTED_SHA="$2"
else
  echo "USAGE: bash scripts/kali-stage-first-pm2-promote.sh --plan|--apply <FULL_SHA>"
  exit 2
fi
[[ "$MODE" == "--plan" || "$MODE" == "--apply" ]] || { echo "ABORT_INVALID_MODE"; exit 2; }
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "ABORT_EXPECTED_FULL_SHA"; exit 2; }
[[ "$(id -un)" == "tala-node-stage" && "$(id -u)" != 0 &&
   "$HOME" == "/home/tala-node-stage" ]] || { echo "ABORT_STAGE_USER"; exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for executable in git node npm pm2 curl python3; do
  command -v "$executable" >/dev/null 2>&1 || {
    echo "ABORT_MISSING_TOOL=$executable"; exit 1;
  }
done

CANDIDATE_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
CANDIDATE_ROOT="$(git -C "$CANDIDATE_DIR" rev-parse --show-toplevel)"
[[ "$CANDIDATE_DIR" == "$CANDIDATE_ROOT/node-backend" &&
   "$CANDIDATE_ROOT" == "$HOME/tala-node-releases/$EXPECTED_SHA" &&
   ! -L "$CANDIDATE_ROOT" && ! -L "$CANDIDATE_DIR" ]] || {
  echo "ABORT_CANDIDATE_OUTSIDE_STAGE_HOME_OR_NOT_SOURCE"; exit 1;
}
ACTUAL_SHA="$(git -C "$CANDIDATE_ROOT" rev-parse --verify HEAD)"
[[ "$EXPECTED_SHA" == "$ACTUAL_SHA" ]] || {
  echo "ABORT_CANDIDATE_SHA_MISMATCH"; exit 1;
}
[[ -z "$(git -C "$CANDIDATE_ROOT" status --porcelain --untracked-files=no)" ]] || {
  echo "ABORT_CANDIDATE_DIRTY"; exit 1;
}
echo "CANDIDATE_SHA_VERIFIED=$ACTUAL_SHA"
ENVFILE="$HOME/.config/talaeats-node-staging.env"
# Hard-stop if the CURRENT PM2 instance or its dependencies are not healthy.
bash "$CANDIDATE_DIR/scripts/kali-stage-first-release-preflight.sh" --plan

# PM2 must already be running the known native stage version. Never overwrite
# its code or delete processes owned by others.
ACTIVE_DIR="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
try{
 const a=JSON.parse(s),names=a.map(y=>y.name).sort();
 if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"]))process.exit(1);
 if(a.some(y=>y.pm2_env?.status!=="online"))process.exit(2);
 const dirs=a.map(y=>y.pm2_env?.pm_cwd);
 if(dirs[0]!==dirs[1] || !dirs[0]?.startsWith("/home/tala-node-stage/") ||
    !dirs[0].endsWith("/node-backend"))process.exit(3);
 process.stdout.write(dirs[0]);
}catch{process.exit(4)}
})')" || { echo "ABORT_UNEXPECTED_EXISTING_PM2_PROCESSES"; exit 1; }
[[ "$ACTIVE_DIR" != "$CANDIDATE_DIR" &&
   -f "$ACTIVE_DIR/ecosystem.config.cjs" && -f "$ACTIVE_DIR/dist/server.js" &&
   -f "$ACTIVE_DIR/dist/worker.js" ]] || {
  echo "ABORT_PREVIOUS_STAGE_RELEASE_NOT_ROLLBACK_READY"; exit 1;
}
PREVIOUS_SHA="$(git -C "$ACTIVE_DIR" rev-parse --verify HEAD)" || {
  echo "ABORT_PREVIOUS_STAGE_GIT_VERSION_UNKNOWN"; exit 1;
}
echo "PM2_PREVIOUS_SHA=$PREVIOUS_SHA"
echo "PM2_CANDIDATE_SHA=$EXPECTED_SHA"
if [[ "$PREVIOUS_SHA" == "$EXPECTED_SHA" ]]; then
  echo "ALREADY_RUNNING_CANDIDATE_SHA=PASS"; exit 0;
fi
if [[ "$MODE" == "--plan" ]]; then
  echo "FIRST_STAGE_PROMOTION_PLAN_ONLY=PASS"
  echo "PM2_RESTART=NO_DB_MIGRATION=NO_BACKUP=NO"
  exit 0
fi

[[ "$(printenv TALA_STAGE_FIRST_PROMOTE_APPROVAL 2>/dev/null || true)" == "I_APPROVE_FIRST_NODE_STAGE_PM2_ONLY" ]] || {
  echo "ABORT_STAGE_PM2_PROMOTE_APPROVAL"; exit 1;
}
[[ "$(printenv TALA_STAGE_BACKUP_APPROVAL 2>/dev/null || true)" == "I_APPROVE_STAGE_DB_BACKUP_ONLY" ]] || {
  echo "ABORT_STAGE_BACKUP_APPROVAL"; exit 1;
}
[[ "$(printenv TALA_STAGE_RESTORE_APPROVAL 2>/dev/null || true)" == "I_APPROVE_ISOLATED_STAGING_RESTORE_TEST" ]] || {
  echo "ABORT_STAGE_RESTORE_APPROVAL"; exit 1;
}
cd "$CANDIDATE_DIR"
# RC6 checks are mandatory even when an operator calls promotion directly,
# bypassing the separate read-only release plan.
node scripts/rc6-schema-gate.mjs --check
node scripts/release-readiness.mjs --stage
echo "RC6_PROMOTION_SOURCE_GATES=PASS"
# Build independently of the running PM2 cwd. All preflight work is done
# before stopping either process. Secrets stay outside version control.
npm ci --no-audit --no-fund
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js generate
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js validate
npm run build
# Run tests under the same protected STAGING environment as API+worker;
# never shell-source a secret file. The old command inherited no stage env.
node --env-file="$ENVFILE" "$(readlink -f "$(command -v npm)")" test
python3 scripts/kali-stage-migration-static-audit.py --check
bash scripts/kali-stage-migrate.sh --preflight

# Backup DB BEFORE any restart, and rehearse full restore on socket-only
# scratch PostgreSQL. These calls only target a guarded PG15 stage identity.
python3 scripts/kali-stage-backup.py --apply
python3 scripts/kali-stage-test-restore.py --apply

# Optional staging media backup: never follows symlinks and stays user-private.
MEDIA="$HOME/media"
if [[ -e "$MEDIA" ]]; then
  [[ -d "$MEDIA" && ! -L "$MEDIA" ]] || {
    echo "ABORT_STAGE_MEDIA_PATH_UNSAFE"; exit 1;
  }
  BACKUPS="$HOME/.local/share/talaeats-node-native/backups"
  [[ -d "$BACKUPS" && ! -L "$BACKUPS" &&
     "$(stat -c '%a' "$BACKUPS")" == 700 ]] || {
    echo "ABORT_BACKUP_DIR_UNSAFE"; exit 1;
  }
  umask 077
  tar -C "$HOME" -czf "$BACKUPS/stage-media-before-$EXPECTED_SHA.tar.gz" media
  echo "STAGE_MEDIA_BACKUP=PASS"
else
  echo "STAGE_MEDIA=ABSENT_REVIEW_UPLOADS_BEFORE_LIVE"
fi

# This does NOT migrate. If any migration is pending, stop before changing PM2.
if ! node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js migrate status; then
  echo "ABORT_PRISMA_PENDING_OR_FAILED_RUN_SEPARATE_STAGE_MIGRATION_GATE"
  exit 1
fi
echo "PRISMA_MIGRATIONS_CURRENT=PASS"
ROLLOUT_STARTED=no
ROLLOUT_OK=no
rollback() {
  local original_status="$?"
  trap - EXIT
  if [[ "$ROLLOUT_STARTED" != yes || "$ROLLOUT_OK" == yes ]]; then
    exit "$original_status"
  fi
  echo "STAGE_PM2_ROLLBACK_BEGIN"
  pm2 delete tala-node-stage-worker >/dev/null 2>&1 || true
  pm2 delete tala-node-stage-api >/dev/null 2>&1 || true
  cd "$ACTIVE_DIR" || exit "$original_status"
  TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env || true
  TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env || true
  if curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready |
    node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
      try{const v=JSON.parse(s);process.exit(v.ready===true&&v.database===true&&
       v.redis===true&&v.financialWrites===false?0:1)}catch{process.exit(1)}
    })' >/dev/null 2>&1; then
    pm2 save >/dev/null || true
    echo "STAGE_PM2_ROLLBACK_READY=PASS"
  else
    echo "STAGE_PM2_ROLLBACK_READY=FAIL_MANUAL_REVIEW_REQUIRED"
  fi
  exit "$original_status"
}
trap rollback EXIT

# Change ONLY named stage processes, and start API before worker.
ROLLOUT_STARTED=yes
pm2 delete tala-node-stage-worker
pm2 delete tala-node-stage-api
TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env
API_READY=no
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:18190/api/v1/ready 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
      try{const v=JSON.parse(s);process.exit(v.ready===true&&v.database===true&&
       v.redis===true&&v.financialWrites===false?0:1)}catch{process.exit(1)}
    })' >/dev/null 2>&1; then
    API_READY=yes
    break
  fi
  sleep 2
done
[[ "$API_READY" == yes ]] || { echo "ABORT_CANDIDATE_API_NOT_READY"; exit 1; }
TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env
bash scripts/kali-stage-postdeploy-smoke.sh "$EXPECTED_SHA"
pm2 save
ROLLOUT_OK=yes
trap - EXIT
echo "FIRST_NODE_PM2_STAGE_PROMOTION=PASS"
echo "ACTIVE_NODE_SHA=$EXPECTED_SHA"
echo "PUBLIC_PYTHON_DOCKER_STRIPE_LIVE=UNTOUCHED"
