#!/usr/bin/env bash
# RC8.13 Kali: separate staging PM2 daemon on 127.0.0.1:18192.
# Leaves public LIVE Node :18190, default PM2_HOME, Cloudflared and Stripe untouched.
set -Eeuo pipefail
set +x
umask 077

if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
 echo 'USAGE: bash scripts/rc813-parallel-stage.sh --prepare|--plan|--apply|--verify FULL_SHA [I_APPROVE_RC813_PARALLEL_STAGE_ONLY]'
 exit 2
fi
MODE="$1"; SHA="$2"; APPROVAL="${3:-}"
[[ "$MODE" =~ ^--(prepare|plan|apply|verify)$ &&
   "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'RC813_INVALID_MODE_OR_SHA'; exit 2; }
[[ "$(id -un)" == 'tala-node-stage' && "$(id -u)" != 0 &&
   "$HOME" == '/home/tala-node-stage' ]] || { echo 'RC813_STAGE_USER_REQUIRED'; exit 1; }

export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
ENV="$HOME/.config/talaeats-node-rc813-parallel.env"
STAGE_PM2_HOME="$HOME/.pm2-tala-rc813-parallel"
ECO="$WORK/ecosystem.rc813-parallel.cjs"
[[ -d "$ROOT" && -d "$WORK" && ! -L "$ROOT" && ! -L "$WORK" &&
   "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" &&
   "$(git -C "$ROOT" rev-parse --verify HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'RC813_RELEASE_NOT_CLEAN_OR_PINNED'; exit 1;
}
[[ -f "$ENV" && ! -L "$ENV" &&
   "$(stat -c '%a' "$ENV")" == '600' &&
   "$(stat -c '%u' "$ENV")" == "$(id -u)" ]] || {
 echo 'RC813_PRIVATE_PARALLEL_ENV_REQUIRED'; exit 1;
}
[[ -f "$ECO" ]] || { echo 'RC813_ECOSYSTEM_MISSING'; exit 1; }
for executable in node npm pm2 curl ss git; do
 command -v "$executable" >/dev/null || { echo "RC813_MISSING_TOOL=$executable"; exit 1; }
done

# Starts Node with ONLY this release's private env, never PM2's live env.
stage_node(){
  env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
    node --env-file="$ENV" "$@"
}

# Check exact localhost DB/Redis identity and isolated flags; never print secrets.
cd "$WORK"
stage_node --input-type=module - <<'JS'
import {Redis} from 'ioredis';
import pg from 'pg';
const x=process.env;
const pgUrl=new URL(x.DATABASE_URL??'http://invalid');
const rdUrl=new URL(x.REDIS_URL??'http://invalid');
const off=['STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_LIVE_ENABLED',
 'STRIPE_LIVE_RELEASE_APPROVED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_CONNECT_TRANSFERS_ENABLED','STRIPE_MANUAL_SETTLEMENT_APPROVED',
 'STAGE_STRIPE_TEST_CHECKOUT_ENABLED','STAGE_DELIVERY_STRIPE_TEST_ENABLED'];
if(x.NODE_ENV!=='staging'||x.STAGE_PARALLEL_ENABLED!=='true'||
   x.HOST!=='127.0.0.1'||x.PORT!=='18192'||
   pgUrl.hostname!=='127.0.0.1'||pgUrl.port!=='15435'||
   pgUrl.username!=='tala_node_stage'||pgUrl.pathname!=='/tala_node_stage'||
   !pgUrl.password||rdUrl.hostname!=='127.0.0.1'||rdUrl.port!=='16379'||
   rdUrl.pathname!=='/1'||!rdUrl.password||
   off.some(k=>x[k]==='true')||
   (x.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/.test(x.STRIPE_SECRET_KEY))||
   (x.STRIPE_PUBLISHABLE_KEY&&!x.STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_')))
  throw Error('RC813_PARALLEL_STAGE_ISOLATION_REQUIRED');
const client=new pg.Client({connectionString:x.DATABASE_URL,connectionTimeoutMillis:3000});
try{
  await client.connect();
  const q=await client.query(
    "SELECT current_database() db,current_user usr,current_setting('server_version_num')::int ver,inet_server_port() port");
  const a=q.rows[0];
  if(a.db!=='tala_node_stage'||a.usr!=='tala_node_stage'||
     a.ver<150000||a.ver>=160000||a.port!==15435)
    throw Error('RC813_PG15_STAGE_IDENTITY_MISMATCH');
}finally{await client.end().catch(()=>{});}
const redis=new Redis(x.REDIS_URL,{lazyConnect:true,connectTimeout:2000,
  maxRetriesPerRequest:1,retryStrategy:()=>null});
try{
  await redis.connect();
  if(await redis.ping()!=='PONG')throw Error('RC813_REDIS_STAGE_DB1_NOT_READY');
}finally{redis.disconnect();}
console.log('RC813_STAGE_PG15_AND_REDIS_DB1=PASS');
console.log('RC813_LIVE_MONEY_OPERATIONS=OFF');
JS

# This is a LIVE service guard, not an invocation of a LIVE payments API.
node --input-type=module <<'JS'
const url='http://127.0.0.1:18190/api/v1/health';
const r=await fetch(url,{signal:AbortSignal.timeout(4000)});
const h=await r.json();
if(!r.ok||h.production!==true||h.digital_payment_provider!=='stripe')
  throw Error('RC813_EXISTING_PRODUCTION_SERVICE_UNEXPECTED_STOP');
console.log('RC813_EXISTING_LIVE_PORT_18190_PRESENT=PASS');
JS

if [[ "$MODE" == '--prepare' ]]; then
  npm ci --no-audit --no-fund
  stage_node ./node_modules/prisma/build/index.js generate
  stage_node ./node_modules/prisma/build/index.js validate
  npm run build
  stage_node "$(readlink -f "$(command -v npm)")" test
  bash -n scripts/rc813-parallel-stage.sh
  node --check ecosystem.rc813-parallel.cjs
  echo 'RC813_COMPILED_AND_TESTED=PASS'
  echo 'RC813_PM2_LIVE_DB_UNCHANGED=YES'
  exit 0
fi

[[ -f dist/server.js && -f dist/worker.js &&
   -x node_modules/.bin/prisma ]] || {
 echo 'RC813_PREPARE_REQUIRED'; exit 1;
}

if [[ "$MODE" == '--plan' || "$MODE" == '--apply' ]]; then
  [[ ! -e "$STAGE_PM2_HOME" ]] || {
    echo 'RC813_PARALLEL_PM2_HOME_ALREADY_EXISTS_REVIEW'; exit 1;
  }
  [[ -z "$(ss -lntH | awk '$4 == "127.0.0.1:18192" {print $4}')" ]] || {
    echo 'RC813_STAGE_PORT_18192_IN_USE'; exit 1;
  }
  # This is NOT a permission to migrate. A divergent schema aborts the plan.
  stage_node ./node_modules/prisma/build/index.js migrate status || {
    echo 'RC813_STAGE_MIGRATIONS_HOLD_REVIEW'; exit 1;
  }
  stage_node --input-type=module - <<'JS'
import {Redis} from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:2000,
  maxRetriesPerRequest:1,retryStrategy:()=>null});
try{
  await r.connect();
  if(Number(await r.dbsize())!==0)throw Error('RC813_STAGE_REDIS_DB1_NOT_EMPTY');
  console.log('RC813_PRIVATE_REDIS_DB1_EMPTY=PASS');
}finally{r.disconnect();}
JS
  echo 'RC813_PLAN_NO_EXISTING_API_DB_PM2_MODIFICATION=PASS'
fi

if [[ "$MODE" == '--plan' ]]; then
  echo 'RC813_PARALLEL_STAGE_PLAN=PASS'
  exit 0
fi

if [[ "$MODE" == '--verify' ]]; then
  stage_node --input-type=module - <<'JS'
const b='http://127.0.0.1:18192/api/v1';
for(const [path,assert] of [
  ['/health',x=>x.production===false&&x.online_payment_writes===false],
  ['/ready',x=>x.ready===true&&x.workerOnline===true&&
     x.environment==='staging'&&x.financialWrites===false&&
     x.onlinePaymentsEnabled===false],
]){
  const response=await fetch(b+path,{signal:AbortSignal.timeout(5000)});
  const body=await response.json();
  if(response.status!==200||!assert(body))
    throw Error('RC813_STAGE_VERIFICATION_FAILED_'+path);
}
console.log('RC813_PARALLEL_STAGE_API_WORKER=PASS');
JS
  echo 'RC813_LIVE_18190_UNTOUCHED_AND_STAGE_18192_READY=PASS'
  exit 0
fi

[[ "$MODE" == '--apply' && "$APPROVAL" == 'I_APPROVE_RC813_PARALLEL_STAGE_ONLY' ]] || {
 echo 'RC813_EXPLICIT_PARALLEL_STAGE_APPROVAL_REQUIRED'; exit 2;
}
# No LIVE PM2_HOME reference; all commands use an isolated PM2 daemon.
export PM2_HOME="$STAGE_PM2_HOME"
export TALA_RC813_ENV_FILE="$ENV"
export NODE_ENV=staging
# PM2 must inherit NO user shell secrets/config, only the private env-file path.
# Prevent accidental NODE_ENV=production or inherited DATABASE_URL/Stripe keys.
stage_pm2(){
  env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage \
    PATH="$PATH" PM2_HOME="$STAGE_PM2_HOME" TALA_RC813_ENV_FILE="$ENV" \
    NODE_ENV=staging pm2 "$@"
}
ROLLOUT_STARTED=no
COMMITTED=no
cleanup(){
  result=$?
  trap - EXIT
  if [[ "$ROLLOUT_STARTED" == yes && "$COMMITTED" != yes ]]; then
    stage_pm2 delete tala-rc813-parallel-api >/dev/null 2>&1 || true
    stage_pm2 delete tala-rc813-parallel-worker >/dev/null 2>&1 || true
    stage_pm2 kill >/dev/null 2>&1 || true
    echo 'RC813_NEW_STAGE_ONLY_ROLLBACK=ATTEMPTED'
  fi
  exit "$result"
}
trap cleanup EXIT
ROLLOUT_STARTED=yes
stage_pm2 start "$ECO" --only tala-rc813-parallel-worker --update-env
# Fresh Redis DB1 had no keys before startup: heartbeat must be this worker.
STAGE_WORKER_ONLINE=no
for attempt in $(seq 1 25); do
  if stage_node --input-type=module - <<'JS' >/dev/null 2>&1
import {Redis} from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:1200,
 maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();if(await r.get('tala:node:stage:worker:heartbeat')!=='online')
 process.exitCode=1;}catch{process.exitCode=1;}finally{r.disconnect();}
JS
  then STAGE_WORKER_ONLINE=yes; break; fi
  sleep 2
done
[[ "$STAGE_WORKER_ONLINE" == yes ]] || { echo 'RC813_NEW_WORKER_HEARTBEAT_FAIL'; exit 1; }
stage_pm2 start "$ECO" --only tala-rc813-parallel-api --update-env
STAGE_READY=no
for attempt in $(seq 1 25); do
  if bash scripts/rc813-parallel-stage.sh --verify "$SHA" >/dev/null 2>&1; then
    STAGE_READY=yes
    break
  fi
  sleep 2
done
[[ "$STAGE_READY" == yes ]] || { echo 'RC813_NEW_STAGE_API_NOT_READY'; exit 1; }
stage_pm2 save
COMMITTED=yes
trap - EXIT
echo 'RC813_PARALLEL_STAGE_DEPLOYED=PASS'
echo 'RC813_NEW_LOCAL_ORIGIN=http://127.0.0.1:18192'
echo 'RC813_DEFAULT_PM2_LIVE_AND_CLOUDFLARED_UNTOUCHED=YES'
echo 'RC813_REBOOT_AUTOSTART=NOT_CONFIGURED'
