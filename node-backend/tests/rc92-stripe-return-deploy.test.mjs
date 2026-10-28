import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const prep=new URL('../scripts/rc92-kali-prepare-release.sh',import.meta.url);
const cut=new URL('../scripts/rc92-kali-stripe-return-pm2-cutover.sh',import.meta.url);
test('RC9.2 Stripe return fixes preserve running 8f4ea97 and never execute payouts',()=>{
 for(const f of [prep,cut]){
  const v=spawnSync('bash',['-n',f.pathname],{encoding:'utf8'});
  assert.equal(v.status,0,v.stderr);
  const s=readFileSync(f,'utf8');
  assert.match(s,/8f4ea97c23ae8372d171f277f5615c719beed240/);
  assert.doesNotMatch(s,/prisma migrate deploy|stripe\.(?:transfers|payouts)\.create|DROP DATABASE/);
 }
 const src=readFileSync(cut,'utf8');
 assert.match(src,/I_APPROVE_RC92_STRIPE_RETURN_PM2_ONLY/);
 assert.match(src,/RC92_CUTOVER_ROLLBACK/);
 assert.match(src,/RC92_CONNECT_WITHDRAWALS=STILL_LOCKED/);
});
test('RC9.2 deployment cannot be applied by arbitrary account',()=>{
 for(const f of [prep,cut]){
  const r=spawnSync('bash',[f.pathname,'--apply','f'.repeat(40)],{
    encoding:'utf8',env:{HOME:'/tmp',PATH:'/usr/bin:/bin'},
  });
  assert.notEqual(r.status,0);
  assert.match(r.stdout+r.stderr,/RC92_ABORT|RC92_CUTOVER_ABORT|USAGE:/);
 }
});
