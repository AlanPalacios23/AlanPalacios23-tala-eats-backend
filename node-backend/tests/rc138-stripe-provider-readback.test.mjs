import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditStripeCapturedBalance} from '../src/finance/stripe-provider-readback.mjs';

const order={paymentProviderId:'pi_rc138ABC',total:'253.00',
 paymentProcessingFee:'15.51'};
const pi={id:'pi_rc138ABC',livemode:true,status:'succeeded',
 currency:'mxn',amount:25300,amount_received:25300,
 latest_charge:'ch_rc138ABC'};
const charge={id:'ch_rc138ABC',livemode:true,paid:true,captured:true,
 currency:'mxn',payment_intent:'pi_rc138ABC',
 amount_captured:25300,balance_transaction:'txn_rc138ABC'};
const tx={id:'txn_rc138ABC',currency:'mxn',source:'ch_rc138ABC',
 amount:25300,fee:1551,net:23749};
const check=(patch={})=>auditStripeCapturedBalance(
 {...order,...patch.order},{...pi,...patch.pi},
 {...charge,...patch.charge},{...tx,...patch.tx});

test('RC13.8 provider readback compares exact $253, $15.51 fee, $237.49 net',()=>{
 const r=check();
 assert.equal(r.pass,true);
 assert.equal(r.providerGrossMinor,25300);
 assert.equal(r.providerFeeMinor,1551);
 assert.equal(r.providerNetMinor,23749);
 assert.equal(r.bankSettled,false);
});

test('RC13.8 mismatch in recorded Stripe fee is an accounting HOLD',()=>{
 const r=check({order:{paymentProcessingFee:'0.00'}});
 assert.equal(r.pass,false);
 assert.ok(r.findings.includes('PROCESSING_FEE_NOT_RECONCILED'));
});

test('RC13.8 balance transaction mismatch and missing tx never pass',()=>{
 const wrong=check({tx:{net:23748}});
 assert.equal(wrong.pass,false);
 assert.ok(wrong.findings.includes('BALANCE_TRANSACTION_MISMATCH'));
 assert.equal(auditStripeCapturedBalance(order,pi,charge,null).pass,false);
});

test('RC13.8 wrong charge, wrong mode, wrong capture or wrong PI hold',()=>{
 assert.equal(check({charge:{paid:false}}).pass,false);
 assert.equal(check({pi:{livemode:false}}).pass,false);
 assert.equal(check({tx:{amount:25000}}).pass,false);
 assert.equal(check({charge:{payment_intent:'pi_different'}}).pass,false);
 assert.equal(check({order:{total:'253.001'}}).pass,false);
 assert.equal(check({tx:{fee:-1}}).pass,false);
});

test('RC13.8 live auditor checks real provider fee with GET-only SDK',()=>{
 const s=readFileSync(new URL('../scripts/rc114-kali-live-stripe-pickup-audit.mjs',import.meta.url),'utf8');
 assert.match(s,/provider\\.charges\\.retrieve/);
 assert.match(s,/provider\\.balanceTransactions\\.retrieve/);
 assert.match(s,/auditStripeCapturedBalance/);
 assert.doesNotMatch(s,/provider\\.(?:transfers|payouts|refunds|paymentIntents)\\.create\\(/);
});
