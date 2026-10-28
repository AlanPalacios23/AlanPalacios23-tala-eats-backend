import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const path=new URL('../scripts/rc9-kali-live-treasury-migration.sh',import.meta.url);
const source=readFileSync(path,'utf8');
test('RC9 live migration is syntax-valid, requires approval, and never touches PM2 or Stripe',()=>{
 const v=spawnSync('bash',['-n',path.pathname],{encoding:'utf8'});
 assert.equal(v.status,0,v.stderr);
 for(const required of ['I_APPROVE_RC9_TREASURY_SCHEMA_ONLY','I_VERIFIED_RC9_RESTORE_AND_SHADOW_MIGRATION','--plan','--verify',"migration_name='20261028_treasury_v1_restaurant_driver'",'prisma/build/index.js migrate deploy'])assert.ok(source.includes(required),required);
 for(const forbidden of [/pm2 (?:restart|start|reload|delete)/,/payouts\.create\(/,/transfers\.create\(/,/DROP TABLE/i,/DROP DATABASE/i,/prisma migrate reset/i])assert.doesNotMatch(source,forbidden);
});
test('RC9 live schema refuses apply without service account and exact SHA',()=>{
 for(const args of [[],['--apply','0'.repeat(40)],['--apply','notasha','I_APPROVE_RC9_TREASURY_SCHEMA_ONLY']]){
  const r=spawnSync('bash',[path.pathname,...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/tmp'}});
  assert.notEqual(r.status,0);
  assert.match(r.stdout+r.stderr,/RC9_SCHEMA_ABORT/);
 }
});
