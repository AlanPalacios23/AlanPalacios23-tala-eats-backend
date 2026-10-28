import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const file=new URL('../scripts/rc9-kali-live-two-pm2-cutover.sh',import.meta.url);
const s=readFileSync(file,'utf8');
test('RC9 LIVE PM2 deployment script is syntax valid, pinned and rollback guarded',()=>{
 const check=spawnSync('bash',['-n',file.pathname],{encoding:'utf8'});
 assert.equal(check.status,0,check.stderr);
 for(const t of ['09ee09c8364382597c8e9ab1573a5b417884d47e','561c842c583940f5b01f650c8dbe3c26a770d85f','I_APPROVE_RC9_EXISTING_LIVE_TWO_PM2_CUTOVER','RC9_CONNECT_WITHDRAWALS=STILL_LOCKED','RC9_CUTOVER_ROLLBACK=ATTEMPTED_CHECK_API_AND_ORDERS','rc9-kali-live-treasury-migration.sh --verify'])assert.ok(s.includes(t),t);
 assert.doesNotMatch(s,/prisma migrate deploy|stripe\\.transfers\\.create|stripe\\.payouts\\.create|DROP DATABASE|DROP TABLE/);
});
test('RC9 LIVE PM2 deployment refuses any apply without explicit service user and approval',()=>{
 for(const a of [[],['--apply','0'.repeat(40)],['--apply','badsha','I_APPROVE_RC9_EXISTING_LIVE_TWO_PM2_CUTOVER']]){
  const r=spawnSync('bash',[file.pathname,...a],{encoding:'utf8',env:{HOME:'/tmp',PATH:'/usr/bin:/bin'}});
  assert.notEqual(r.status,0);
  assert.match(r.stdout+r.stderr,/RC9_CUTOVER_ABORT/);
 }
});
