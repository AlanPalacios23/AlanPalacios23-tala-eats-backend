#!/usr/bin/env bash
# RC11.4: dedicated production PM2 cash-delivery cutover.
# Deploy RC11.4 PWA-capability + reconciliation AUDITOR code ONLY; all finance toggles OFF. No schema/Stripe/Redis config writes.
set -Eeuo pipefail
set +x
umask 077
MODE="${1:-}"; SHA="${2:-}"; OLD_EXPECTED="${3:-}"; TOKEN="${4:-}"
if [[ ! "$MODE" =~ ^--(plan|apply|verify|rollback)$ ||
      ! "$SHA" =~ ^[a-f0-9]{40}$ ]];then
 echo RC114_ABORT=INVALID_MODE_OR_SHA;exit 2
fi
case "$MODE" in
 --plan|--verify) [[ $# -eq 2 ]] || { echo RC114_ABORT=ARGUMENTS;exit 2; };;
 --apply)
   [[ $# -eq 4 && "$OLD_EXPECTED" =~ ^[a-f0-9]{40}$ &&
      "$TOKEN" == I_APPROVE_RC114_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY ]] ||
      { echo RC114_ABORT=APPLY_REQUIRES_OLD_SHA_AND_APPROVAL;exit 2; };;
 --rollback)
   [[ $# -eq 3 && "$OLD_EXPECTED" == I_APPROVE_RC114_ROLLBACK_PREVIOUS_TWO_PM2 ]] ||
      { echo RC114_ABORT=ROLLBACK_APPROVAL_REQUIRED;exit 2; };;
esac
[[ "$(id -un)" == tala-node-stage && "$(id -u)" != 0 &&
   "$HOME" == /home/tala-node-stage ]] ||
 { echo RC114_ABORT=SERVICE_USER_ONLY;exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for cmd in pm2 node git curl cmp python3;do
 command -v "$cmd" >/dev/null || { echo "RC114_ABORT=MISSING_TOOL_$cmd";exit 1; }
done
BASE="$HOME/tala-node-releases"
ROOT="$BASE/$SHA"
WORK="$ROOT/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
ECO="$WORK/rc813-live/ecosystem.config.cjs"
RECEIPT="$HOME/.config/rc114-cash-delivery-previous.json"
[[ -d "$WORK" && ! -L "$WORK" && ! -L "$ROOT" &&
  -s "$WORK/dist/server.js" && -s "$WORK/dist/live/production-worker.js" &&
  -s "$ECO" &&
  "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
  -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" &&
  -f "$ENV" && ! -L "$ENV" &&
  "$(stat -c '%a' "$ENV")" == 600 &&
  "$(stat -c '%u' "$ENV")" == "$(id -u)" ]] ||
 { echo RC114_ABORT=PINNED_RELEASE_OR_LIVE_ENV;exit 1; }
cd "$WORK"
pm(){ env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
 NODE_ENV=production PM2_HOME="$HOME/.pm2" TALA_LIVE_ENV_FILE="$ENV" pm2 "$@"; }
# Identity parser rejects stray PM2 processes, mixed releases, wrong scripts.
pm_identity(){
 pm jlist | node --input-type=commonjs -e '
 let src="";process.stdin.on("data",s=>src+=s);
 process.stdin.on("end",()=>{
  try{
   const apps=JSON.parse(src), expected={
    "tala-node-stage-api":"dist/server.js",
    "tala-node-stage-worker":"dist/live/production-worker.js"
   };
   if(apps.length!==2)throw Error("PROCESS_COUNT");
   const cwd=apps[0]?.pm2_env?.pm_cwd;
   if(typeof cwd!=="string"||
      !/^\/home\/tala-node-stage\/tala-node-releases\/[a-f0-9]{40}\/node-backend$/.test(cwd))
     throw Error("CWD");
   for(const [name,script] of Object.entries(expected)){
    const matching=apps.filter(p=>p.name===name);
    if(matching.length!==1||matching[0].pm2_env?.status!=="online"||
       matching[0].pm2_env?.pm_cwd!==cwd||
       matching[0].pm2_env?.pm_exec_path!==cwd+"/"+script)
     throw Error("PROCESS_IDENTITY:"+name);
   }
   console.log(cwd);
  }catch(err){console.error("RC114_ABORT=PM2_IDENTITY_MISMATCH");process.exitCode=1;}
 });'
}
# No direct payment changes; check live flags by loading the actual production config.
financial_flags(){
 node --env-file="$ENV" --input-type=module <<'JS'
import {config} from './dist/config.js';
if(config.NODE_ENV!=='production'||config.PORT!==18190||
  config.LIVE_DRIVER_PRESENCE_ENABLED!=='true'||
  config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
  config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false'||
  ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
   'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
   'STRIPE_MANUAL_SETTLEMENT_APPROVED'].some(k=>config[k]!=='true')||
  ['LIVE_DELIVERY_DISPATCH_ENABLED','LIVE_DELIVERY_CARD_CHECKOUT_ENABLED',
   'LIVE_DELIVERY_RELEASE_APPROVED','STAGE_DRIVER_DELIVERY_ENABLED',
   'STAGE_DELIVERY_CASH_CHECKOUT_ENABLED',
   'STAGE_DELIVERY_STRIPE_TEST_ENABLED',
   // First deploy code with the LIVE cash admission gate still OFF.
   // A separate explicit launch approval will enable it after E2E checks.
   'LIVE_DELIVERY_CASH_CHECKOUT_ENABLED','LIVE_DELIVERY_CASH_DISPATCH_ENABLED',
   'LIVE_DELIVERY_CASH_RELEASE_APPROVED'].some(k=>config[k]!=='false'))
  throw Error('RC114_ABORT=FINANCIAL_OR_DELIVERY_FLAGS_CHANGED');
console.log('RC114_LIVE_FINANCIAL_AND_DELIVERY_GUARDS=PASS');
JS
}
ready(){
 node --input-type=module <<'JS'
for(const host of ['http://127.0.0.1:18190',
                   'https://talaeats.alan-palacios-dev.com']){
 const response=await fetch(host+'/api/v1/ready',{signal:AbortSignal.timeout(9000)});
 if(!response.ok)throw Error('RC114_READY_HTTP');
 const j=await response.json();
 if(j.ready!==true||j.workerOnline!==true||j.environment!=='production'||
    j.financialWrites!==true||j.onlinePaymentsEnabled!==true)
  throw Error('RC114_READY_LIVE_MISMATCH');
}
console.log('RC114_LOCAL_PUBLIC_FINANCE_READY=PASS');
JS
}
capabilities(){
 node --input-type=module <<'JS'
for(const host of ['http://127.0.0.1:18190',
                   'https://talaeats.alan-palacios-dev.com',
                   'https://repartidores-talaeats.alan-palacios-dev.com']){
 const base=host+'/api/v1';
 const r=await fetch(base+'/operations/onboarding-capabilities',{
   signal:AbortSignal.timeout(9000),headers:{'Cache-Control':'no-cache'}});
 if(r.status!==200)throw Error('RC114_CAPABILITY_HTTP_'+r.status);
 const j=await r.json();
 if(j.driver_plate_supported!==true||
    j.driver_documents_supported!==true||
    j.driver_admin_approval_required!==true)
  throw Error('RC114_CAPABILITIES_INCOMPLETE');
}
for(const url of [
 'http://127.0.0.1:18190/api/v1/operations/onboarding/mine',
 'http://127.0.0.1:18190/api/v1/operations/admin/onboarding',
 'https://repartidores-talaeats.alan-palacios-dev.com/api/v1/operations/onboarding/mine'
]){
 const r=await fetch(url,{signal:AbortSignal.timeout(9000)});
 if(![401,403].includes(r.status))throw Error('RC114_ANONYMOUS_AUTH_GATE_'+r.status);
}
console.log('RC114_LIVE_DRIVER_SIGNUP_CAPABILITIES=PASS_THREE_ORIGINS');
console.log('RC114_ANONYMOUS_ONBOARDING_READS=BLOCKED');
JS
}
# DB migration verify is read-only and must be completed before PM2 switching.
schema(){
 RC110_SHA="$SHA" node --env-file="$ENV" \
 scripts/rc110-kali-live-driver-plate-migration.mjs --verify
}
# Manual rollback must be possible even when the new API or worker is DOWN.
# Do not require postdeploy readiness to rescue an unhealthy release.
if [[ "$MODE" == --rollback ]];then
 [[ -f "$RECEIPT" && ! -L "$RECEIPT" &&
    "$(stat -c '%a' "$RECEIPT")" == 600 &&
    "$(stat -c '%u' "$RECEIPT")" == "$(id -u)" ]] ||
 { echo RC114_ABORT=NO_VERIFIED_ROLLBACK_RECEIPT;exit 1; }
 ROLLBACK_CWD="$(node -e 'const r=require(process.argv[1]);if(r.sha!==process.argv[2])process.exit(2);process.stdout.write(r.previousCwd)' "$RECEIPT" "$SHA")"
 [[ "$ROLLBACK_CWD" =~ ^/home/tala-node-stage/tala-node-releases/[a-f0-9]{40}/node-backend$ &&
    -s "$ROLLBACK_CWD/rc813-live/ecosystem.config.cjs" ]] ||
 { echo RC114_ABORT=PREVIOUS_RELEASE_NOT_SAFE;exit 1; }
 cmp -s "$ROLLBACK_CWD/rc813-live/ecosystem.config.cjs" "$ECO" ||
 { echo RC114_ABORT=UNSAFE_ROLLBACK_TOPOLOGY;exit 1; }
 export RC114_TARGET_CWD="$WORK"
 pm jlist | node --input-type=commonjs -e '
 let src="";process.stdin.on("data",s=>src+=s);
 process.stdin.on("end",()=>{
  try{
   const items=JSON.parse(src),allow=["tala-node-stage-api","tala-node-stage-worker"];
   if(items.length>2||items.some(p=>!allow.includes(p.name)||
    p.pm2_env?.pm_cwd!==process.env.RC114_TARGET_CWD))
    throw Error("FOREIGN_PROCESS");
  }catch{console.error("RC114_ABORT=UNSAFE_PM2_ROLLBACK_STATE");process.exitCode=1;}
 });'
 financial_flags
 pm delete tala-node-stage-api >/dev/null 2>&1 || true
 pm delete tala-node-stage-worker >/dev/null 2>&1 || true
 pm start "$ROLLBACK_CWD/rc813-live/ecosystem.config.cjs" --only tala-node-stage-worker --update-env >/dev/null
 pm start "$ROLLBACK_CWD/rc813-live/ecosystem.config.cjs" --only tala-node-stage-api --update-env >/dev/null
 pm save >/dev/null
 [[ "$(pm_identity)" == "$ROLLBACK_CWD" ]] && ready
 echo RC114_MANUAL_ROLLBACK=PASS
 echo RC114_MANUAL_ROLLBACK_SCHEMA_COLUMN=RETAINED
 exit 0
fi
old="$(pm_identity)"
old_sha="${old%/node-backend}";old_sha="${old_sha##*/}"
OLD_ECO="$old/rc813-live/ecosystem.config.cjs"
[[ -s "$OLD_ECO" ]] || { echo RC114_ABORT=OLD_ECOSYSTEM_MISSING;exit 1; }
cmp -s "$OLD_ECO" "$ECO" ||
 { echo RC114_ABORT=PM2_ECOSYSTEM_TOPOLOGY_DIFF;exit 1; }
financial_flags
schema
ready
if [[ "$MODE" == --plan ]];then
 echo "RC114_CURRENT_LIVE_SHA=$old_sha"
 echo "RC114_TARGET_SHA=$SHA"
 echo 'RC114_PLAN=PASS_READ_ONLY'
 echo 'RC114_PM2_DATABASE_STRIPE=UNCHANGED'
 exit 0
fi
if [[ "$MODE" == --verify ]];then
 [[ "$old_sha" == "$SHA" ]] || { echo RC114_ABORT=WRONG_ACTIVE_SHA;exit 1; }
 capabilities
 echo 'RC114_LIVE_CASH_DELIVERY_CODE_VERIFY=PASS'
 echo 'RC114_CASH_CARD_DISPATCH_PAYOUTS=LOCKED_PENDING_RELEASE'
 exit 0
fi
[[ "$old_sha" == "$OLD_EXPECTED" && "$old_sha" != "$SHA" ]] ||
 { echo RC114_ABORT=BASELINE_SHA_CHANGED;exit 1; }
[[ ! -e "$RECEIPT" && ! -L "$RECEIPT" ]] ||
 { echo RC114_ABORT=PREVIOUS_ROLLBACK_RECEIPT_EXISTS;exit 1; }
printf '{"sha":"%s","previousCwd":"%s"}\n' "$SHA" "$old" > "$RECEIPT"
chmod 600 "$RECEIPT"
SWITCHED=no;DONE=no
restore_on_error(){
 local code=$?
 trap - EXIT
 if [[ "$DONE" != yes && "$SWITCHED" == yes ]];then
  echo RC114_AUTOMATIC_ROLLBACK=START
  pm delete tala-node-stage-api >/dev/null 2>&1 || true
  pm delete tala-node-stage-worker >/dev/null 2>&1 || true
  pm start "$OLD_ECO" --only tala-node-stage-worker --update-env >/dev/null 2>&1 || true
  pm start "$OLD_ECO" --only tala-node-stage-api --update-env >/dev/null 2>&1 || true
  pm save >/dev/null 2>&1 || true
  echo RC114_AUTOMATIC_ROLLBACK=ATTEMPTED_VERIFY_MANUALLY
 fi
 if [[ "$DONE" != yes && "$SWITCHED" == no ]];then
  rm -f -- "$RECEIPT"
 fi
 exit "$code"
}
trap restore_on_error EXIT
SWITCHED=yes
pm delete tala-node-stage-api >/dev/null
pm delete tala-node-stage-worker >/dev/null
# Discard ONLY the live worker heartbeat so an old worker cannot be mistaken
# for the new one; Redis remains online with all other keys intact.
node --env-file="$ENV" --input-type=module <<'JS'
import Redis from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:2000,
 maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();await r.del('tala:node:live:worker:heartbeat');}
finally{r.disconnect();}
JS
pm start "$ECO" --only tala-node-stage-worker --update-env >/dev/null
worker_alive=no
for i in $(seq 1 25);do
 if node --env-file="$ENV" --input-type=module <<'JS' >/dev/null 2>&1
import Redis from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:1000,
 maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();if(await r.get('tala:node:live:worker:heartbeat')!=='online')
 process.exitCode=1;}
catch{process.exitCode=1}finally{r.disconnect();}
JS
 then worker_alive=yes;break;fi
 sleep 2
done
[[ "$worker_alive" == yes ]] || { echo RC114_ABORT=WORKER_NO_HEARTBEAT;exit 1; }
pm start "$ECO" --only tala-node-stage-api --update-env >/dev/null
healthy=no
for i in $(seq 1 20);do
 if [[ "$(pm_identity 2>/dev/null)" == "$WORK" ]] &&
    ready >/dev/null 2>&1 && capabilities >/dev/null 2>&1;then
   healthy=yes;break
 fi
 sleep 2
done
[[ "$healthy" == yes ]] || { echo RC114_ABORT=API_CAPABILITY_OR_FINANCE_NOT_READY;exit 1; }
pm save >/dev/null
DONE=yes
trap - EXIT
echo RC114_LIVE_CASH_DELIVERY_CODE_DEPLOY=PASS
echo RC114_NEW_LIVE_SHA="$SHA"
echo RC114_PREVIOUS_RELEASE="$old"
echo RC114_STRIPE_DB_PWA=UNCHANGED
echo RC114_CASH_CARD_DISPATCH_PAYOUTS=LOCKED_PENDING_RELEASE
