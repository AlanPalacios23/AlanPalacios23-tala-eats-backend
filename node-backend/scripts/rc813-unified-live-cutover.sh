#!/usr/bin/env bash
# RC8.13 unified LIVE: replace exactly the existing public API + finance worker.
# Explicit approval, no schema mutations, Stripe payments stay in existing LIVE mode.
set -Eeuo pipefail
set +x
umask 077
SHA="${1:-}"; APPROVAL="${2:-}"
if [[ "$#" -ne 2 || ! "$SHA" =~ ^[a-f0-9]{40}$ ||
      "$APPROVAL" != 'I_APPROVE_RC813_EXISTING_LIVE_PM2_CUTOVER' ]];then
 echo 'USAGE: bash scripts/rc813-unified-live-cutover.sh EXACT_40_SHA I_APPROVE_RC813_EXISTING_LIVE_PM2_CUTOVER'
 exit 2
fi
[[ "$(id -un)" == 'tala-node-stage' && "$HOME" == '/home/tala-node-stage' &&
  "$(id -u)" != 0 ]] || { echo 'RC813_ABORT=STAGE_SERVICE_USER_ONLY';exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"
DIR="$ROOT/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
ECO="$DIR/rc813-live/ecosystem.config.cjs"
[[ -d "$DIR" && ! -L "$ROOT" && ! -L "$DIR" &&
   "$(cd "$(dirname "$0")/.." && pwd -P)" == "$DIR" &&
   "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" &&
   -f "$ECO" ]] || { echo 'RC813_ABORT=LOCKED_COMPILED_RELEASE_REQUIRED';exit 1; }
cd "$DIR"
# Re-check source, live finance, Stripe signed webhooks, PM2 two processes
# and Prisma status without any live writes, immediately before activation.
bash scripts/rc813-unified-live-preflight.sh --plan "$SHA"

# Exact two running public processes; no other live processes are altered.
OLD_DIR="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{
  const p=JSON.parse(s),names=p.map(x=>x.name).sort();
  if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"])||
     p.some(x=>x.pm2_env?.status!=="online"||x.pm2_env?.NODE_ENV!=="production"))
   process.exit(1);
  const d=p[0].pm2_env?.pm_cwd;
  if(!d?.startsWith("/home/tala-node-stage/tala-node-releases/")||
     !d.endsWith("/node-backend")||p.some(x=>x.pm2_env.pm_cwd!==d))process.exit(1);
  process.stdout.write(d)
 }catch{process.exit(1)}
})')" || { echo 'RC813_ABORT=UNEXPECTED_LIVE_PM2';exit 1; }
OLD_SHA="$(git -C "$OLD_DIR" rev-parse --verify HEAD)" || exit 1
[[ "$OLD_SHA" == 'aea74744ba47db2333bcef052b296a7a7ab63eb9' &&
   "$OLD_DIR" != "$DIR" && -f "$OLD_DIR/dist/server.js" &&
   -f "$OLD_DIR/dist/live/production-worker.js" ]] || {
 echo 'RC813_ABORT=UNREVIEWED_PREVIOUS_LIVE_RELEASE';exit 1;
}
echo 'RC813_PREVIOUS_LIVE_SHA_CONFIRMED=PASS'

BACKUP_DIR="$HOME/tala-node-backups"
mkdir -p -m 700 "$BACKUP_DIR"
[[ ! -L "$BACKUP_DIR" && "$(stat -c '%u' "$BACKUP_DIR")" == "$(id -u)" &&
   "$(stat -c '%a' "$BACKUP_DIR")" == 700 ]] || {
 echo 'RC813_ABORT=BACKUP_DIRECTORY_UNSAFE';exit 1;
}
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP="$BACKUP_DIR/rc813-pre-unified-live-$STAMP.dump"
# FULL production backup. URL and PGPASSWORD remain only in process memory;
# does NOT target stage. Archive listing is necessary but is NOT restore proof.
node --env-file="$ENV" --input-type=module - "$BACKUP" <<'JS'
import {spawnSync} from 'node:child_process';
import {statSync,chmodSync,unlinkSync} from 'node:fs';
const u=new URL(process.env.DATABASE_URL),file=process.argv[2];
if(process.env.NODE_ENV!=='production'||u.pathname==='/tala_node_stage'||
   u.username==='tala_node_stage'||u.port==='15435')
 throw Error('RC813_PROD_PG_SOURCE_REQUIRED');
