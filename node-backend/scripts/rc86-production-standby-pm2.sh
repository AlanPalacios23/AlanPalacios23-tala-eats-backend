#!/usr/bin/env bash
# Tala Eats RC8.6: in-place production STANDBY (no Stripe charge creation).
# Exactly the existing two PM2 processes and public URL; no Docker or new API.
# An explicit approval is required to mutate PM2. On any failed health check,
# restore both processes to their previous staging release.
set -Eeuo pipefail
set +x
umask 077
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
MODE="$1"
SHA="$2"
APPROVAL="$(printf '%s' "$3")"
BASE="$HOME/tala-node-releases"
ROOT="$BASE/$SHA"
APP="$ROOT/node-backend"
LIVE="$HOME/.config/talaeats-node-live.env"
STAGE="$HOME/.config/talaeats-node-staging.env"
if [[ $# -ne 3 || ! "$SHA" =~ ^[a-f0-9]{40}$ ||
      ( "$MODE" != "--plan" && "$MODE" != "--apply" ) ]]; then
  echo "USAGE: --plan|--apply FULL_SHA I_APPROVE_PRODUCTION_STANDBY_NO_CHARGES"
  exit 2
fi
if [[ "$(id -un)" != "tala-node-stage" ||
      "$HOME" != "/home/tala-node-stage" ]]; then
  echo "ABORT_SERVICE_ACCOUNT_REQUIRED"
  exit 1
fi
if [[ ! -d "$APP" || -L "$ROOT" || -L "$APP" ||
      "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" != "$SHA" ||
      -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ||
      ! -f "$APP/dist/server.js" ||
      ! -f "$APP/dist/live/production-worker.js" ]]; then
  echo "ABORT_UNVERIFIED_RELEASE"
  exit 1
fi
for file in "$LIVE" "$STAGE"; do
  if [[ ! -f "$file" || -L "$file" ||
        "$(stat -c '%a' "$file")" != 600 ||
        "$(stat -c '%u' "$file")" != "$(id -u)" ]]; then
    echo "ABORT_PRIVATE_ENV"
    exit 1
  fi
done
cd "$APP"
# Executable production config must accept exactly all-off payment flags.
node --env-file="$LIVE" --input-type=module - <<'JS'
import {config} from './dist/config.js';
import {validateLiveStandbySettings} from './dist/live/guard.js';
const names=['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
  'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
  'STRIPE_MANUAL_SETTLEMENT_APPROVED','STRIPE_CONNECT_TRANSFERS_ENABLED'];
if(config.NODE_ENV!=='production'||config.PORT!==18190||
   names.some(n=>config[n]!=='false'))process.exit(1);
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
console.log('PRODUCTION_STANDBY_FLAGS=PASS_ALL_OFF');
JS
# Do not print pm2 jlist: it may contain private environment values.
OLD="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",b=>s+=b);
process.stdin.on("end",()=>{
try{
 const p=JSON.parse(s);
 if(p.length!==2||p.some(x=>x.pm2_env?.status!=="online"))process.exit(2);
 const a=p.find(x=>x.name==="tala-node-stage-api");
 const w=p.find(x=>x.name==="tala-node-stage-worker");
 const d=a?.pm2_env?.pm_cwd;
 if(!d||w?.pm2_env?.pm_cwd!==d||!d.endsWith("/node-backend")||
    !d.startsWith("/home/tala-node-stage/tala-node-releases/")||
    a.pm2_env.NODE_ENV!=="staging"||w.pm2_env.NODE_ENV!=="staging")process.exit(3);
 process.stdout.write(d);
}catch{process.exit(4)}
})')"
if [[ ! -f "$OLD/ecosystem.config.cjs" ]]; then
  echo "ABORT_PREVIOUS_PM2_ROLLBACK_UNAVAILABLE"
  exit 1
fi
# Read-only DB verification uses production PostgreSQL and no SQL mutations.
node --env-file="$LIVE" --input-type=module - <<'JS'
import {Pool} from 'pg';
const pool=new Pool({connectionString:process.env.DATABASE_URL,
 connectionTimeoutMillis:5000,statement_timeout:7000,max:1});
