import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const file=new URL('../scripts/rc91-kali-onboarding-two-pm2-cutover.sh',import.meta.url);
const s=readFileSync(file,'utf8');
test('RC9.1 future-payee onboarding rollout preserves Stripe and signed payout lock',()=>{
 const r=spawnSync('bash',['-n',file.pathname],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 for(const token of ['I_APPROVE_RC91_ONBOARDING_TWO_PM2_ONLY','561c842c583940f5b01f650c8dbe3c26a770d85f','RC91_CUTOVER_ROLLBACK=ATTEMPTED_CHECK_API_AND_ORDERS','RC91_CONNECT_WITHDRAWALS=STILL_LOCKED','pm2_identity "$WORK"','ready'])assert.ok(s.includes(token),token);
 assert.doesNotMatch(s,/prisma migrate deploy|payouts\.create|transfers\.create/);
});
test('RC9.1 onboarding rollout denies unattended apply without approval',()=>{
 const r=spawnSync('bash',[file.pathname,'--apply','0'.repeat(40)],{encoding:'utf8',env:{HOME:'/tmp',PATH:'/usr/bin:/bin'}});
 assert.notEqual(r.status,0);
 assert.match(r.stdout+r.stderr,/RC91_CUTOVER_ABORT/);
});
