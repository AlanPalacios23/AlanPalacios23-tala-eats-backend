#!/usr/bin/env bash
# Tala Eats RC8.6: opt-in REAL Stripe LIVE charges on the EXISTING two PM2 apps.
# No Docker, no new endpoint/server, no automatic Connect transfers.
# Seller-owned Connect authorization is enforced by application code.
set -Eeuo pipefail
set +x
umask 077
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
if [[ $# -ne 3 || ( "$1" != "--plan" && "$1" != "--apply" ) ||
      ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
 echo "USAGE: --plan|--apply FULL_SHA I_AUTHORIZE_STRIPE_LIVE_CHARGES"
 exit 2
fi
ACTION="$1"; SHA="$2"; APPROVAL="$3"
if [[ "$(id -un)" != "tala-node-stage" ||
      "$HOME" != "/home/tala-node-stage" ]]; then
 echo "ABORT_SERVICE_USER_REQUIRED";exit 1
fi
APP="$HOME/tala-node-releases/$SHA/node-backend"
ROOT="$HOME/tala-node-releases/$SHA"
LIVE="$HOME/.config/talaeats-node-live.env"
STAGE="$HOME/.config/talaeats-node-staging.env"
if [[ ! -d "$APP" || -L "$APP" || -L "$ROOT" ||
      "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" != "$SHA" ||
      -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ||
      ! -f "$APP/dist/server.js" ||
      ! -f "$APP/dist/live/production-worker.js" ]]; then
 echo "ABORT_UNVERIFIED_COMPILED_SHA";exit 1
fi
for f in "$LIVE" "$STAGE"; do
 if [[ ! -f "$f" || -L "$f" ||
       "$(stat -c '%a' "$f")" != 600 ||
       "$(stat -c '%u' "$f")" != "$(id -u)" ]]; then
  echo "ABORT_PRIVATE_ENV_FILE";exit 1
 fi
done
cd "$APP"
# Fail closed unless the LIVE env has ALL finance flags false, and no
# automatic merchant/driver transfer permission.
node --env-file="$LIVE" --input-type=module <<'JS'
import {config} from './dist/config.js';
import {validateLiveStandbySettings} from './dist/live/guard.js';
const keys=['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
 'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_MANUAL_SETTLEMENT_APPROVED','STRIPE_CONNECT_TRANSFERS_ENABLED'];
if(config.NODE_ENV!=='production'||config.PORT!==18190||
 keys.some(k=>config[k]!=='false'))process.exit(1);
validateLiveStandbySettings({
 nodeEnv:config.NODE_ENV,explicitlyEnabled:config.STRIPE_LIVE_ENABLED,
 readinessApproved:config.STRIPE_LIVE_RELEASE_APPROVED,
 key:config.STRIPE_SECRET_KEY,publishableKey:config.STRIPE_PUBLISHABLE_KEY,
 webhookSecret:config.STRIPE_WEBHOOK_SECRET,
 databaseUrl:config.DATABASE_URL,redisUrl:config.REDIS_URL,
 refundsEnabled:config.STRIPE_REFUNDS_ENABLED,
 transfersEnabled:config.STRIPE_CONNECT_TRANSFERS_ENABLED,
 manualSettlementApproved:config.STRIPE_MANUAL_SETTLEMENT_APPROVED,
 maxOrderMinor:String(config.STRIPE_LIVE_MAX_ORDER_MINOR),
});
console.log('LIVE_PREACTIVATION_ENV=PASS_ALL_FINANCE_OFF');
JS
node --env-file="$LIVE" scripts/rc86-live-activation-audit.mjs
# Snapshot exact existing public PM2 deployment; never print pm2 JSON because
# it can contain environment variables.
CURRENT="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);
process.stdin.on("end",()=>{
 try{
  const all=JSON.parse(s);
  if(all.length!==2||all.some(x=>x.pm2_env?.status!=="online"))process.exit(2);
  const a=all.find(x=>x.name==="tala-node-stage-api");
  const w=all.find(x=>x.name==="tala-node-stage-worker");
  const dir=a?.pm2_env?.pm_cwd,mode=a?.pm2_env?.NODE_ENV;
  if(!dir||w?.pm2_env?.pm_cwd!==dir||w?.pm2_env?.NODE_ENV!==mode||
     !["production","staging"].includes(mode)||
     !dir.startsWith("/home/tala-node-stage/tala-node-releases/")||
     !dir.endsWith("/node-backend"))process.exit(3);
  process.stdout.write(dir+" "+mode);
 }catch{process.exit(4)}
})')"
read -r OLD OLD_MODE <<< "$CURRENT"
if [[ "$OLD_MODE" == "staging" ]]; then
  [[ -f "$OLD/ecosystem.config.cjs" ]] || { echo "ROLLBACK_SOURCE_MISSING";exit 1; }
else
  [[ -f "$OLD/ecosystem.production.config.cjs" ]] ||
    { echo "ROLLBACK_SOURCE_MISSING";exit 1; }
  # Never start from a production instance that may already accept payments.
  LOCAL_STATE="$(curl -fsS --max-time 5 http://127.0.0.1:18190/api/v1/health |
    node -e 'let s="";process.stdin.on("data",x=>s+=x);
    process.stdin.on("end",()=>{const j=JSON.parse(s);
      if(j.production!==true||j.online_payment_writes!==false)process.exit(1);
      console.log("standby")})')"
  [[ "$LOCAL_STATE" == "standby" ]] || { echo "ABORT_PREVIOUS_PRODUCTION_NOT_STANDBY";exit 1; }
fi
echo "EXISTING_PUBLIC_PM2=2_PROCESSES"
echo "ROLLBACK_RELEASE_AVAILABLE=PASS"
if [[ "$ACTION" == "--plan" ]];then
 echo "STRIPE_LIVE_GO_LIVE_PLAN=PASS_NO_CHANGES"
 echo "NEXT=EXPLICIT_APPROVAL_REQUIRED"
 exit 0
fi
if [[ "$APPROVAL" != "I_AUTHORIZE_STRIPE_LIVE_CHARGES" ]];then
 echo "ABORT_EXPLICIT_REAL_MONEY_APPROVAL_REQUIRED";exit 2
fi
BACKUPS="$HOME/tala-node-backups"
mkdir -p -m 700 "$BACKUPS"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SAVED_ENV="$BACKUPS/pre-live-activation-$STAMP.env"
DB_DUMP="$BACKUPS/pre-live-activation-$STAMP.dump"
cp -p -- "$LIVE" "$SAVED_ENV"
chmod 600 "$SAVED_ENV"
# Full LIVE PG backup before enabling the financial switches.
node --env-file="$LIVE" --input-type=module - "$DB_DUMP" <<'JS'
import {spawnSync} from 'node:child_process';
import {chmodSync,statSync} from 'node:fs';
const u=new URL(process.env.DATABASE_URL),file=process.argv[2];
const env={...process.env,PGHOST:u.hostname,PGPORT:u.port,
 PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),
 PGDATABASE:decodeURIComponent(u.pathname.slice(1))};
const run=(cmd,args,timeout)=>spawnSync(cmd,args,{
 env,timeout,stdio:['ignore','ignore','ignore']});
const dump=run('pg_dump',['-Fc','-f',file],90000);
if(dump.status!==0)process.exit(1);
chmodSync(file,0o600);
if(statSync(file).size<1024)process.exit(1);
if(run('pg_restore',['--list',file],15000).status!==0)process.exit(1);
console.log('PRE_LIVE_DATABASE_BACKUP=PASS');
JS
# Once environment mutation begins, any ERROR restores the old env; when PM2
# has been changed it restores both old PM2 apps too.
ENV_CHANGED=no
PM2_CHANGED=no
COMPLETED=no
rollback(){
 if [[ "$COMPLETED" == yes ]];then return;fi
 trap - ERR EXIT
 if [[ "$ENV_CHANGED" == yes ]];then
   cp -p -- "$SAVED_ENV" "$LIVE" || echo "PRIVATE_ENV_ROLLBACK=MANUAL_ATTENTION"
   echo "LIVE_ENV_ROLLBACK=ATTEMPTED"
 fi
 if [[ "$PM2_CHANGED" == yes ]];then
   echo "PUBLIC_PM2_ROLLBACK=START"
   pm2 delete tala-node-stage-worker >/dev/null 2>&1 || true
   pm2 delete tala-node-stage-api >/dev/null 2>&1 || true
   if [[ "$OLD_MODE" == staging ]];then
     (cd "$OLD" &&
       env -u TALA_LIVE_ENV_FILE TALA_STAGE_ENV_FILE="$STAGE" NODE_ENV=staging \
         pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env >/dev/null &&
       env -u TALA_LIVE_ENV_FILE TALA_STAGE_ENV_FILE="$STAGE" NODE_ENV=staging \
         pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env >/dev/null) ||
         echo "PUBLIC_PM2_ROLLBACK=MANUAL_ATTENTION"
   else
     (cd "$OLD" &&
       env -u TALA_STAGE_ENV_FILE TALA_LIVE_ENV_FILE="$LIVE" NODE_ENV=production \
         pm2 start ecosystem.production.config.cjs --only tala-node-stage-api --update-env >/dev/null &&
       env -u TALA_STAGE_ENV_FILE TALA_LIVE_ENV_FILE="$LIVE" NODE_ENV=production \
         pm2 start ecosystem.production.config.cjs --only tala-node-stage-worker --update-env >/dev/null) ||
         echo "PUBLIC_PM2_ROLLBACK=MANUAL_ATTENTION"
   fi
   pm2 save >/dev/null 2>&1 || true
   echo "PUBLIC_PM2_ROLLBACK=ATTEMPTED_CHECK_HEALTH"
 fi
}
trap rollback ERR EXIT
# Atomic file replacement, strict 0600 and no interpolation of private keys.
python3 - "$LIVE" <<'PY'
import os,stat,sys,tempfile
from pathlib import Path
path=Path(sys.argv[1])
lines=path.read_text().splitlines(keepends=True)
names=('STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
 'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_MANUAL_SETTLEMENT_APPROVED')
required=set(names)|{'STRIPE_CONNECT_TRANSFERS_ENABLED'}
seen={}
for i,line in enumerate(lines):
 if line.startswith('#') or not line.strip():continue
 key,sep,val=line.partition('=')
 if not sep:raise SystemExit('INVALID_ENV')
 if key in required:
  if key in seen or val.strip()!='false':raise SystemExit('NOT_STANDBY')
  seen[key]=i
if set(seen)!=required:raise SystemExit('MISSING_REQUIRED_SWITCHES')
for key in names:
 lines[seen[key]]=key+'=true\n'
payload=''.join(lines)
fd,tmp=tempfile.mkstemp(prefix='.stripe-go-live-',dir=path.parent)
try:
 os.fchmod(fd,0o600)
 with os.fdopen(fd,'w') as out:
  out.write(payload);out.flush();os.fsync(out.fileno())
 os.replace(tmp,path)
except:
 try:os.unlink(tmp)
 except FileNotFoundError:pass
 raise
print('STRIPE_LIVE_ENV_FLAGS=ON')
print('CONNECT_TRANSFERS=OFF')
PY
ENV_CHANGED=yes
# Re-audit the actual LIVE flags and Stripe platform before changing PM2.
node --env-file="$LIVE" --input-type=module <<'JS'
import {config} from './dist/config.js';
import {liveSettingsFromProduction} from './dist/live/runtime-dependencies.js';
if(config.STRIPE_FINANCIAL_WRITES_ENABLED!=='true'||
 config.STRIPE_LIVE_RELEASE_APPROVED!=='true'||
 config.STRIPE_LIVE_ENABLED!=='true'||
 config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false')
 process.exit(1);
liveSettingsFromProduction();
console.log('REAL_MONEY_RELEASE_GUARD=PASS');
JS
node --env-file="$LIVE" scripts/rc86-live-activation-audit.mjs
PM2_CHANGED=yes
pm2 delete tala-node-stage-worker >/dev/null
pm2 delete tala-node-stage-api >/dev/null
cd "$APP"
env -u TALA_STAGE_ENV_FILE TALA_LIVE_ENV_FILE="$LIVE" NODE_ENV=production \
 pm2 start ecosystem.production.config.cjs --only tala-node-stage-api --update-env >/dev/null
env -u TALA_STAGE_ENV_FILE TALA_LIVE_ENV_FILE="$LIVE" NODE_ENV=production \
 pm2 start ecosystem.production.config.cjs --only tala-node-stage-worker --update-env >/dev/null
for attempt in $(seq 1 40);do
 if node --input-type=module <<'JS' >/dev/null 2>&1
const base='http://127.0.0.1:18190/api/v1';
try{
 const [a,b,c]=await Promise.all(['/health','/ready',
  '/payments/stripe/config'].map(x=>fetch(base+x,{signal:AbortSignal.timeout(2500)})));
 if(!a.ok||!b.ok||!c.ok)throw Error();
 const [health,ready,payments]=await Promise.all([a.json(),b.json(),c.json()]);
 if(health.production!==true||health.online_payment_writes!==true||
    ready.ready!==true||ready.environment!=='production'||
    ready.workerOnline!==true||ready.onlinePaymentsEnabled!==true||
    payments.enabled!==true||!payments.publishable_key?.startsWith('pk_live_'))throw Error();
}catch{process.exitCode=1}
JS
 then break;fi
 if [[ "$attempt" -eq 40 ]];then echo "LIVE_HEALTH=FAIL_ROLLBACK";false;fi
 sleep 2
done
# A spoofed webhook cannot be considered a successful payment.
UNSIGNED="$(curl --silent --output /dev/null --write-out '%{http_code}' \
 --max-time 8 --header 'Content-Type: application/json' \
 --data '{}' http://127.0.0.1:18190/api/v1/payments/stripe/webhook)"
[[ "$UNSIGNED" == 400 || "$UNSIGNED" == 401 || "$UNSIGNED" == 403 ]] || {
 echo "UNSIGNED_WEBHOOK_NOT_REJECTED";false;
}
echo "UNSIGNED_WEBHOOK=REJECTED"
# The public URL must be the same service now running on PM2.
node --input-type=module <<'JS'
const base='https://talaeats.alan-palacios-dev.com/api/v1';
try{
 const [a,b,c]=await Promise.all(['/health','/ready',
 '/payments/stripe/config'].map(x=>fetch(base+x,{signal:AbortSignal.timeout(12000)})));
 if(!a.ok||!b.ok||!c.ok)throw Error();
 const [h,r,p]=await Promise.all([a.json(),b.json(),c.json()]);
 if(h.production!==true||h.online_payment_writes!==true||
   r.ready!==true||r.onlinePaymentsEnabled!==true||
   p.enabled!==true||!p.publishable_key?.startsWith('pk_live_'))throw Error();
 console.log('PUBLIC_STRIPE_LIVE_CONTRACT=PASS');
}catch{console.log('PUBLIC_STRIPE_LIVE_CONTRACT=HOLD');process.exitCode=1;}
JS
pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);
process.stdin.on("end",()=>{
 try{
 const a=JSON.parse(s);
 const names=a.map(x=>x.name).sort().join(",");
 if(a.length!==2||names!=="tala-node-stage-api,tala-node-stage-worker"||
    a.some(x=>x.pm2_env?.status!=="online"||
      x.pm2_env?.NODE_ENV!=="production"))process.exit(1);
 }catch{process.exit(1)}
})'
pm2 save >/dev/null
COMPLETED=yes
trap - ERR EXIT
echo "STRIPE_LIVE_PM2_ACTIVATION=PASS"
echo "SAME_PUBLIC_PM2_PROCESSES=2"
echo "REAL_STRIPE_CARD_CHECKOUT=ENABLED_FOR_APPROVED_SELLERS_ONLY"
echo "STRIPE_CONNECT_TRANSFERS=OFF"
echo "SIGNED_PAYMENT_WEBHOOK_E2E=STILL_REQUIRES_REAL_PAYMENT_TEST"
