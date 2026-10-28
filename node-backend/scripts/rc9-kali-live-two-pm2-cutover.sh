#!/usr/bin/env bash
# RC9 existing public LIVE PM2 API + worker cutover. No Stripe Connect transfers.
# --plan = read-only. --apply = explicitly approved, preserves old binary for rollback.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"; SHA="${2:-}"; APPROVAL="${3:-}"
if [[ ! "$MODE" =~ ^--(plan|apply|verify)$ || ! "$SHA" =~ ^[a-f0-9]{40}$ ||
 ( "$MODE" == --apply && ( "$#" != 3 ||
 "$APPROVAL" != I_APPROVE_RC9_EXISTING_LIVE_TWO_PM2_CUTOVER ) ) ||
 ( "$MODE" != --apply && "$#" != 2 ) ]];then
 echo 'RC9_CUTOVER_ABORT=MODE_SHA_OR_APPROVAL';exit 2
fi
[[ "$(id -un)" == tala-node-stage && "$(id -u)" != 0 &&
 "$HOME" == /home/tala-node-stage ]] || {
 echo 'RC9_CUTOVER_ABORT=SERVICE_USER_ONLY';exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
OLD_SHA='09ee09c8364382597c8e9ab1573a5b417884d47e'
TARGET_SHA='561c842c583940f5b01f650c8dbe3c26a770d85f'
[[ "$SHA" == "$TARGET_SHA" ]] || {
 echo 'RC9_CUTOVER_ABORT=TARGET_SHA_NOT_REVIEWED';exit 1;
}
ROOT="$HOME/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
OLD="$HOME/tala-node-releases/$OLD_SHA/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
NEW_ECO="$WORK/rc813-live/ecosystem.config.cjs"
OLD_ECO="$OLD/rc813-live/ecosystem.config.cjs"
[[ -d "$WORK" && -d "$OLD" && ! -L "$ROOT" && ! -L "$WORK" &&
 "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" &&
 "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
 -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" &&
 -f "$NEW_ECO" && -f "$OLD_ECO" &&
 -f "$ENV" && ! -L "$ENV" && "$(stat -c %a "$ENV")" == 600 &&
 "$(stat -c %u "$ENV")" == "$(id -u)" &&
 -f "$WORK/dist/server.js" &&
 -f "$WORK/dist/live/production-worker.js" ]] || {
 echo 'RC9_CUTOVER_ABORT=RELEASE_OR_ENV_NOT_LOCKED';exit 1;
}
cd "$WORK"
live_pm2(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
 NODE_ENV=production PM2_HOME="$HOME/.pm2" TALA_LIVE_ENV_FILE="$ENV" pm2 "$@"
}
pm2_identity(){
 local dir="$1"
 export RC9_EXPECTED_PM2_DIR="$dir"
 live_pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{
 const p=JSON.parse(s),want={
 "tala-node-stage-api":"dist/server.js",
 "tala-node-stage-worker":"dist/live/production-worker.js"};
 if(p.length!==2)throw Error("COUNT");
 for(const [name,path] of Object.entries(want)){
  const a=p.filter(x=>x.name===name);
  if(a.length!==1||a[0].pm2_env?.status!=="online"||
   a[0].pm2_env.pm_cwd!==process.env.RC9_EXPECTED_PM2_DIR||
   a[0].pm2_env.pm_exec_path!==process.env.RC9_EXPECTED_PM2_DIR+"/"+path)
   throw Error("PROCESS_IDENTITY");
 }
 console.log("RC9_TWO_PM2_ATTESTED=PASS");
 }catch{process.exitCode=1}
});'
}
ready(){
 node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
const roots=['http://127.0.0.1:18190','https://talaeats.alan-palacios-dev.com'];
for(const base of roots){
 const raw=execFileSync('curl',['-fsS','--max-time','10',base+'/api/v1/ready'],
  {encoding:'utf8',timeout:12500});
 const r=JSON.parse(raw);
 if(r.ready!==true||r.workerOnline!==true||
  r.environment!=='production'||r.financialWrites!==true||
  r.onlinePaymentsEnabled!==true)throw Error('RC9_LIVE_READY_FAILED');
}
console.log('RC9_LIVE_LOCAL_AND_PUBLIC_PAYMENTS=PASS');
JS
}
# No direct access to bank/Stripe write operations; verify code lock and schema.
node scripts/rc9-treasury-live-preflight.mjs >/dev/null
bash scripts/rc9-kali-live-treasury-migration.sh --verify "$SHA"
if [[ "$MODE" == --verify ]];then
 pm2_identity "$WORK"
 ready
 echo 'RC9_TWO_PM2_LIVE=PASS'
 echo 'RC9_CONNECT_PAYOUTS=OFF'
 exit 0
