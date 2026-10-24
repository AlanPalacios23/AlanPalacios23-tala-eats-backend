#!/usr/bin/env bash
# RC8.13 ONE-LIVE preflight. NO mutation of production PM2, DB, Redis or Stripe.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"; SHA="${2:-}"
if [[ "$#" -ne 2 || ! "$MODE" =~ ^--(prepare|plan|verify)$ ||
      ! "$SHA" =~ ^[a-f0-9]{40}$ ]];then
 echo 'USAGE: bash scripts/rc813-unified-live-preflight.sh --prepare|--plan|--verify EXACT_40_SHA'; exit 2
fi
[[ "$(id -un)" == tala-node-stage && "$HOME" == /home/tala-node-stage && "$(id -u)" != 0 ]] || {
 echo 'RC813_LIVE_ABORT=SERVICE_USER_ONLY';exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"
DIR="$ROOT/node-backend"
LIVE="$HOME/.config/talaeats-node-live.env"
[[ -d "$DIR" && ! -L "$ROOT" && ! -L "$DIR" &&
   "$(cd "$(dirname "$0")/.." && pwd -P)" == "$DIR" &&
   "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'RC813_LIVE_ABORT=LOCKED_SHA_REQUIRED';exit 1;
}
[[ -f "$LIVE" && ! -L "$LIVE" && "$(stat -c '%a' "$LIVE")" == 600 &&
   "$(stat -c '%u' "$LIVE")" == "$(id -u)" ]] || {
 echo 'RC813_LIVE_ABORT=PRIVATE_LIVE_ENV_0600_REQUIRED';exit 1;
}
cd "$DIR"
if [[ "$MODE" == --prepare ]];then
 npm ci --no-audit --no-fund
 # Build before loading dist/config. This is the first time the pinned
 # release is prepared on Kali, not an already running checkout.
 npm run generate
 npm run build
fi
run_live(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
  node --env-file="$LIVE" "$@"
}
# No credentials or PostgreSQL URLs are printed. No get/set of Stripe resources.
run_live --input-type=module - <<'JS'
import {config} from './dist/config.js';
const liveFlags=['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
 'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_MANUAL_SETTLEMENT_APPROVED'];
if(config.NODE_ENV!=='production'||config.HOST!=='127.0.0.1'||
 config.PORT!==18190||config.STAGE_PARALLEL_ENABLED!=='false'||
 config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
 // LIVE pickup code retains its existing flag. Never disable active
 // customer pickup while replacing the binary.
 config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='false'||
 config.STAGE_DRIVER_DELIVERY_ENABLED!=='false'||
 config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='false'||
 config.STAGE_DELIVERY_STRIPE_TEST_ENABLED!=='false'||
 liveFlags.some(f=>config[f]!=='true'))
 throw Error('RC813_LIVE_FLAGS_OR_UNREVIEWED_DELIVERY');
console.log('RC813_ONE_LIVE_FINANCIAL_FLAGS_COMPATIBLE=PASS');
console.log('RC813_CONNECT_AUTOMATIC_TRANSFERS=OFF');
console.log('RC813_UNREVIEWED_LIVE_DELIVERY_FLAGS=OFF');
JS
if [[ "$MODE" == --prepare ]];then
 run_live ./node_modules/prisma/build/index.js validate
 # Synthetic tests must not inherit STRIPE LIVE secrets from either process.
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
 NODE_ENV=staging HOST=127.0.0.1 PORT=18190 \
 DATABASE_URL=postgresql://tala_node_stage:ci-only@127.0.0.1:15435/tala_node_stage \
 REDIS_URL=redis://:ci-only@127.0.0.1:16379/0 \
 STRIPE_FINANCIAL_WRITES_ENABLED=false STRIPE_LIVE_ENABLED=false \
 STRIPE_CONNECT_TRANSFERS_ENABLED=false npm test
 echo 'RC813_ONE_LIVE_COMPILE_TESTS=PASS_NO_PAYMENT_WRITES'
 exit 0
fi
[[ -f dist/server.js && -f dist/live/production-worker.js ]] || {
 echo 'RC813_LIVE_ABORT=RUN_PREPARE_FIRST';exit 1;
}
if [[ "$MODE" == --verify ]];then
 run_live --input-type=module - <<'JS'
const local='http://127.0.0.1:18190/api/v1',pub='https://talaeats.alan-palacios-dev.com/api/v1';
for(const base of [local,pub]){
 const h=await fetch(base+'/health',{signal:AbortSignal.timeout(12000)});
 const ready=await fetch(base+'/ready',{signal:AbortSignal.timeout(12000)});
 const [a,b]=await Promise.all([h.json(),ready.json()]);
 if(!h.ok||!ready.ok||a.status!=='ok'||a.version!=='rc8.13-unified-live'||
 a.production!==true||a.online_payment_writes!==true||b.ready!==true||
 b.environment!=='production'||b.workerOnline!==true||b.financialWrites!==true||
 b.onlinePaymentsEnabled!==true)throw Error('RC813_LIVE_POSTDEPLOY_NOT_READY');
}
console.log('RC813_UNIFIED_LIVE_LOCAL_AND_PUBLIC_READY=PASS');
JS
 exit 0
fi
# Read-only checks BEFORE touching the currently payment-capable LIVE stack.
node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
const p=JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8',timeout:12000}));
const names=p.map(x=>x.name).sort();
if(JSON.stringify(names)!==JSON.stringify(['tala-node-stage-api','tala-node-stage-worker'])||
 p.some(x=>x.pm2_env?.NODE_ENV!=='production'||x.pm2_env?.status!=='online'))
 throw Error('RC813_LIVE_PM2_IDENTITIES_NOT_TWO_RUNNING_PRODUCTION');
const dir=p[0].pm2_env.pm_cwd;
if(!p.every(x=>x.pm2_env.pm_cwd===dir)||!dir.startsWith('/home/tala-node-stage/tala-node-releases/'))
 throw Error('RC813_LIVE_PM2_RELEASE_DIRECTORY_UNEXPECTED');
console.log('RC813_OLD_LIVE_TWO_PM2_PROCESSES=PASS');
console.log('RC813_OLD_LIVE_SHA='+execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim());
JS
# A read-only status operation; no auto-migrations or DDL.
run_live ./node_modules/prisma/build/index.js migrate status || {
 echo 'RC813_LIVE_ABORT=PRISMA_DIVERGENCE_OR_PENDING_MIGRATION';exit 1;
}
# Payment-risk hold, Stripe GET-only and production SQL read-only.
run_live scripts/rc86-live-activation-audit.mjs || {
 echo 'RC813_LIVE_ABORT=FINANCIAL_AUDIT_HOLD';exit 1;
}
run_live --input-type=module - <<'JS'
const bases=['http://127.0.0.1:18190','https://talaeats.alan-palacios-dev.com'];
for(const base of bases){
 const h=await fetch(base+'/api/v1/health',{signal:AbortSignal.timeout(12000)});
 const ready=await fetch(base+'/api/v1/ready',{signal:AbortSignal.timeout(12000)});
 const [a,b]=await Promise.all([h.json(),ready.json()]);
 if(!h.ok||!ready.ok||a.production!==true||
 a.online_payment_writes!==true||b.workerOnline!==true||
 b.ready!==true||b.environment!=='production'||
 b.financialWrites!==true||b.onlinePaymentsEnabled!==true)
 throw Error('RC813_EXISTING_LIVE_HEALTH_OR_PAYMENTS_HOLD');
}
console.log('RC813_EXISTING_LIVE_LOCAL_PUBLIC_READY=PASS');
JS
echo 'RC813_ONE_LIVE_PROMOTION_PLAN=PASS_READ_ONLY'
echo 'RC813_LIVE_18190_UNCHANGED=YES'
echo 'RC813_STAGING_18192_STILL_SEPARATE_UNTIL_CUTOVER=YES'
