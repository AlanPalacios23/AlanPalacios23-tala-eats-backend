import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessLiveRecoveryCounters,recoveryCounterKeys} from
 '../src/finance/rc116-recovery-readiness.mjs';
const zero=()=>Object.fromEntries(recoveryCounterKeys.map(k=>[k,0]));
const proofs={hasObservedRealOrders:true,backupRestoreProven:true,
 alertDeliveryProven:true};
test('RC11.6 empty counters with external proof can pass audit but never auto-launch',()=>{
 const r=assessLiveRecoveryCounters(zero(),proofs);
 assert.deepEqual(r.reasons,[]);
 assert.equal(r.pass,true);
 assert.equal(r.launchApproved,false);
 assert.equal(r.refundsFullyAutomatic,false);
});
test('RC11.6 every critical financial risk blocks readiness',()=>{
 for(const key of recoveryCounterKeys){
  const c=zero();c[key]=1;
  const r=assessLiveRecoveryCounters(c,proofs);
  assert.equal(r.pass,false,key);
  assert.ok(r.reasons.includes('PENDING_'+key.toUpperCase()),key);
 }
});
test('RC11.6 malformed and unbounded financial counters fail closed',()=>{
 for(const v of [-1,NaN,Infinity,1.5,'1',1000000001]){
  const c=zero();c.staleSignedEvents=v;
  assert.equal(assessLiveRecoveryCounters(c,proofs).pass,false);
 }
 assert.equal(assessLiveRecoveryCounters({},proofs).pass,false);
 assert.equal(assessLiveRecoveryCounters(null,proofs).pass,false);
});
test('RC11.6 requires real evidence for backup, alert and commercial operations',()=>{
 const r=assessLiveRecoveryCounters(zero(),{
  hasObservedRealOrders:false,backupRestoreProven:false,
  alertDeliveryProven:false});
 assert.deepEqual(r.reasons,[
  'ALERT_RECEIPT_PROOF_MISSING',
  'NO_REAL_OPERATIONS_EVIDENCE',
  'RESTORE_PROOF_MISSING',
 ]);
 assert.equal(r.pass,false);
});
test('RC11.6 SQL audit only counts real PostgreSQL incidents; script never mutates money',()=>{
 const script=readFileSync(new URL('../scripts/rc116-kali-live-financial-recovery-audit.mjs',
  import.meta.url),'utf8');
 const sql=readFileSync(new URL('../scripts/sql/rc116-live-financial-recovery.sql',
  import.meta.url),'utf8');
 for(const p of ['stripe_webhook_events','tala_live_financial_cases',
  'financial_ledger_entries','inventory_restored_at',
  'delivery_proofs','cash_collected','event_outbox',
  'tala_live_treasury_withdrawals']){
  assert.ok(sql.includes(p),p);
 }
 for(const p of ['RELEASE_SHA_MISMATCH','LIVE_ENV_PERMISSIONS',
   'NOT_ISOLATED_LIVE_DATABASE',
   'backupRestoreProven:false','alertDeliveryProven:false',
   'RC116_REFUNDS_AUTO_RESOLVED=NO',
   'RC116_DB_WRITES=NONE','RC116_STRIPE_WRITES=NONE']){
  assert.ok(script.includes(p),p);
 }
 assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/i);
 assert.doesNotMatch(script,/(?:refunds|transfers|payouts|paymentIntents)\.create\(/);
});
