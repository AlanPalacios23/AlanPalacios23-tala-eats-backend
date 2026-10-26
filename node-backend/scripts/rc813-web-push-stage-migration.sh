#!/usr/bin/env bash
# RC8.13: review or explicitly apply ONE additive Web Push migration to
# isolated PostgreSQL 15 staging DB. NEVER target LIVE PostgreSQL or Stripe.
set -Eeuo pipefail
set +x
umask 077

MODE="${1:-}"
APPROVAL="${2:-}"
SHA="398b531c4778a03975f30470f6979a38b9c8bb62"
MIGRATION="20261026043000_web_push_delivery"
ROOT="/home/tala-node-stage/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
ENV="/home/tala-node-stage/.config/talaeats-node-rc813-parallel.env"
BACKUP_ROOT="/home/tala-node-stage/tala-node-stage-backups"
PM2_STAGE="/home/tala-node-stage/.pm2-tala-rc813-parallel"

case "$MODE" in --plan)
 [[ "$#" == 1 ]] || { echo 'PUSH_DB_ABORT=PLAN_NO_ADDITIONAL_ARGUMENTS'; exit 2; };;
 --apply)
 [[ "$#" == 2 && "$APPROVAL" == "I_APPROVE_STAGE_PUSH_DB_ONLY" ]] || {
  echo 'PUSH_DB_ABORT=EXPLICIT_STAGE_APPROVAL_REQUIRED'; exit 2;
 };;
 *) echo 'USAGE: --plan | --apply I_APPROVE_STAGE_PUSH_DB_ONLY'; exit 2;;
esac
[[ "$(id -un)" == "tala-node-stage" && "$(id -u)" != "0" &&
  "$HOME" == "/home/tala-node-stage" ]] || { echo 'PUSH_DB_ABORT=STAGE_USER_REQUIRED'; exit 1; }
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
for program in git node pg_dump pg_restore ss; do
 command -v "$program" >/dev/null || { echo "PUSH_DB_ABORT=MISSING_$program"; exit 1; }
