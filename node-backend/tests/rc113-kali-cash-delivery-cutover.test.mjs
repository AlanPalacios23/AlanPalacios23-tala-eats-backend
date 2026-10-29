import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const url=new URL('../scripts/rc113-kali-live-cash-delivery-cutover.sh',import.meta.url);
const source=readFileSync(url,'utf8');
test('RC113 code-only production cutover parses and refuses cash/card release flags',()=>{
 const syntax=spawnSync('bash',['-n',url.pathname],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
 for(const token of [
  'I_APPROVE_RC113_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY',
  'I_APPROVE_RC113_ROLLBACK_PREVIOUS_TWO_PM2',
  'RC113_ABORT=BASELINE_SHA_CHANGED','RC113_AUTOMATIC_ROLLBACK=START',
  'RC113_CASH_CARD_DISPATCH_PAYOUTS=LOCKED_PENDING_RELEASE',
  "'LIVE_DELIVERY_CASH_CHECKOUT_ENABLED','LIVE_DELIVERY_CASH_DISPATCH_ENABLED'",
  "'LIVE_DELIVERY_CASH_RELEASE_APPROVED'",
  'RC113_PLAN=PASS_READ_ONLY',
  'RC113_LIVE_CASH_DELIVERY_CODE_DEPLOY=PASS',
  'RC113_LIVE_CASH_DELIVERY_CODE_VERIFY=PASS',
 ])assert.ok(source.includes(token),token);
 assert.doesNotMatch(source,/prisma migrate deploy|ALTER TABLE|stripe\.transfers\.create/);
});
test('RC113 refuses unapproved deploy, root, invalid SHA or release token',()=>{
 for(const args of [
  [],['--apply'],['--plan','bad'],
  ['--apply','0'.repeat(40),'1'.repeat(40),'NO_APPROVAL'],
  ['--rollback','0'.repeat(40)]
 ]){
  const out=spawnSync('bash',[url.pathname,...args],{
   encoding:'utf8',env:{HOME:'/tmp',USER:'nobody',PATH:'/usr/bin:/bin'}
  });
  assert.notEqual(out.status,0,args.join(' '));
  assert.match(out.stdout+out.stderr,/RC113_ABORT=/);
 }
});
