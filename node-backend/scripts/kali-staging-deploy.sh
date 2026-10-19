#!/usr/bin/env bash
# New native Node staging only; NEVER manipulates the Python/Docker V3 stack.
# --preflight: read-only; --apply: only after explicit operator approval.
set -euo pipefail
MODE='--preflight'
if [ "$#" -gt 0 ]; then MODE="$1"; fi
if [ "$MODE" != '--preflight' ] && [ "$MODE" != '--apply' ]; then
  echo 'USAGE --preflight|--apply'; exit 2
fi
if [ "$(id -un)" != 'tala-node-stage' ] || [ "$(id -u)" -eq 0 ]; then
  echo 'ABORT_STAGE_USER_REQUIRED'; exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
ENVFILE="$HOME/.config/talaeats-node-staging.env"
if [ ! -f "$ENVFILE" ] || [ -L "$ENVFILE" ] ||
   [ "$(stat -c '%a' "$ENVFILE")" != '600' ] ||
   [ "$(stat -c '%u' "$ENVFILE")" != "$(id -u)" ]; then
  echo 'ABORT_STAGING_ENV_PERMISSIONS'; exit 1
fi
case "$ENVFILE" in "$ROOT"/*) echo 'ABORT_STAGING_ENV_IN_REPO'; exit 1;; esac
for tool in node npm pm2 curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ABORT_MISSING_$tool"; exit 1; }
done
node -e 'const a=process.versions.node.split(".").map(Number);if(a[0]!==24||a[1]<11)process.exit(1)' || {
  echo 'ABORT_NODE_24_LTS_REQUIRED'; exit 1
}
if [ ! -s package-lock.json ] ||
   [ ! -f prisma/migrations/migration_lock.toml ]; then
  echo 'ABORT_LOCKFILE_OR_MIGRATIONS_MISSING'; exit 1
fi
if ! node --env-file="$ENVFILE" -e '
 const pg=new URL(process.env.DATABASE_URL||"http://none");
 const rd=new URL(process.env.REDIS_URL||"http://none");
 const pass=process.env.STRIPE_FINANCIAL_WRITES_ENABLED==="false" &&
  process.env.NODE_ENV==="staging" && process.env.HOST==="127.0.0.1" &&
  process.env.PORT==="18190" &&
  ["postgresql:","postgres:"].includes(pg.protocol) &&
  pg.hostname==="127.0.0.1" && pg.port==="15435" &&
  pg.username==="tala_node_stage" && pg.pathname==="/tala_node_stage" &&
  !!pg.password && rd.protocol==="redis:" &&
  rd.hostname==="127.0.0.1" && rd.port==="16379" &&
  rd.pathname==="/0" && !!rd.password &&
  !(process.env.STRIPE_SECRET_KEY||"").startsWith("sk_live_");
 if(!pass)process.exit(1);
' >/dev/null 2>&1; then
  echo 'ABORT_STAGING_RESOURCE_GUARD'; exit 1
fi
echo 'STAGING_PREPARED_CONFIG=PASS'
if [ "$MODE" = '--preflight' ]; then
  echo 'NO_CHANGES_PERFORMED'
  exit 0
fi
if [ "$(printenv TALA_STAGE_START_APPROVAL 2>/dev/null || true)" != 'I_APPROVE_LOCAL_STAGE_PM2_ONLY' ]; then
  echo 'ABORT_EXPLICIT_STAGING_PM2_APPROVAL'; exit 1
fi
# npm ci must not edit package-lock: CI has already validated SHA-locked deps.
npm ci --no-audit --no-fund
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js generate
node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js validate
npm run build
npm test
bash scripts/kali-stage-migrate.sh --preflight
# Ensure schema already applied. Never run migration automatically in --apply.
if ! node --env-file="$ENVFILE" ./node_modules/prisma/build/index.js migrate status >/dev/null 2>&1; then
  echo 'ABORT_STAGE_MIGRATIONS_NOT_APPLIED'; exit 1
fi

# --only preserves the deliberate sequence: API health BEFORE worker.
TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env
healthy=no
for try in $(seq 1 20); do
  if curl -fsS --max-time 3 http://127.0.0.1:18190/api/v1/ready 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{let j=JSON.parse(s);process.exit(j.ready===true&&j.financialWrites===false?0:1)}catch{process.exit(1)}})' >/dev/null 2>&1; then
    healthy=yes
    break
  fi
  sleep 2
done
if [ "$healthy" != yes ]; then
  echo 'STAGING_API_NOT_READY_NO_WORKER_START'; exit 1
fi
echo 'STAGING_API_READY=PASS'
TALA_STAGE_ENV_FILE="$ENVFILE" pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env
echo 'STAGING_PM2_API_AND_WORKER_STARTED=yes'
echo 'LIVE_DOCKER_AND_STRIPE_UNCHANGED=yes'
echo 'PM2_STARTUP_PERSISTENCE_NOT_CONFIGURED=yes'