done
[[ ! -L "$ROOT" && ! -L "$WORK" && -d "$WORK" &&
   "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
   -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || {
 echo 'PUSH_DB_ABORT=UNTRUSTED_RELEASE'; exit 1;
}
[[ -f "$ENV" && ! -L "$ENV" && "$(stat -c '%a' "$ENV")" == "600" &&
  "$(stat -c '%u' "$ENV")" == "$(id -u)" ]] || {
 echo 'PUSH_DB_ABORT=PRIVATE_STAGE_ENV_REQUIRED'; exit 1;
}
[[ ! -e "$PM2_STAGE" && ! -L "$PM2_STAGE" ]] || {
 echo 'PUSH_DB_ABORT=STAGE_PM2_PRESENT'; exit 1;
}
[[ -z "$(ss -lntH | awk '$4 ~ /(^|:)18192$/ {print $4}')" ]] || {
 echo 'PUSH_DB_ABORT=STAGE_PORT_BUSY'; exit 1;
}
cd "$WORK"
[[ -f "prisma/migrations/$MIGRATION/migration.sql" &&
   -f "node_modules/prisma/build/index.js" ]] || {
 echo 'PUSH_DB_ABORT=RELEASE_NOT_PREPARED'; exit 1;
}
stage_node(){
 env -i HOME="$HOME" USER=tala-node-stage LOGNAME=tala-node-stage PATH="$PATH" \
  node --env-file="$ENV" "$@"
}
# All assertions use the PRIVATE staging environment, never shell DB defaults.
stage_node --input-type=module - <<'JS'
import {Client} from 'pg';
import {readdirSync,statSync} from 'node:fs';
const env=process.env;
const url=new URL(env.DATABASE_URL??'http://invalid');
const redis=new URL(env.REDIS_URL??'http://invalid');
const off=['STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_LIVE_ENABLED',
 'STRIPE_LIVE_RELEASE_APPROVED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_CONNECT_TRANSFERS_ENABLED','STRIPE_MANUAL_SETTLEMENT_APPROVED',
 'STAGE_STRIPE_TEST_CHECKOUT_ENABLED','STAGE_DELIVERY_STRIPE_TEST_ENABLED'];
const fail=reason=>{throw Error('PUSH_DB_HOLD_'+reason)};
if(env.NODE_ENV!=='staging'||env.HOST!=='127.0.0.1'||
 env.PORT!=='18192'||env.STAGE_PARALLEL_ENABLED!=='true'||
 url.protocol!=='postgresql:'&&url.protocol!=='postgres:'||
 url.hostname!=='127.0.0.1'||url.port!=='15435'||
 url.pathname!=='/tala_node_stage'||url.username!=='tala_node_stage'||!url.password||
 redis.hostname!=='127.0.0.1'||redis.port!=='16379'||redis.pathname!=='/1'||
 off.some(k=>env[k]==='true')||
 (env.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY))||
 env.WEB_PUSH_ENABLED==='true')fail('FINANCIAL_OR_DATABASE_ISOLATION');
const client=new Client({connectionString:env.DATABASE_URL,connectionTimeoutMillis:4000,
 application_name:'tala_web_push_stage_migration_gate'});
await client.connect();
try{
 const identity=(await client.query(`SELECT current_database() AS db,current_user AS usr,
 current_setting('server_version_num')::int AS ver, inet_server_port() AS port,
 pg_is_in_recovery() AS recovery`)).rows[0];
 if(identity.db!=='tala_node_stage'||identity.usr!=='tala_node_stage'||
  identity.ver<150000||identity.ver>=160000||identity.port!==15435||
  identity.recovery===true)fail('POSTGRES15_IDENTITY');
 const rows=(await client.query(`SELECT migration_name,finished_at,rolled_back_at
 FROM "_prisma_migrations"`)).rows;
 const active=rows.filter(x=>x.finished_at&&!x.rolled_back_at).map(x=>x.migration_name);
 const failed=rows.filter(x=>!x.finished_at&&!x.rolled_back_at);
 if(failed.length||new Set(active).size!==active.length)fail('FAILED_OR_DUPLICATE_MIGRATIONS');
 const source=readdirSync('prisma/migrations').filter(name=>
  statSync('prisma/migrations/'+name).isDirectory()).sort();
 const missing=source.filter(name=>!active.includes(name));
 const unexpected=active.filter(name=>!source.includes(name));
 if(missing.length!==1||missing[0]!=='20261026043000_web_push_delivery'||
  unexpected.length)fail('PENDING_MIGRATIONS_NOT_EXACTLY_WEB_PUSH');
 const check=(await client.query(`SELECT to_regclass('public.web_push_deliveries') IS NOT NULL AS present`)).rows[0];
 if(check.present)fail('WEB_PUSH_TABLE_ALREADY_PRESENT');
 console.log('PUSH_DB_POSTGRES15_STAGE_IDENTITY=PASS');
 console.log('PUSH_DB_EXISTING_MIGRATIONS_APPLIED='+active.length);
 console.log('PUSH_DB_PENDING_EXACTLY_WEB_PUSH=PASS');
 console.log('PUSH_DB_STAGE_FINANCIAL_FLAGS=OFF');
}finally{await client.end()}
JS
echo 'PUSH_DB_MIGRATION_GATE=PASS'
if [[ "$MODE" == '--plan' ]]; then
 echo 'PUSH_DB_PLAN_ONLY=PASS'
 echo 'PUSH_DB_NO_WRITES=YES'
 exit 0
fi

# An explicit --apply first creates a complete verifiable CUSTOM archive of
# ONLY PostgreSQL staging. The backup is private and has no LIVE credentials.
[[ ! -L "$BACKUP_ROOT" ]] || { echo 'PUSH_DB_ABORT=BACKUP_DIRECTORY_SYMLINK'; exit 1; }
if [[ ! -e "$BACKUP_ROOT" ]]; then
 mkdir -m 700 -- "$BACKUP_ROOT"
fi
[[ -d "$BACKUP_ROOT" && "$(stat -c '%u' "$BACKUP_ROOT")" == "$(id -u)" &&
   "$(stat -c '%a' "$BACKUP_ROOT")" == "700" ]] || {
 echo 'PUSH_DB_ABORT=BACKUP_DIRECTORY_PERMISSIONS'; exit 1;
}
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_ROOT/tala_node_stage_pre_web_push_${STAMP}_$$.dump"
# Node constructs arguments, never emits stage database passwords in shell/log.
stage_node --input-type=module - "$BACKUP" <<'JS'
import {spawnSync} from 'node:child_process';
import {statSync} from 'node:fs';
const dest=process.argv[2];
const url=new URL(process.env.DATABASE_URL);
const env={...process.env,PGPASSWORD:decodeURIComponent(url.password)};
const backup=spawnSync('pg_dump',[
 '-h','127.0.0.1','-p','15435','-U','tala_node_stage','-d','tala_node_stage',
 '-Fc','--no-owner','--no-privileges','-f',dest],{env,encoding:'utf8',timeout:180000});
if(backup.status!==0||statSync(dest).size<4096)
 throw Error('PUSH_DB_BACKUP_FAILED_BEFORE_MIGRATION');
const verify=spawnSync('pg_restore',['--list',dest],{encoding:'utf8',timeout:30000});
if(verify.status!==0||!verify.stdout.includes('TABLE DATA'))
 throw Error('PUSH_DB_ARCHIVE_VERIFICATION_FAILED');
console.log('PUSH_DB_STAGE_PGDUMP_VERIFIED=PASS');
JS
chmod 600 "$BACKUP"
echo "PUSH_DB_PRIVATE_STAGE_BACKUP=$BACKUP"
echo 'PUSH_DB_APPLY_ONLY_STAGE=START'
stage_node ./node_modules/prisma/build/index.js migrate deploy
stage_node ./node_modules/prisma/build/index.js migrate status
stage_node --input-type=module - <<'JS'
import {Client} from 'pg';
const client=new Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try{
 const name='20261026043000_web_push_delivery';
 const q=await client.query(`SELECT count(*)::int AS n FROM "_prisma_migrations"
 WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,[name]);
 const r=await client.query(`SELECT to_regclass('public.web_push_deliveries') IS NOT NULL AS present,
 (SELECT count(*)::int FROM web_push_deliveries) AS rows`);
 if(q.rows[0].n!==1||!r.rows[0].present||r.rows[0].rows!==0)
  throw Error('PUSH_DB_STAGE_POST_MIGRATION_HOLD');
 console.log('PUSH_DB_WEB_PUSH_LEDGER_APPLIED=PASS');
}finally{await client.end()}
JS
echo 'PUSH_DB_STAGE_MIGRATION=PASS'
echo 'PUSH_DB_LIVE_AND_PM2=UNMODIFIED'
