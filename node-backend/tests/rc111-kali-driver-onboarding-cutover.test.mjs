import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const url=new URL('../scripts/rc111-kali-driver-onboarding-live-cutover.sh',import.meta.url);
const src=readFileSync(url,'utf8');
test('RC11.1 LIVE cutover validates Bash, preserves baseline SHA and rollback',()=>{
 const syntax=spawnSync('bash',['-n',url.pathname],{encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);
 for(const guard of [
   'I_APPROVE_RC111_LIVE_TWO_PM2_DRIVER_ONBOARDING_ONLY',
   'I_APPROVE_RC111_ROLLBACK_PREVIOUS_TWO_PM2',
   'RC111_CURRENT_LIVE_SHA=',
   'RC111_TARGET_SHA=',
   'RC111_PLAN=PASS_READ_ONLY',
   'RC111_ABORT=BASELINE_SHA_CHANGED',
   'RC111_AUTOMATIC_ROLLBACK=START',
   'RC111_LIVE_DRIVER_ONBOARDING_DEPLOY=PASS',
   'RC111_LIVE_FINANCIAL_AND_DELIVERY_GUARDS=PASS',
   'RC111_LIVE_DRIVER_SIGNUP_CAPABILITIES=PASS_THREE_ORIGINS',
   'RC111_ANONYMOUS_ONBOARDING_READS=BLOCKED',
   'RC111_DISPATCH_CARD_PAYOUTS=LOCKED',
   'TALA_LIVE_ENV_FILE="$ENV"',
   'rc110-kali-live-driver-plate-migration.mjs --verify',
   "await r.del('tala:node:live:worker:heartbeat')",
 ])assert.ok(src.includes(guard),guard);
 for(const forbidden of [
  'prisma migrate deploy','prisma migrate reset','DROP TABLE',
  'stripe.transfers.create','systemctl restart cloudflared',
  'systemctl restart talaeats-repartidores-pwa'
 ])assert.ok(!src.includes(forbidden),forbidden);
});
test('RC11.1 cutover refuses unapproved, root and incomplete commands',()=>{
 for(const args of [[],['--apply'],['--rollback'],['--plan','bad'],['--apply','0'.repeat(40),'1'.repeat(40),'NO_APPROVAL']]){
  const run=spawnSync('bash',[url.pathname,...args],{encoding:'utf8',env:{
   PATH:'/usr/bin:/bin',HOME:'/tmp',USER:'nobody'
  }});
  assert.notEqual(run.status,0,args.join(' '));
  assert.match(run.stdout+run.stderr,/RC111_ABORT=/);
 }
});
