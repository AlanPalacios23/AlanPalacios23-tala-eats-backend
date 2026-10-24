#!/usr/bin/env bash
# RC8.11 SHA-pinned candidate. Never touches running PM2 or modifies PostgreSQL.
set -Eeuo pipefail
set +x
umask 077
if [[ "$#" -ne 2 ]]; then echo 'USAGE --prepare|--plan|--verify FULL_SHA'; exit 2; fi
MODE="$1"; SHA="$2"
[[ "$MODE" == '--prepare' || "$MODE" == '--plan' || "$MODE" == '--verify' ]] || exit 2
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'RC811_FULL_SHA_REQUIRED'; exit 2; }
[[ "$(id -un)" == 'tala-node-stage' && "$(id -u)" != 0 &&
   "$HOME" == '/home/tala-node-stage' ]] || { echo 'RC811_ABORT=STAGE_ACCOUNT'; exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for x in git node npm pm2 curl python3; do
 command -v "$x" >/dev/null 2>&1 || { echo "RC811_ABORT=MISSING_$x"; exit 1; }
done
node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]===24&&v[1]>=11?0:1)' ||
 { echo 'RC811_ABORT=NODE24_REQUIRED'; exit 1; }
ROOT="$HOME/tala-node-releases/$SHA"; WORK="$ROOT/node-backend"
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
[[ -d "$ROOT" && -d "$WORK" && ! -L "$ROOT" && ! -L "$WORK" &&
   "$HERE" == "$WORK" ]] || { echo 'RC811_ABORT=PINNED_RELEASE_PATH'; exit 1; }
[[ "$(git -C "$ROOT" rev-parse --verify HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'RC811_ABORT=SOURCE_SHA_OR_DIRTY'; exit 1;
}
ENV="$HOME/.config/talaeats-node-staging.env"
[[ -f "$ENV" && ! -L "$ENV" &&
   "$(stat -c '%a' "$ENV")" == 600 &&
   "$(stat -c '%u' "$ENV")" == "$(id -u)" ]] || {
 echo 'RC811_ABORT=PRIVATE_STAGE_ENV'; exit 1;
}
# Fail closed; secrets and DB URLs never printed.
if ! node --env-file="$ENV" --input-type=module - <<'JS'
const p=process.env;
const pg=new URL(p.DATABASE_URL||'http://invalid');
const rd=new URL(p.REDIS_URL||'http://invalid');
const off=['STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_LIVE_ENABLED',
 'STRIPE_LIVE_RELEASE_APPROVED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_CONNECT_TRANSFERS_ENABLED','STRIPE_MANUAL_SETTLEMENT_APPROVED',
 'STAGE_DELIVERY_STRIPE_TEST_ENABLED'];
const bad=p.NODE_ENV!=='staging'||p.HOST!=='127.0.0.1'||p.PORT!=='18190'||
 !['postgres:','postgresql:'].includes(pg.protocol)||pg.hostname!=='127.0.0.1'||
 pg.port!=='15435'||pg.pathname!=='/tala_node_stage'||pg.username!=='tala_node_stage'||!pg.password||
 rd.protocol!=='redis:'||rd.hostname!=='127.0.0.1'||rd.port!=='16379'||rd.pathname!=='/0'||!rd.password||
 off.some(x=>p[x]==='true')||
 (p.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/.test(p.STRIPE_SECRET_KEY))||
 (p.STRIPE_PUBLISHABLE_KEY&&!p.STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_'))||
 Object.keys(p).some(x=>/^(MERCADOPAGO_|MP_ACCESS_TOKEN$)/i.test(x));
if(bad)process.exit(1);
JS
then echo 'RC811_ABORT=FINANCIAL_OR_SERVICE_ISOLATION'; exit 1; fi
echo 'RC811_SHA_AND_STAGE_ONLY_FLAGS=PASS'
cd "$WORK"
if [[ "$MODE" == '--prepare' ]]; then
 [[ -f package-lock.json && -f prisma/migrations/migration_lock.toml ]] ||
 { echo 'RC811_ABORT=LOCKFILES'; exit 1; }
 npm ci --no-audit --no-fund
 node --env-file="$ENV" ./node_modules/prisma/build/index.js generate
 node --env-file="$ENV" ./node_modules/prisma/build/index.js validate
 npm run build
 # Start npm CLI through node --env-file, so unit tests inherit the guarded
 # private STAGING environment without unsafe shell 'source' of credentials.
 node --env-file="$ENV" "$(readlink -f "$(command -v npm)")" test
 node scripts/release-readiness.mjs --stage
 bash -n scripts/rc811-kali-stage-promote.sh
 bash -n scripts/rc811-kali-stage-candidate.sh
 echo 'RC811_CANDIDATE_BUILD_AND_TEST=PASS'
 echo 'RC811_NO_DB_PM2_STRIPE_MUTATION=PASS'
 exit 0
fi
if [[ "$MODE" == '--verify' ]]; then
 bash scripts/rc89-stage-postdeploy-check.sh "$SHA"
 echo 'RC811_POSTDEPLOY_AUDIT=PASS'
 exit 0
fi
[[ -f dist/server.js && -f dist/worker.js && -x node_modules/.bin/prisma ]] ||
 { echo 'RC811_ABORT=PREPARE_FIRST'; exit 1; }
bash scripts/kali-stage-first-release-preflight.sh --plan
bash scripts/kali-stage-migrate.sh --preflight
if ! node --env-file="$ENV" ./node_modules/prisma/build/index.js migrate status \
    >/dev/null 2>&1; then
 echo 'RC811_ABORT=PRISMA_MIGRATIONS_PENDING_OR_DIVERGENT'
 echo 'RC811_MIGRATION_APPLY_NOT_AUTOMATIC'
 exit 1
fi
bash scripts/rc8-kali-public-pm2-upgrade.sh --plan "$SHA"
echo "RC811_REVIEWED_STAGE_SHA=$SHA"
echo 'RC811_PM2_PLAN_ONLY=PASS'
echo 'RC811_LIVE_PAYMENT_AND_PAYOUTS=OFF'
