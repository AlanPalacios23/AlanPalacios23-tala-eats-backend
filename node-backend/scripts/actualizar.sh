#!/usr/bin/env bash
# TALA EATS: manual, direct Kali Node.js + PM2 staging update.
# NO cron, CI/CD, Tailscale, Docker, production payments or schema auto-migration.
# Default --plan is READ ONLY for application/runtime; --apply requires opt-in.
set -Eeuo pipefail

MODE="${1:---plan}"
if [[ "$#" -gt 1 || ( "$MODE" != "--plan" && "$MODE" != "--apply" ) ]]; then
  echo "USAGE: bash node-backend/scripts/actualizar.sh --plan|--apply"
  exit 2
fi
[[ "$(id -un)" == "tala-node-stage" && "$(id -u)" != 0 ]] || {
  echo "ABORT_STAGE_USER_ONLY"; exit 1;
}
[[ "$HOME" == "/home/tala-node-stage" ]] || { echo "ABORT_STAGE_HOME"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
[[ "$REPO" == "/home/tala-node-stage/"* && ! -L "$REPO" ]] || {
  echo "ABORT_REPOSITORY_OUTSIDE_STAGE_HOME"; exit 1;
}
[[ "$SCRIPT_DIR" == "$REPO/node-backend/scripts" ]] || {
  echo "ABORT_NOT_NODE_BACKEND_SCRIPT"; exit 1;
}
cd "$REPO"
REMOTE="$(git remote get-url origin)"
case "$REMOTE" in
  "https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git"|
  "git@github.com:AlanPalacios23/AlanPalacios23-tala-eats-backend.git") ;;
  *) echo "ABORT_UNEXPECTED_GITHUB_REMOTE"; exit 1;;
esac
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
[[ -n "$BRANCH" && "$BRANCH" != "main" && "$BRANCH" != "master" &&
   "$BRANCH" =~ ^[A-Za-z0-9_./-]+$ ]] || {
  echo "ABORT_STAGE_RELEASE_BRANCH_REQUIRED"; exit 1;
}
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || {
  echo "ABORT_DIRTY_TRACKED_FILES"; exit 1;
}
OLD_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$(git ls-remote --exit-code origin "refs/heads/$BRANCH" | awk '{print $1}')"
[[ "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "ABORT_REMOTE_SHA"; exit 1; }
printf 'STAGE_BRANCH=%s\nCURRENT_SHA=%s\nTARGET_SHA=%s\n' "$BRANCH" "$OLD_SHA" "$TARGET_SHA"
if [[ "$OLD_SHA" == "$TARGET_SHA" ]]; then
  echo "STAGE_ALREADY_UP_TO_DATE=PASS"; exit 0
fi
echo "STAGE_ACTION=RELEASE_SHA_CHECKED_MANUAL_PM2"
if [[ "$MODE" == "--plan" ]]; then
  echo "PLAN_ONLY_NO_APP_DB_OR_PM2_CHANGES=PASS"
  echo "NEXT_STEP=RUN_APPLY_AFTER_REVIEW_AND_BACKUP"
  exit 0
fi
[[ "${TALA_STAGE_UPDATE_APPROVAL:-}" == "I_APPROVE_STAGE_PM2_CODE_ONLY" ]] || {
  echo "ABORT_EXPLICIT_STAGE_UPDATE_APPROVAL"; exit 1;
}
for command_name in node npm pm2 git curl; do
  command -v "$command_name" >/dev/null || { echo "ABORT_MISSING_$command_name"; exit 1; }
done
node -e '
const parts=process.versions.node.split(".").map(Number);
if(parts[0]!==24 || parts[1]<11)process.exit(1)
' || { echo "ABORT_NODE24_REQUIRED"; exit 1; }

ENVFILE="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENVFILE" && ! -L "$ENVFILE" &&
   "$(stat -c '%a' "$ENVFILE")" == "600" &&
   "$(stat -c '%u' "$ENVFILE")" == "$(id -u)" ]] || {
  echo "ABORT_PRIVATE_STAGING_ENV"; exit 1;
}
# Verify env target WITHOUT displaying connection credentials.
node --env-file="$ENVFILE" --input-type=module - <<'JS'
const pg=new URL(process.env.DATABASE_URL||'https://invalid');
const redis=new URL(process.env.REDIS_URL||'https://invalid');
const good=process.env.NODE_ENV==='staging' &&
  process.env.HOST==='127.0.0.1' && process.env.PORT==='18190' &&
  process.env.STRIPE_FINANCIAL_WRITES_ENABLED==='false' &&
  !String(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live_') &&
  ['postgres:','postgresql:'].includes(pg.protocol) &&
  pg.hostname==='127.0.0.1' && pg.port==='15435' &&
  pg.username==='tala_node_stage' && pg.pathname==='/tala_node_stage' &&
  Boolean(pg.password) && redis.protocol==='redis:' &&
  redis.hostname==='127.0.0.1' && redis.port==='16379' &&
  redis.pathname==='/0' && Boolean(redis.password) &&
  !Object.keys(process.env).some(x=>/^(MERCADOPAGO_|MP_ACCESS_TOKEN$|MP_PUBLIC_KEY$|MP_WEBHOOK_SECRET$)/i.test(x));
if(!good)process.exit(1);
JS
echo "STAGE_RESOURCE_ISOLATION=PASS"

# Pin the complete SHA and require fast-forward from the currently reviewed branch.
git fetch --no-tags origin "$BRANCH"
[[ "$(git rev-parse FETCH_HEAD)" == "$TARGET_SHA" ]] || {
  echo "ABORT_REMOTE_BRANCH_CHANGED_DURING_UPDATE"; exit 1;
}
git merge-base --is-ancestor "$OLD_SHA" "$TARGET_SHA" || {
  echo "ABORT_NON_FAST_FORWARD_RELEASE"; exit 1;
}
[[ -n "$(git ls-tree -r --name-only "$TARGET_SHA" -- node-backend/src/server.ts)" ]] || {
  echo "ABORT_NODE_SOURCE_MISSING"; exit 1;
}
# Schema changes are never applied from this convenience updater.
# They require separate reviewed migrations, backup and restore first.
if [[ -n "$(git diff --name-only "$OLD_SHA" "$TARGET_SHA" -- node-backend/prisma)" ]]; then
  echo "ABORT_PRISMA_CHANGE_REQUIRES_REVIEWED_MIGRATION_AND_MANUAL_RELEASE"
  exit 1
fi

# Current PM2 stage must be exactly the expected API + worker.
PREVIOUS_DIR="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
try {
  const a=JSON.parse(s);
  const names=a.map(x=>x.name).sort();
  if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"]))process.exit(2);
  if(a.some(x=>x.pm2_env?.status!=="online"))process.exit(3);
  const api=a.find(x=>x.name==="tala-node-stage-api");
  const cwd=api.pm2_env?.pm_cwd;
  if(typeof cwd!=="string" || !cwd.startsWith("/home/tala-node-stage/") ||
    !cwd.endsWith("/node-backend"))process.exit(4);
  process.stdout.write(cwd);
}catch{process.exit(5)}
})')" || { echo "ABORT_UNEXPECTED_PM2_STAGE_PROCESSES"; exit 1; }
[[ -f "$PREVIOUS_DIR/ecosystem.config.cjs" ]] || {
  echo "ABORT_PREVIOUS_PM2_RELEASE_UNRECOVERABLE"; exit 1;
}
echo "PREVIOUS_RELEASE_RECOVERY=PASS"

curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready |
  node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
    try{const j=JSON.parse(s);process.exit(j.ready===true&&j.database===true&&
    j.redis===true&&j.financialWrites===false?0:1)}catch{process.exit(1)}
  })' || { echo "ABORT_EXISTING_STAGE_NOT_READY"; exit 1; }

RELEASES="$HOME/tala-node-releases"
TARGET_DIR="$RELEASES/$TARGET_SHA"
[[ ! -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]] || {
  echo "ABORT_RELEASE_DIR_ALREADY_PRESENT_INSPECT_MANUALLY"; exit 1;
}
mkdir -p -m 700 "$RELEASES"
git worktree add --detach "$TARGET_DIR" "$TARGET_SHA"
cd "$TARGET_DIR/node-backend"
npm ci --no-audit --no-fund
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js generate
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js validate
npm run build
npm test
# Fail closed if staging DB is not already at the expected migration head.
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js migrate status ||
  { echo "ABORT_PENDING_PRISMA_MIGRATIONS_NO_PM2_CHANGE"; exit 1; }
echo "CANDIDATE_BUILT_AND_MIGRATIONS_CURRENT=PASS"

ROLLOUT_STARTED=no
ROLLOUT_OK=no
rollback() {
  if [[ "$ROLLOUT_STARTED" != yes || "$ROLLOUT_OK" == yes ]]; then return; fi
  trap - ERR
  echo "STAGE_ROLLBACK_START"
  pm2 delete tala-node-stage-api >/dev/null 2>&1 || true
  pm2 delete tala-node-stage-worker >/dev/null 2>&1 || true
  cd "$PREVIOUS_DIR"
  TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env || true
  TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env || true
  if curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/ready >/dev/null; then
    pm2 save >/dev/null || true
    echo "STAGE_ROLLBACK_HTTP_READY=PASS"
  else
    echo "STAGE_ROLLBACK_HTTP_READY=FAIL_REQUIRES_OPERATOR"
  fi
}
trap rollback ERR EXIT
ROLLOUT_STARTED=yes
pm2 delete tala-node-stage-worker
pm2 delete tala-node-stage-api
TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env
for attempt in $(seq 1 25); do
  if curl -fsS --max-time 3 http://127.0.0.1:18190/api/v1/ready 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
      try{const j=JSON.parse(s);process.exit(j.ready===true&&j.database===true&&
        j.redis===true&&j.financialWrites===false?0:1)}catch{process.exit(1)}
    })' >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 25 ]]; then
    echo "STAGE_CANDIDATE_NOT_READY"; false
  fi
  sleep 2
done
TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env
pm2 jlist | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
const a=JSON.parse(s); const names=a.map(x=>x.name).sort();
if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"]) ||
a.some(x=>x.pm2_env?.status!=="online"))process.exit(1)
})'
pm2 save
ROLLOUT_OK=yes
trap - ERR EXIT
printf 'STAGE_PM2_RELEASE=PASS\nSTAGE_DEPLOYED_SHA=%s\n' "$TARGET_SHA"
echo "PYTHON_DOCKER_CLOUDFLARE_LIVE_PAYMENTS=UNTOUCHED"
