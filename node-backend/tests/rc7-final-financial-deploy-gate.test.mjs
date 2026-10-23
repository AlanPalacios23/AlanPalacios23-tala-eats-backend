import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyRc7FinancialData} from '../dist/finance/rc7-financial-gate-core.js';

const none=()=>({
 stuckIntentReservations:0,overdueUnpaidCardOrders:0,
 unreconciledSignedWebhooks:0,paidOrdersMissingTrustedReceipt:0,
 cardCashMisclassification:0,paidOrderSampleTruncated:0,
});
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('financial data gate passes only with all counts exactly zero',()=>{
 assert.equal(classifyRc7FinancialData(none()),'STAGE_FINANCIAL_DATA_PASS');
 for(const key of Object.keys(none())){
   assert.equal(classifyRc7FinancialData({...none(),[key]:1}),
     'STAGE_FINANCIAL_DATA_HOLD',key);
 }
});
test('unknown or corrupted scan metrics always fail closed',()=>{
 for(const value of [-1,NaN,Infinity,1.5,undefined,null]){
   assert.equal(classifyRc7FinancialData({...none(),stuckIntentReservations:value}),
     'STAGE_FINANCIAL_DATA_HOLD',String(value));
 }
});
test('read-only preflight has bounded DB queries and no payment writes',()=>{
 const code=read('src/finance/rc7-financial-gate.ts');
 assert.match(code,/marketOrder\.count/);
 assert.match(code,/stripeWebhookEvent\.count/);
 assert.match(code,/stageFinancialLedgerEntry\.findMany/);
 assert.match(code,/take:5001/);
 assert.match(code,/paidOrderSampleTruncated/);
 assert.match(code,/await db\.\$disconnect\(\)/);
 assert.match(code,/issues:Object\.entries/);
 assert.doesNotMatch(code,/\.create\(|\.update\(|\.delete\(|\.upsert\(/);
 assert.doesNotMatch(code,/paymentIntents\.create|paymentIntents\.cancel|transfers\.create|payouts\.create/);
});
test('already captured TEST PaymentIntents cannot be confirmed again by mobile',()=>{
 const gateway=read('src/stage-stripe-test.ts');
 assert.match(gateway,/\['requires_payment_method','requires_confirmation','requires_action'\]\.includes\(intent\.status\)/);
 assert.match(gateway,/Stripe TEST no permite reabrir este intento/);
});
test('financial snapshots still prohibit LIVE eligibility and card-as-cash',()=>{
 const source=read('src/finance/recipient-readiness.ts');
 assert.match(source,/available_for_withdrawal:'0.00'/);
 assert.match(source,/STRIPE_ORDER_CANNOT_CONTAIN_CASH_COLLECTED/);
 assert.match(source,/held_for_review_orders/);
});
