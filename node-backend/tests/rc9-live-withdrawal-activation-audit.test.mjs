import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const file=new URL('../scripts/rc9-live-withdrawal-activation-audit.mjs',import.meta.url);
const s=readFileSync(file,'utf8');
test('RC9 LIVE audit contains no money writes or provider mutations',()=>{
 const c=spawnSync('node',['--check',file.pathname],{encoding:'utf8'});
 assert.equal(c.status,0,c.stderr);
 for(const required of ['BEGIN READ ONLY','tala_node_live','15445','NO_APPROVED_RESTAURANT_WITH_MANUAL_CONNECT','NO_APPROVED_DRIVER_WITH_MANUAL_CONNECT','TWO_DISTINCT_MFA_ADMINS_REQUIRED','RC9_LIVE_PAYOUT_ACTIVATED=NO','stripe.accounts.list','stripe.webhookEndpoints.list','stripe.accounts.listExternalAccounts'])assert.ok(s.includes(required),required);
 for(const forbidden of ['stripe.payouts.create','stripe.transfers.create','stripe.accounts.update','pool.query(\'UPDATE', 'CREATE TABLE','DROP DATABASE','migrate deploy'])assert.ok(!s.includes(forbidden),forbidden);
 assert.doesNotMatch(s,/Stripe\-Account.*POST|process\.env\.STRIPE_SECRET_KEY\s*=/);
});