const env={...process.env,PGHOST:u.hostname,PGPORT:u.port,
 PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),
 PGDATABASE:decodeURIComponent(u.pathname.slice(1))};
const run=(command,args,timeout)=>spawnSync(command,args,{
  env,stdio:['ignore','ignore','ignore'],timeout});
let pass=false;
try{
 if(run('pg_dump',['-Fc','-f',file],120000).status!==0)throw Error('DUMP_FAIL');
 chmodSync(file,0o600);
 if(statSync(file).size<1024||
    run('pg_restore',['--list',file],20000).status!==0)throw Error('ARCHIVE_INVALID');
 pass=true;
 console.log('RC813_PRE_LIVE_BACKUP_AND_ARCHIVE_LIST=PASS');
}finally{if(!pass){try{unlinkSync(file)}catch{}}}
JS

# Canonical rollback ecosystem stored privately, but never modifying OLD release.
RECOVERY="$BACKUP_DIR/rc813-live-recovery-$STAMP"
mkdir -m 700 "$RECOVERY"
cat > "$RECOVERY/ecosystem.config.cjs" <<'JS'
const cwd=process.env.RC813_OLD_LIVE_APP;
const envFile='/home/tala-node-stage/.config/talaeats-node-live.env';
if(!cwd?.startsWith('/home/tala-node-stage/tala-node-releases/')||
 !cwd.endsWith('/node-backend')||
 process.env.PM2_HOME!=='/home/tala-node-stage/.pm2'||
 process.env.TALA_LIVE_ENV_FILE!==envFile||process.env.NODE_ENV!=='production')
 throw Error('RC813_ROLLBACK_IDENTITY_REQUIRED');
module.exports={apps:[
 {name:'tala-node-stage-worker',cwd,script:'./dist/live/production-worker.js',
  node_args:['--env-file='+envFile],exec_mode:'fork',instances:1,autorestart:true,
  env:{NODE_ENV:'production'}},
 {name:'tala-node-stage-api',cwd,script:'./dist/server.js',
  node_args:['--env-file='+envFile],exec_mode:'fork',instances:1,autorestart:true,
  env:{NODE_ENV:'production'}}
]};
JS
chmod 600 "$RECOVERY/ecosystem.config.cjs"
live_pm2(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
  NODE_ENV=production PM2_HOME="$HOME/.pm2" TALA_LIVE_ENV_FILE="$ENV" \
  RC813_OLD_LIVE_APP="$OLD_DIR" pm2 "$@"
}
ROLLOUT_STARTED=no; DEPLOYED=no
rollback(){
 code=$?
 trap - EXIT
 if [[ "$ROLLOUT_STARTED" == yes && "$DEPLOYED" != yes ]];then
  echo 'RC813_LIVE_ROLLBACK=START'
  live_pm2 delete tala-node-stage-api >/dev/null 2>&1 || true
  live_pm2 delete tala-node-stage-worker >/dev/null 2>&1 || true
  live_pm2 start "$RECOVERY/ecosystem.config.cjs" --only tala-node-stage-worker --update-env >/dev/null || true
  live_pm2 start "$RECOVERY/ecosystem.config.cjs" --only tala-node-stage-api --update-env >/dev/null || true
  live_pm2 save >/dev/null 2>&1 || true
  echo 'RC813_LIVE_ROLLBACK=ATTEMPTED_OPERATOR_CHECK_REQUIRED'
 fi
 exit "$code"
}
trap rollback EXIT
# Incoming checkout pauses only during a short explicitly approved PM2 swap.
# Stop incoming API FIRST, then finish/stop old financial worker.
ROLLOUT_STARTED=yes
live_pm2 delete tala-node-stage-api
live_pm2 delete tala-node-stage-worker
# Never use a stale 45s heartbeat as evidence the new finance worker started.
node --env-file="$ENV" --input-type=module <<'JS'
import {Redis} from 'ioredis';
const redis=new Redis(process.env.REDIS_URL,{lazyConnect:true,
 connectTimeout:1500,maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await redis.connect();await redis.del('tala:node:live:worker:heartbeat');}
finally{redis.disconnect();}
JS
live_pm2 start "$ECO" --only tala-node-stage-worker --update-env
live_pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{const a=JSON.parse(s);
 if(a.length!==1||a[0].name!=="tala-node-stage-worker"||
 a[0].pm2_env?.status!=="online"||
 !a[0].pm2_env?.pm_exec_path?.endsWith("/dist/live/production-worker.js"))process.exit(1);
 console.log("RC813_LIVE_WORKER_PM2_IDENTITY=PASS")}catch{process.exit(1)}
})'
FINANCE_HEARTBEAT=no
for i in $(seq 1 40);do
 if node --env-file="$ENV" --input-type=module - <<'JS' >/dev/null 2>&1
