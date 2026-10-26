import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sourcePath=fileURLToPath(new URL('../scripts/rc813-web-push-stage-migration.sh',import.meta.url));
const source=readFileSync(sourcePath,'utf8');

test('Web Push stage migration script is valid Bash and limits all DB writes to an approved staging DB',()=>{
 const result=spawnSync('bash',['-n',sourcePath],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 for(const expected of [
  "MODE=\"${1:-}\"",
  'I_APPROVE_STAGE_PUSH_DB_ONLY',
  'PUSH_DB_PENDING_EXACTLY_WEB_PUSH=PASS',
  'PUSH_DB_STAGE_FINANCIAL_FLAGS=OFF',
  'PUSH_DB_NO_WRITES=YES',
  "SHA=\"398b531c4778a03975f30470f6979a38b9c8bb62\"",
  'pg_is_in_recovery()',
  "url.port!=='15435'",
  "url.pathname!=='/tala_node_stage'",
  "redis.pathname!=='/1'",
  "env.WEB_PUSH_ENABLED==='true'",
  "PUSH_DB_PRIVATE_STAGE_BACKUP=",
  "PUSH_DB_STAGE_PGDUMP_VERIFIED=PASS",
  "PUSH_DB_WEB_PUSH_LEDGER_APPLIED=PASS",
  'PUSH_DB_LIVE_AND_PM2=UNMODIFIED'
 ]) assert.ok(source.includes(expected),expected);
 assert.ok(source.indexOf('PUSH_DB_PLAN_ONLY=PASS')<source.indexOf('pg_dump'));
 assert.ok(source.indexOf('PUSH_DB_STAGE_PGDUMP_VERIFIED=PASS')<source.indexOf('migrate deploy'));
 assert.ok(source.indexOf('I_APPROVE_STAGE_PUSH_DB_ONLY')<source.indexOf('migrate deploy'));
 for(const banned of [
  'pg_restore --clean','pg_restore --dbname','drop database','DROP TABLE',
  'pm2 restart','pm2 start','pm2 delete','systemctl restart',
  'STRIPE_LIVE_ENABLED=true','WEB_PUSH_ENABLED=true','migrate reset'
 ]) assert.ok(!source.includes(banned),banned);
});
test('Web Push additive migration only adds private delivery ledger and indexes',()=>{
 const path=fileURLToPath(new URL('../prisma/migrations/20261026043000_web_push_delivery/migration.sql',import.meta.url));
 const migration=readFileSync(path,'utf8');
 assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS "web_push_deliveries"'));
 assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS'));
 assert.ok(!/\b(?:ALTER|DROP|TRUNCATE)\b\s+(?:TABLE|COLUMN)/i.test(migration));
 for(const table of ['stripe','order_payments','merchant_finance','drivers'])assert.ok(!migration.includes('ALTER TABLE "'+table));
});