try{
 const result=await pool.query('SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
 if(result.rows[0]?.n<26)throw Error('SCHEMA_MIGRATIONS_NOT_READY');
 await pool.query('SELECT 1 FROM tala_live_merchant_accounts LIMIT 1');
 console.log('LIVE_POSTGRES_MIGRATIONS=PASS');
}catch{console.log('LIVE_POSTGRES_MIGRATIONS=HOLD');process.exitCode=1;}
finally{await pool.end();}
JS
echo "PM2_PREVIOUS_STAGE_ROLLBACK=PASS"
echo "PRODUCTION_STANDBY_SOURCE_SHA=$SHA"
if [[ "$MODE" == "--plan" ]]; then
  echo "PRODUCTION_STANDBY_PLAN=PASS_NO_CHANGES"
  echo "STRIPE_CHARGES=OFF"
  exit 0
fi
if [[ "$APPROVAL" != "I_APPROVE_PRODUCTION_STANDBY_NO_CHARGES" ]]; then
  echo "ABORT_EXPLICIT_STANDBY_APPROVAL_REQUIRED"
  exit 2
fi
# Backup the real LIVE database with libpq environment variables so the
# password is never passed on argv, printed, or embedded in the dump filename.
BACKUP_DIR="$HOME/tala-node-backups"
mkdir -p -m 700 "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/pre-standby-$(date -u +%Y%m%dT%H%M%SZ).dump"
node --env-file="$LIVE" --input-type=module - "$BACKUP" <<'JS'
import {spawnSync} from 'node:child_process';
import {statSync,chmodSync} from 'node:fs';
const db=new URL(process.env.DATABASE_URL);
const file=process.argv[2];
const env={...process.env,PGHOST:db.hostname,PGPORT:db.port,
  PGUSER:decodeURIComponent(db.username),
  PGPASSWORD:decodeURIComponent(db.password),
  PGDATABASE:decodeURIComponent(db.pathname.slice(1))};
const run=spawnSync('pg_dump',['-Fc','-f',file],{
 env,timeout:90000,stdio:['ignore','ignore','ignore']});
if(run.status!==0)process.exit(1);
chmodSync(file,0o600);
if(statSync(file).size<1024)process.exit(1);
const audit=spawnSync('pg_restore',['--list',file],{
 env,timeout:15000,stdio:['ignore','ignore','ignore']});
if(audit.status!==0)process.exit(1);
console.log('LIVE_DATABASE_BACKUP=PASS');
JS
ROLLOUT=no
SUCCESS=no
rollback(){
  if [[ "$ROLLOUT" != yes || "$SUCCESS" == yes ]]; then return; fi
  ROLLOUT=no
  trap - ERR EXIT
  echo "PRODUCTION_STANDBY_ROLLBACK=START"
  pm2 delete tala-node-stage-worker >/dev/null 2>&1 || true
  pm2 delete tala-node-stage-api >/dev/null 2>&1 || true
  cd "$OLD"
  TALA_STAGE_ENV_FILE="$STAGE" pm2 start ecosystem.config.cjs --only tala-node-stage-api --update-env >/dev/null || true
  TALA_STAGE_ENV_FILE="$STAGE" pm2 start ecosystem.config.cjs --only tala-node-stage-worker --update-env >/dev/null || true
  pm2 save >/dev/null 2>&1 || true
  echo "PRODUCTION_STANDBY_ROLLBACK=ATTEMPTED_CHECK_HEALTH"
}
trap rollback ERR EXIT
ROLLOUT=yes
pm2 delete tala-node-stage-worker >/dev/null
pm2 delete tala-node-stage-api >/dev/null
cd "$APP"
TALA_LIVE_ENV_FILE="$LIVE" NODE_ENV=production pm2 start ecosystem.production.config.cjs --only tala-node-stage-api --update-env >/dev/null
TALA_LIVE_ENV_FILE="$LIVE" NODE_ENV=production pm2 start ecosystem.production.config.cjs --only tala-node-stage-worker --update-env >/dev/null
for attempt in $(seq 1 35); do
 if node -e '
 Promise.all([
 fetch("http://127.0.0.1:18190/api/v1/health",{signal:AbortSignal.timeout(2000)}),
 fetch("http://127.0.0.1:18190/api/v1/ready",{signal:AbortSignal.timeout(2000)}),
 fetch("http://127.0.0.1:18190/api/v1/payments/stripe/config",{signal:AbortSignal.timeout(2000)})
 ]).then(async a=>{
  const [h,r,c]=await Promise.all(a.map(x=>x.json()));
  if(h.production!==true||h.online_payment_writes!==false||
     r.ready!==true||r.environment!=="production"||
     r.financialWrites!==false||r.onlinePaymentsEnabled!==false||
     c.enabled!==false||c.publishable_key!==null)process.exit(1);
 }).catch(()=>process.exit(1))' >/dev/null 2>&1; then
  break
 fi
 if [[ "$attempt" -eq 35 ]]; then echo "STANDBY_HEALTH_FAILED"; false; fi
 sleep 2
done
# Verify the PUBLIC Cloudflare URL routes to the same safe production API.
node --input-type=module - <<'JS'
const base='https://talaeats.alan-palacios-dev.com/api/v1';
try{
 const [h,r,c]=await Promise.all([
  fetch(base+'/health',{signal:AbortSignal.timeout(10000)}),
  fetch(base+'/ready',{signal:AbortSignal.timeout(10000)}),
  fetch(base+'/payments/stripe/config',{signal:AbortSignal.timeout(10000)})
 ]);
 const [health,ready,config]=await Promise.all([h.json(),r.json(),c.json()]);
 if(health.production!==true||health.online_payment_writes!==false||
    ready.ready!==true||ready.onlinePaymentsEnabled!==false||
    config.enabled!==false||config.publishable_key!==null)throw Error();
 console.log('PUBLIC_STANDBY_API_AND_PAYMENTS_OFF=PASS');
}catch{console.log('PUBLIC_STANDBY_API_AND_PAYMENTS_OFF=HOLD');process.exitCode=1;}
JS
pm2 save >/dev/null
SUCCESS=yes
trap - ERR EXIT
echo "PRODUCTION_STANDBY_PM2=PASS"
echo "PUBLIC_PM2_PROCESSES=2"
echo "LIVE_DATABASE_AND_REDIS=ACTIVE"
echo "STRIPE_LIVE_CHARGES=OFF"
echo "CONNECT_TRANSFERS=OFF"