import {Redis} from 'ioredis';
const r=new Redis(process.env.REDIS_URL,{lazyConnect:true,connectTimeout:1000,
 maxRetriesPerRequest:1,retryStrategy:()=>null});
try{await r.connect();if(await r.get('tala:node:live:worker:heartbeat')!=='online')
 process.exitCode=1;}catch{process.exitCode=1;}finally{r.disconnect();}
JS
 then FINANCE_HEARTBEAT=yes;break;fi
 sleep 2
done
[[ "$FINANCE_HEARTBEAT" == yes ]] || { echo 'RC813_ABORT=LIVE_WORKER_NOT_RECONCILING';exit 1; }
live_pm2 start "$ECO" --only tala-node-stage-api --update-env
live_pm2 jlist | node -e '
let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{
 try{
 const a=JSON.parse(s),names=a.map(p=>p.name).sort();
 if(JSON.stringify(names)!==JSON.stringify(["tala-node-stage-api","tala-node-stage-worker"])||
  a.some(p=>p.pm2_env?.status!=="online")||
  !a.some(p=>p.name==="tala-node-stage-api"&&p.pm2_env?.pm_exec_path?.endsWith("/dist/server.js")))
  process.exit(1);
 console.log("RC813_ONE_LIVE_PM2_API_WORKER=PASS");
 }catch{process.exit(1)}
})'
LIVE_READY=no
for i in $(seq 1 40);do
 if bash scripts/rc813-unified-live-preflight.sh --verify "$SHA" >/dev/null 2>&1;then
  LIVE_READY=yes;break
 fi
 sleep 2
done
[[ "$LIVE_READY" == yes ]] || { echo 'RC813_ABORT=LIVE_PAYMENT_READINESS_OR_PUBLIC_ROUTE';exit 1; }
# Web Push is opt-in. A payment-healthy LIVE process alone is NOT enough
# to commit a push release; require the real finance-worker heartbeat and
# public VAPID config from the same two LIVE processes. A failure before
# DEPLOYED=yes triggers the existing PM2 rollback.
PUSH_EXPECTED="$(node --env-file="$ENV" -e 'process.stdout.write(process.env.WEB_PUSH_ENABLED==="true"?"true":"false")')"
if [[ "$PUSH_EXPECTED" == true ]]; then
 PUSH_READY=no
 for i in $(seq 1 15);do
  if node --env-file="$ENV" --input-type=module - <<'JS' >/dev/null 2>&1
const expected=process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
if(!expected||process.env.WEB_PUSH_ENABLED!=='true')process.exit(1);
for(const root of ['http://127.0.0.1:18190','https://talaeats.alan-palacios-dev.com']){
 const res=await fetch(root+'/api/v1/v11/push/config',{
   signal:AbortSignal.timeout(4000)});
 const value=await res.json();
 if(!res.ok||value.enabled!==true||value.public_key!==expected)
   process.exit(1);
}
JS
  then PUSH_READY=yes;break;fi
  sleep 2
 done
 [[ "$PUSH_READY" == yes ]] || {
  echo 'RC813_LIVE_PUSH_WORKER_OR_PUBLIC_API_NOT_READY_ROLLBACK';exit 1;
 }
 echo 'RC813_LIVE_PUSH_WORKER_AND_PUBLIC_VAPID=PASS'
fi
live_pm2 save
DEPLOYED=yes
trap - EXIT
echo 'RC813_UNIFIED_LIVE_DEPLOYED=PASS'
echo "RC813_ACTIVE_LIVE_SHA=$SHA"
echo 'RC813_PRODUCTION_PORT=18190'
echo 'RC813_PAYMENTS=EXISTING_LIVE_STRIPE_ONLY'
echo 'RC813_CONNECT_TRANSFERS=STILL_OFF'
echo 'RC813_STAGE_18192=REQUIRES_SEPARATE_RETIREMENT'
echo 'RC813_RESTORE_ARCHIVE_NOT_FULLY_REHEARSED=OPERATOR_REVIEW'
