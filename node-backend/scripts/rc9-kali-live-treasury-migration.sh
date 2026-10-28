#!/usr/bin/env bash
# RC9 additive LIVE treasury migration: explicitly approved, no Stripe/PM2 writes.
set -Eeuo pipefail
set +x
umask 077
MODE="\${1:-}"; SHA="\${2:-}"; APPROVAL="\${3:-}"
if [[ ! "$MODE" =~ ^--(plan|apply|verify)$ || ! "$SHA" =~ ^[0-9a-f]{40}$ ]];then
 echo 'RC9_SCHEMA_ABORT=MODE_OR_SHA';exit 2
fi
if [[ "$MODE" == --apply && ( "$#" != 3 ||
 "$APPROVAL" != I_APPROVE_RC9_TREASURY_SCHEMA_ONLY ) ]];then
 echo 'RC9_SCHEMA_ABORT=EXPLICIT_APPROVAL_REQUIRED';exit 2
fi
[[ "$(id -un)" == tala-node-stage && "$(id -u)" != 0 &&
 "$HOME" == /home/tala-node-stage ]] || {
 echo 'RC9_SCHEMA_ABORT=SERVICE_USER_ONLY';exit 1;
}
export PATH="$HOME/.local/node24/bin:$HOME/.local/bin:$PATH"
ROOT="$HOME/tala-node-releases/$SHA"
WORK="$ROOT/node-backend"
ENV="$HOME/.config/talaeats-node-live.env"
[[ -d "$WORK" && ! -L "$WORK" && ! -L "$ROOT" &&
 "$(cd "$(dirname "$0")/.." && pwd -P)" == "$WORK" &&
 "$(git -C "$ROOT" rev-parse HEAD)" == "$SHA" &&
 -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" &&
 -f "$ENV" && ! -L "$ENV" &&
 "$(stat -c '%a' "$ENV")" == 600 &&
 "$(stat -c '%u' "$ENV")" == "$(id -u)" &&
 -f "$WORK/dist/config.js" &&
 -f "$WORK/node_modules/prisma/build/index.js" ]] || {
 echo 'RC9_SCHEMA_ABORT=SOURCE_OR_ENV_INVALID';exit 1;
}
cd "$WORK"
get_state(){
 node --env-file="$ENV" --input-type=module <<'JS'
import {readdirSync,existsSync} from 'node:fs';
import pg from 'pg';
import {config} from './dist/config.js';
const target='20261028_treasury_v1_restaurant_driver';
const u=new URL(config.DATABASE_URL);
if(config.NODE_ENV!=='production'||u.hostname!=='127.0.0.1'||
 u.port!=='15445'||u.pathname!=='/tala_node_live'||
 config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
 config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false')
 throw Error('RC9_SCHEMA_ABORT=LIVE_ENDPOINT_OR_FLAGS');
const dirs=readdirSync('prisma/migrations',{withFileTypes:true})
 .filter(x=>x.isDirectory()&&existsSync('prisma/migrations/'+x.name+'/migration.sql'))
 .map(x=>x.name);
if(!dirs.includes(target))throw Error('RC9_SCHEMA_ABORT=NO_TARGET_MIGRATION');
const pool=new pg.Pool({connectionString:config.DATABASE_URL,max:1,
 connectionTimeoutMillis:5000,statement_timeout:15000});
try{
 const r=await pool.query('SELECT migration_name,finished_at,rolled_back_at FROM public._prisma_migrations');
 if(r.rows.some(x=>!x.finished_at&&!x.rolled_back_at))
  throw Error('RC9_SCHEMA_ABORT=FAILED_PRISMA_JOURNAL');
 const applied=new Set(r.rows.filter(x=>x.finished_at&&!x.rolled_back_at).map(x=>x.migration_name));
 const missing=dirs.filter(x=>!applied.has(x));
 if([...applied].some(x=>!dirs.includes(x))||missing.length!==1||missing[0]!==target)
  throw Error('RC9_SCHEMA_ABORT=NOT_EXACTLY_TREASURY_PENDING');
 const tab=await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'tala_live_treasury_%'");
 if(tab.rows[0].n!==0)throw Error('RC9_SCHEMA_ABORT=PARTIALLY_APPLIED');
 console.log('RC9_ONLY_PENDING_MIGRATION=TREASURY');
}finally{await pool.end();}
JS
}
verify_state(){
 node --env-file="$ENV" --input-type=module <<'JS'
import pg from 'pg';import {config} from './dist/config.js';
const pool=new pg.Pool({connectionString:config.DATABASE_URL,max:1});
try{
 const r=await pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'tala_live_treasury_%'");
 const m=await pool.query("SELECT count(*)::int n FROM public._prisma_migrations WHERE migration_name='20261028_treasury_v1_restaurant_driver' AND finished_at IS NOT NULL AND rolled_back_at IS NULL");
 if(r.rows[0].n!==6||m.rows[0].n!==1)throw Error('RC9_SCHEMA_ABORT=VERIFY_FAILED');
 console.log('RC9_LIVE_TREASURY_SCHEMA=PASS');
}finally{await pool.end();}
JS
}
if [[ "$MODE" == --verify ]];then
 verify_state
 exit 0
fi
get_state
if [[ "$MODE" == --plan ]];then
 echo 'RC9_SCHEMA_PLAN=PASS_READ_ONLY'
 exit 0
fi
[[ "\${RC9_RESTORE_ATTESTED:-}" == 'I_VERIFIED_RC9_RESTORE_AND_SHADOW_MIGRATION' ]] || {
 echo 'RC9_SCHEMA_ABORT=RESTORE_ATTESTATION_REQUIRED';exit 1;
}
node --env-file="$ENV" ./node_modules/prisma/build/index.js migrate deploy
verify_state
echo 'RC9_LIVE_TREASURY_MIGRATION=PASS'
echo 'RC9_STRIPE_AND_PM2=UNCHANGED'
