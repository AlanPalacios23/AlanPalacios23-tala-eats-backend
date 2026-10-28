#!/usr/bin/env bash
# RC9.1 Tala Eats — onboarding-ready non-spending candidate for the LIVE Kali machine.
# PREPARE writes only to the *new* SHA-named checkout (node_modules/dist).
# Never changes PM2, PostgreSQL, Redis, .env, Cloudflared or Stripe.
set -Eeuo pipefail
set +x
umask 077
if [[ $# != 2 || ! "$1" =~ ^--(plan|prepare|verify)$ || ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
  echo "USAGE: bash scripts/rc9-kali-prepare-release.sh --plan|--prepare|--verify FULL_SHA"
  exit 2
fi
MODE="$1"; SHA="$2"
if [[ "$(id -un)" != 'tala-node-stage' || "$(id -u)" == 0 || "$HOME" != '/home/tala-node-stage' ]]; then
  echo "RC91_ABORT=REQUIRES_UNPRIVILEGED_TALA_NODE_STAGE"; exit 1
fi
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for x in node npm pm2 git curl; do
  command -v "$x" >/dev/null || { echo "RC91_ABORT=MISSING_$x"; exit 1; }
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24&&minor>=11?0:1)' || {
  echo 'RC91_ABORT=NODE_24_11_OR_NEWER_REQUIRED'; exit 1;
}
PARENT="$HOME/tala-node-releases"
ROOT="$PARENT/$SHA"
WORK="$ROOT/node-backend"
[[ -d "$PARENT" && ! -L "$PARENT" && -d "$ROOT" && ! -L "$ROOT" && -d "$WORK" && ! -L "$WORK" ]] || {
  echo 'RC91_ABORT=EXACT_RELEASE_DIRECTORY_REQUIRED'; exit 1;
}
[[ "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" == "$WORK" ]] || {
  echo 'RC91_ABORT=WRONG_SCRIPT_LOCATION'; exit 1;
}
[[ "$(git -C "$ROOT" rev-parse --verify HEAD)" == "$SHA" ]] || {
  echo 'RC91_ABORT=COMMIT_SHA_NOT_PINNED'; exit 1;
}
[[ "$(git -C "$ROOT" remote get-url origin)" == 'https://github.com/AlanPalacios23/AlanPalacios23-tala-eats-backend.git' ]] || {
  echo 'RC91_ABORT=ORIGIN_MISMATCH'; exit 1;
}
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
  echo 'RC91_ABORT=TRACKED_FILES_CHANGED'; exit 1;
}
[[ -f "$WORK/package-lock.json" && -f "$WORK/prisma/migrations/20261028_treasury_v1_restaurant_driver/migration.sql" ]] || {
  echo 'RC91_ABORT=TREASURY_MIGRATION_OR_LOCKFILE_MISSING'; exit 1;
}
# Fingerprint current protected LIVE runtime without printing process env.
# Both existing apps must STILL run the release the operator observed.
CURRENT_SHA="561c842c583940f5b01f650c8dbe3c26a770d85f"
EXPECTED_ROOT="$HOME/tala-node-releases/$CURRENT_SHA/node-backend"
export EXPECTED_ROOT
pm2 jlist | node --input-type=commonjs -e '
let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{
 try {
  const all=JSON.parse(s);
  const want={ "tala-node-stage-api":"dist/server.js",
    "tala-node-stage-worker":"dist/live/production-worker.js"};
  for(const [name,rel] of Object.entries(want)){
   const candidates=all.filter(x=>x.name===name);
   if(candidates.length!==1)throw Error("PROCESS_IDENTITY");
   const p=candidates[0];
   if(p.pm2_env?.status!=="online" ||
      p.pm2_env?.pm_exec_path!==process.env.EXPECTED_ROOT+"/"+rel ||
      p.pm2_env?.pm_cwd!==process.env.EXPECTED_ROOT)
    throw Error("PROCESS_RELEASE_CHANGED");
  }
  console.log("RC91_EXISTING_LIVE_PM2=PASS_UNCHANGED");
 }catch{console.log("RC91_ABORT=LIVE_PM2_DIFFERS_FROM_ATTESTED_BASE");process.exitCode=1;}
});'
curl --fail --silent --show-error --max-time 8 http://127.0.0.1:18190/api/v1/ready |
node -e '
let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{
 try{const v=JSON.parse(s);
  if(v.ready!==true||v.database!==true||v.redis!==true||
     v.workerOnline!==true||v.environment!=="production"||
     v.onlinePaymentsEnabled!==true)throw Error("NOT_LIVE_READY");
  console.log("RC91_CURRENT_LIVE_READY=PASS_UNCHANGED");
 }catch{console.log("RC91_ABORT=LIVE_READINESS_CHANGED");process.exitCode=1;}
});'
cd "$WORK"
node scripts/rc9-treasury-live-preflight.mjs
if [[ "$MODE" == '--plan' ]]; then
  echo "RC91_PLAN=PASS_READ_ONLY"
  echo "RC91_PINNED_SHA=$SHA"
  echo 'RC91_DB_MIGRATION=UNCHANGED'
  echo 'RC91_PM2=NOT_MODIFIED'
  echo 'RC91_STRIPE_LIVE_WITHDRAWALS=OFF'
  exit 0
fi
if [[ "$MODE" == '--prepare' ]]; then
  # Inert placeholder build configuration. Never load or print LIVE env.
  # Source-only build/test with inert credentials matching staging's
  # strict CONFIG SHAPE. These dummy values cannot authenticate to LIVE.
  # Never inherit Stripe keys from the operator's shell.
  unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PUBLISHABLE_KEY
  unset STRIPE_CONNECT_WEBHOOK_SECRET STRIPE_PLATFORM_ACCOUNT_ID
  export NODE_ENV=staging
  export HOST='127.0.0.1'
  export PORT='18190'
  export DATABASE_URL='postgresql://tala_node_stage:rc9-ci-invalid@127.0.0.1:15435/tala_node_stage'
  export REDIS_URL='redis://:rc9-ci-invalid@127.0.0.1:16379/0'
  export STRIPE_FINANCIAL_WRITES_ENABLED=false
  export STRIPE_LIVE_ENABLED=false
  export STRIPE_LIVE_RELEASE_APPROVED=false
  export STRIPE_CONNECT_TRANSFERS_ENABLED=false
  export STRIPE_REFUNDS_ENABLED=false
  export STRIPE_MANUAL_SETTLEMENT_APPROVED=false
  export TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED=false
  npm ci --no-audit --no-fund
  npm run generate
  npm run db:validate
  npm run build
  npm test
  echo 'RC91_CANDIDATE_BUILD_AND_TEST=PASS'
fi
[[ -f dist/server.js && -f dist/live/production-worker.js && -f dist/live/treasury-router.js ]] || {
  echo 'RC91_ABORT=COMPILED_TREASURY_RUNTIME_MISSING'; exit 1;
}
echo "RC91_VERIFIED_CANDIDATE_SHA=$SHA"
echo 'RC91_CANDIDATE_FILES=READY'
echo 'RC91_PRODUCTION_RUNTIME=UNCHANGED'
echo 'RC91_DATABASE_SCHEMA=UNCHANGED'
echo 'RC91_WITHDRAWALS_LIVE=OFF'
