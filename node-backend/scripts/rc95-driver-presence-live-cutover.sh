#!/usr/bin/env bash
# RC95 presence-only PM2 switch. Money and delivery checkout are untouched.
set -Eeuo pipefail
set +x
umask 077
MODE="$1"
APPROVAL=""
if (( $# == 2 ));then APPROVAL="$2";fi
if (( $# < 1 || $# > 2 )) ||
   [[ ! "$MODE" =~ ^--(plan|apply|verify|rollback)$ ]] ||
   { [[ "$MODE" == --apply ]] && [[ "$APPROVAL" != I_APPROVE_RC95_DRIVER_PRESENCE_ONLY ]]; } ||
   { [[ "$MODE" == --rollback ]] && [[ "$APPROVAL" != I_APPROVE_RC95_RESTORE_RC94 ]]; } ||
   { [[ "$MODE" != --apply && "$MODE" != --rollback ]] && (( $# != 1 )); };then
 echo RC95_CUTOVER_ABORT=USAGE_OR_APPROVAL;exit 2
fi
[[ "$(id -un)" == tala-node-stage && "$HOME" == /home/tala-node-stage ]] ||
 { echo RC95_CUTOVER_ABORT=SERVICE_USER_ONLY;exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
BASE=0c8d92fa62ae910843b3d4c764da85a852b17085
TARGET=c59c3e5528009580139dad9913f745badc1e7098
OLD="$HOME/tala-node-releases/$BASE/node-backend"
NEW="$HOME/tala-node-releases/$TARGET/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
BACKUP="$HOME/.config/rc95-live-env-before-presence.bak"
OLD_ECO="$OLD/rc813-live/ecosystem.config.cjs"
NEW_ECO="$NEW/rc813-live/ecosystem.config.cjs"
[[ -d "$OLD" && -d "$NEW" && ! -L "$NEW" && ! -L "$OLD" &&
   "$(git -C "$HOME/tala-node-releases/$TARGET" rev-parse HEAD)" == "$TARGET" &&
   -z "$(git -C "$HOME/tala-node-releases/$TARGET" status --porcelain --untracked-files=no)" &&
   -f "$NEW/dist/server.js" && -f "$NEW/dist/live/production-worker.js" &&
   -f "$NEW/dist/marketplace/delivery-runtime.js" &&
   -f "$ENV" && ! -L "$ENV" &&
   "$(stat -c %a "$ENV")" == 600 &&
   "$(stat -c %u "$ENV")" == "$(id -u)" ]] ||
 { echo RC95_CUTOVER_ABORT=PINNED_RELEASE_OR_PRIVATE_ENV;exit 1; }
cmp -s "$OLD_ECO" "$NEW_ECO" ||
 { echo RC95_CUTOVER_ABORT=PM2_CONFIG_DIFF;exit 1; }
diff -qr "$OLD/prisma/migrations" "$NEW/prisma/migrations" >/dev/null ||
 { echo RC95_CUTOVER_ABORT=DB_MIGRATIONS_DIFF;exit 1; }
pm(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
 NODE_ENV=production PM2_HOME="$HOME/.pm2" TALA_LIVE_ENV_FILE="$ENV" pm2 "$@"
}
pm_check(){
 export EXPECTED_PM2_DIR="$1"
 pm jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
try{const v=JSON.parse(s),p={"tala-node-stage-api":"dist/server.js","tala-node-stage-worker":"dist/live/production-worker.js"};
if(v.length!==2)throw Error("COUNT");
for(const [name,rel] of Object.entries(p)){const a=v.filter(x=>x.name===name);
if(a.length!==1||a[0].pm2_env.status!=="online"||a[0].pm2_env.pm_cwd!==process.env.EXPECTED_PM2_DIR||a[0].pm2_env.pm_exec_path!==process.env.EXPECTED_PM2_DIR+"/"+rel)throw Error("PROCESS");}
console.log("RC95_PM2_IDENTITY=PASS");
}catch{console.log("RC95_PM2_IDENTITY=FAIL");process.exitCode=1;}
});'
}
ready(){
 node --input-type=module <<'JS'
for(const [name,url] of [['LOCAL','http://127.0.0.1:18190/api/v1/ready'],['PUBLIC','https://talaeats.alan-palacios-dev.com/api/v1/ready']]){
 const res=await fetch(url,{signal:AbortSignal.timeout(10000)});
 if(!res.ok)throw Error('READY_HTTP_'+name);
 const j=await res.json();
 if(j.ready!==true||j.workerOnline!==true||j.environment!=='production'||j.onlinePaymentsEnabled!==true||j.financialWrites!==true)
 throw Error('READY_FINANCE_MISMATCH_'+name);
 console.log('RC95_'+name+'_READY_PAYMENTS=PASS');
}
JS
}
flag_check(){
 cd "$NEW"
 node --env-file="$ENV" --input-type=module <<'JS'
import {config} from './dist/config.js';
if(config.NODE_ENV!=='production'||config.PORT!==18190||
  config.LIVE_DRIVER_PRESENCE_ENABLED!=='true'||
  config.LIVE_AUTH_EMAIL_DELIVERY_MODE!=='resend'||
  ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
   'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
   'STRIPE_MANUAL_SETTLEMENT_APPROVED'].some(k=>config[k]!=='true')||
  ['STRIPE_CONNECT_TRANSFERS_ENABLED','TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED',
   'STAGE_DRIVER_DELIVERY_ENABLED','STAGE_DELIVERY_CASH_CHECKOUT_ENABLED',
   'STAGE_DELIVERY_STRIPE_TEST_ENABLED'].some(k=>config[k]!=='false'))
  throw Error('RC95_FINANCIAL_FLAGS_NOT_PRESERVED');
console.log('RC95_PRESENCE_ONLY_AND_STRIPE_GUARDS=PASS');
JS
}
if [[ "$MODE" == --plan ]];then
 pm_check "$OLD";ready
 [[ ! -e "$BACKUP" ]] || { echo RC95_CUTOVER_ABORT=BACKUP_ALREADY_EXISTS;exit 1; }
 echo RC95_PLAN=PASS_READ_ONLY
 echo RC95_CURRENT_RELEASE="$BASE"
 echo RC95_TARGET_RELEASE="$TARGET"
 echo RC95_PAYMENTS_AND_MAIL=UNCHANGED
 exit 0
fi
if [[ "$MODE" == --verify ]];then
 pm_check "$NEW";ready;flag_check
 code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://talaeats.alan-palacios-dev.com/api/v1/driver/presence-readiness)"
 [[ "$code" == 401 || "$code" == 403 ]] ||
 { echo RC95_CUTOVER_ABORT=DRIVER_AUTH_GATE;exit 1; }
 echo RC95_UNAUTHENTICATED_DRIVER_READINESS=BLOCKED
 echo RC95_LIVE_DRIVER_PRESENCE=ENABLED
 echo RC95_LIVE_DELIVERY_AND_CARD=LOCKED
 exit 0
fi
if [[ "$MODE" == --rollback ]];then
 pm_check "$NEW"
 [[ -f "$BACKUP" && ! -L "$BACKUP" &&
    "$(stat -c %a "$BACKUP")" == 600 &&
    "$(stat -c %u "$BACKUP")" == "$(id -u)" ]] ||
    { echo RC95_ROLLBACK_ABORT=PRIVATE_BACKUP_NOT_FOUND;exit 1; }
 cp -p "$BACKUP" "$ENV"
 pm delete tala-node-stage-api >/dev/null
 pm delete tala-node-stage-worker >/dev/null
 pm start "$OLD_ECO" --only tala-node-stage-worker --update-env >/dev/null
 pm start "$OLD_ECO" --only tala-node-stage-api --update-env >/dev/null
 pm save >/dev/null
 pm_check "$OLD";ready
 echo RC95_MANUAL_ROLLBACK_TO_RC94=PASS
 exit 0
fi
pm_check "$OLD";ready
[[ ! -e "$BACKUP" ]] || { echo RC95_CUTOVER_ABORT=BACKUP_ALREADY_EXISTS;exit 1; }
cp -p "$ENV" "$BACKUP"
[[ ! -L "$BACKUP" && "$(stat -c %a "$BACKUP")" == 600 ]] ||
 { echo RC95_CUTOVER_ABORT=BACKUP_PERMISSIONS;exit 1; }
FINISHED=no
CHANGED=no
cleanup(){
 local result=$?
 trap - EXIT
 if [[ "$FINISHED" != yes && "$CHANGED" == yes ]];then
  echo RC95_AUTOMATIC_ROLLBACK=START
  cp -p "$BACKUP" "$ENV" || true
  pm delete tala-node-stage-api >/dev/null 2>&1 || true
  pm delete tala-node-stage-worker >/dev/null 2>&1 || true
  pm start "$OLD_ECO" --only tala-node-stage-worker --update-env >/dev/null 2>&1 || true
  pm start "$OLD_ECO" --only tala-node-stage-api --update-env >/dev/null 2>&1 || true
  pm save >/dev/null 2>&1 || true
  echo RC95_AUTOMATIC_ROLLBACK=ATTEMPTED_VERIFY_READY
 fi
 exit "$result"
}
trap cleanup EXIT
CHANGED=yes
export PRIVATE_LIVE_ENV="$ENV"
node <<'JS'
const fs=require('node:fs'),path=require('node:path');
const file=process.env.PRIVATE_LIVE_ENV,text=fs.readFileSync(file,'utf8');
const matches=[...text.matchAll(/^[ \t]*LIVE_DRIVER_PRESENCE_ENABLED[ \t]*=/gm)];
if(matches.length>1)throw Error('DUPLICATE_LIVE_PRESENCE');
if(matches.length===1&&!/^[ \t]*LIVE_DRIVER_PRESENCE_ENABLED[ \t]*=[ \t]*false[ \t]*$/m.test(text))
 throw Error('PRESENCE_MUST_BE_FALSE_BEFORE_ACTIVATION');
const updated=matches.length?text.replace(/^[ \t]*LIVE_DRIVER_PRESENCE_ENABLED[ \t]*=[ \t]*false[ \t]*$/m,'LIVE_DRIVER_PRESENCE_ENABLED=true'):
text.replace(/\s*$/,'')+'\nLIVE_DRIVER_PRESENCE_ENABLED=true\n';
const tmp=path.join(path.dirname(file),'.rc95-private-next-'+process.pid);
const fd=fs.openSync(tmp,'wx',0o600);
try{fs.writeFileSync(fd,updated);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
fs.renameSync(tmp,file);
console.log('RC95_DRIVER_PRESENCE_PRIVATE_FLAG=UPDATED');
JS
flag_check
# Existing worker heartbeat must not masquerade as a new worker.
cd "$NEW"
node --env-file="$ENV" --input-type=module <<'JS'
import Redis from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();await r.del('tala:node:live:worker:heartbeat');}
finally{r.disconnect()}
JS
pm delete tala-node-stage-api >/dev/null
pm delete tala-node-stage-worker >/dev/null
pm start "$NEW_ECO" --only tala-node-stage-worker --update-env >/dev/null
alive=no
for n in $(seq 1 25);do
 if node --env-file="$ENV" --input-type=module <<'JS' >/dev/null 2>&1
import Redis from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:1000,maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();if(await r.get('tala:node:live:worker:heartbeat')!=='online')process.exitCode=1;}
catch{process.exitCode=1}finally{r.disconnect()}
JS
 then alive=yes;break;fi
 sleep 2
done
[[ "$alive" == yes ]] || { echo RC95_CUTOVER_ABORT=NEW_WORKER_NOT_READY;exit 1; }
pm start "$NEW_ECO" --only tala-node-stage-api --update-env >/dev/null
healthy=no
for n in $(seq 1 20);do
 if pm_check "$NEW" >/dev/null 2>&1 && ready >/dev/null 2>&1;then healthy=yes;break;fi
 sleep 2
done
[[ "$healthy" == yes ]] || { echo RC95_CUTOVER_ABORT=NEW_API_NOT_READY;exit 1; }
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://talaeats.alan-palacios-dev.com/api/v1/driver/presence-readiness)"
[[ "$code" == 401 || "$code" == 403 ]] ||
 { echo RC95_CUTOVER_ABORT=DRIVER_ENDPOINT_NOT_AUTHENTICATED;exit 1; }
pm save >/dev/null
FINISHED=yes
trap - EXIT
echo RC95_LIVE_DRIVER_PRESENCE_DEPLOYED=PASS
echo RC95_PREVIOUS_RC94_BACKUP=AVAILABLE
echo RC95_EXISTING_STRIPE_LIVE_PICKUP=PRESERVED
echo RC95_LIVE_DELIVERY_CHECKOUT=LOCKED
echo RC95_LIVE_DELIVERY_CARD=LOCKED
echo RC95_CONNECT_PAYOUTS=LOCKED