fi
pm2_identity "$OLD"
ready
if [[ "$MODE" == --plan ]];then
 echo 'RC9_CUTOVER_PLAN=PASS_READ_ONLY'
 echo 'RC9_CURRENT_LIVE_SHA='"$OLD_SHA"
 echo 'RC9_NEW_LIVE_SHA='"$SHA"
 exit 0
fi
# No automatic transfer/payout release; preserve buyer Stripe LIVE config.
node --env-file="$ENV" --input-type=module <<'JS'
import {config} from './dist/config.js';
if(config.NODE_ENV!=='production'||config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
 config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false'||
 ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
 'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_MANUAL_SETTLEMENT_APPROVED'].some(k=>config[k]!=='true'))
 throw Error('RC9_CUTOVER_ABORT=PAYMENT_CONFIG_DIFFERS');
console.log('RC9_STRIPE_EXISTING_LIVE_CONFIG_PRESERVED=PASS');
JS
STARTED=no; DEPLOYED=no
rollback(){
 local code=$?
 trap - EXIT
 if [[ "$STARTED" == yes && "$DEPLOYED" != yes ]];then
  echo 'RC9_CUTOVER_ROLLBACK=START'
  live_pm2 delete tala-node-stage-api >/dev/null 2>&1 || true
  live_pm2 delete tala-node-stage-worker >/dev/null 2>&1 || true
  live_pm2 start "$OLD_ECO" --only tala-node-stage-worker --update-env >/dev/null || true
  live_pm2 start "$OLD_ECO" --only tala-node-stage-api --update-env >/dev/null || true
  live_pm2 save >/dev/null 2>&1 || true
  echo 'RC9_CUTOVER_ROLLBACK=ATTEMPTED_CHECK_API_AND_ORDERS'
 fi
 exit "$code"
}
trap rollback EXIT
STARTED=yes
# Brief maintenance interruption: stop API first to stop taking new payments.
live_pm2 delete tala-node-stage-api
live_pm2 delete tala-node-stage-worker
# Invalidate stale worker heartbeat to prove the new finance worker is alive.
node --env-file="$ENV" --input-type=module <<'JS'
import Redis from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,
 connectTimeout:2000,maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();await r.del('tala:node:live:worker:heartbeat')}
finally{r.disconnect()}
JS
live_pm2 start "$NEW_ECO" --only tala-node-stage-worker --update-env
HEALTHY=no
for i in $(seq 1 25);do
 if node --env-file="$ENV" --input-type=module <<'JS' >/dev/null 2>&1
import Redis from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,
 connectTimeout:1000,maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();if(await r.get('tala:node:live:worker:heartbeat')!=='online')process.exitCode=1}
catch{process.exitCode=1}finally{r.disconnect()}
JS
 then HEALTHY=yes;break;fi
 sleep 2
done
[[ "$HEALTHY" == yes ]] || { echo 'RC9_CUTOVER_ABORT=NEW_WORKER_NO_HEARTBEAT';exit 1; }
live_pm2 start "$NEW_ECO" --only tala-node-stage-api --update-env
HEALTHY=no
for i in $(seq 1 20);do
 if pm2_identity "$WORK" >/dev/null 2>&1 && ready >/dev/null 2>&1;then
 HEALTHY=yes;break;fi
 sleep 2
done
[[ "$HEALTHY" == yes ]] || { echo 'RC9_CUTOVER_ABORT=NEW_API_OR_STRIPE_READY';exit 1; }
live_pm2 save
DEPLOYED=yes
trap - EXIT
echo 'RC9_LIVE_TWO_PM2_DEPLOYED=PASS'
echo 'RC9_LIVE_ACTIVE_SHA='"$SHA"
echo 'RC9_LIVE_STRIPE_PAYMENTS=PRESERVED'
echo 'RC9_CONNECT_WITHDRAWALS=STILL_LOCKED'
