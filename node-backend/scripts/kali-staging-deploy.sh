#!/usr/bin/env bash
# Operator-approved staging only. No sudo or Docker calls.
set -euo pipefail
mode="--preflight"
if [[ "$#" -gt 0 ]]; then mode="$1"; fi
if [[ "$mode" != "--preflight" && "$mode" != "--apply" ]]; then
  echo 'USAGE --preflight|--apply'; exit 2
fi
if [[ "$(id -u)" == 0 ]]; then echo ABORT_ROOT_USER; exit 1; fi
here="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$here"
secretfile="$HOME/.config/talaeats-node-staging.env"
case "$secretfile" in "$here"/*) echo ABORT_SECRET_IN_REPO; exit 1;; esac
if [[ ! -f "$secretfile" || -L "$secretfile" ]]; then
  echo ABORT_PRIVATE_ENV_MISSING; exit 1
fi
if [[ "$(stat -c %a "$secretfile")" != 600 || "$(stat -c %u "$secretfile")" != "$(id -u)" ]]; then
  echo ABORT_ENV_PERMISSIONS; exit 1
fi
if [[ ! -s package-lock.json ]]; then echo ABORT_LOCKFILE_REQUIRED; exit 1; fi
if [[ ! -f prisma/migrations/migration_lock.toml ]]; then echo ABORT_MIGRATIONS_REQUIRED; exit 1; fi
for c in node npm pm2; do
  command -v "$c" >/dev/null 2>&1 || { echo "ABORT_COMMAND_$c"; exit 1; }
done
node -e 'const a=process.versions.node.split(".").map(Number);if(a[0]!==24||a[1]<11)process.exit(1)' || { echo ABORT_NODE24; exit 1; }
if ! node --env-file="$secretfile" -e '
  let u=new URL(process.env.DATABASE_URL||"http://invalid");
  let r=new URL(process.env.REDIS_URL||"http://invalid");
  let good=process.env.NODE_ENV==="staging" && process.env.HOST==="127.0.0.1" &&
    process.env.PORT==="18190" && ["postgres:","postgresql:"].includes(u.protocol) &&
    u.hostname==="127.0.0.1" && u.port==="15435" &&
    u.username==="tala_node_stage" && u.pathname==="/tala_node_stage" && !!u.password &&
    r.protocol==="redis:" && r.hostname==="127.0.0.1" &&
    r.port==="16379" && r.pathname==="/0" && !!r.password &&
    process.env.STRIPE_FINANCIAL_WRITES_ENABLED==="false" &&
    !(process.env.STRIPE_SECRET_KEY||"").startsWith("sk_live_");
  if(!good)process.exit(1);
' >/dev/null 2>&1; then echo ABORT_STAGING_GUARDS; exit 1; fi
echo STAGING_PREFLIGHT=PASS
if [[ "$mode" == "--preflight" ]]; then echo NO_MUTATIONS; exit 0; fi
if [[ "$(printenv TALA_STAGE_MIGRATIONS_APPLIED 2>/dev/null || true)" != "approved-and-verified" ]]; then
  echo ABORT_MIGRATIONS_NOT_VERIFIED; exit 1
fi
npm ci --no-audit --no-fund
npm run generate
npm run db:validate
npm run build
npm test
TALA_STAGE_ENV_FILE="$secretfile" pm2 start ecosystem.config.cjs --update-env
echo STAGING_ONLY_PM2_STARTED_CHECK_HEALTH
