import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTransferProposal} from '../dist/live/transfer-planning.js';

const base={
 orderId:15,kind:'restaurant',payeeId:3,amountMinor:17000,
 stripeAccountId:'acct_RESTAURANT1',approvedByOwner:true,
 connectReady:true,chargeId:'ch_MONEY15',capturedAmountMinor:21400,
 alreadyTransferred:false,delivered:true,proof:true,refundedMinor:0,
 openCases:0,sourceMode:'stripe'
};
test('recipient-specific transfer instruction tied to verified source charge, never executed',()=>{
 const r=buildTransferProposal(base);
 assert.equal(r.eligible,true);
 assert.equal(r.destination,'acct_RESTAURANT1');
 assert.equal(r.source_transaction,'ch_MONEY15');
 assert.equal(r.transfer_group,'TALA-ORDER-15');
 assert.equal(r.idempotency_key,'tala-rc85:15:restaurant:3');
 assert.equal(r.transfer_executed,false);
 assert.equal(r.bank_payout_confirmed,false);
 const driver=buildTransferProposal({...base,kind:'driver',payeeId:9,
   amountMinor:3200,stripeAccountId:'acct_DRIVER9'});
 assert.equal(driver.eligible,true);
 assert.notEqual(driver.idempotency_key,r.idempotency_key);
 assert.equal(driver.amount_minor,3200);
});
test('cash, refunds, disputes, invalid capture, unverified Connect and repeats block transfer',()=>{
 for(const [patch,reason] of [
  [{sourceMode:'cash'},'NO_STRIPE_CHARGE_FOR_CASH'],
  [{refundedMinor:200},'REFUND_DISPUTE_HOLD'],
  [{openCases:1},'REFUND_DISPUTE_HOLD'],
  [{chargeId:null},'SIGNED_SOURCE_CHARGE_MISSING'],
  [{approvedByOwner:false},'CONNECT_NOT_READY'],
  [{connectReady:false},'CONNECT_NOT_READY'],
  [{capturedAmountMinor:1},'SOURCE_CHARGE_TOO_SMALL'],
  [{alreadyTransferred:true},'TRANSFER_ALREADY_RECORDED'],
  [{proof:false},'FULFILLMENT_NOT_VERIFIED'],
  [{delivered:false},'FULFILLMENT_NOT_VERIFIED'],
 ]){
  const r=buildTransferProposal({...base,...patch});
  assert.equal(r.eligible,false,JSON.stringify(patch));
  assert.ok(r.blockers.includes(reason),reason);
  assert.equal(r.transfer_executed,false);
 }
});
test('driver finance routes never perform Stripe monetary mutations',()=>{
 const src=readFileSync(new URL('../src/live/payee-finance-router.ts',import.meta.url),'utf8');
 for(const route of [
  '/driver/finance/connect/confirm','/driver/finance/connect/status',
  '/driver/finance/connect/onboarding-link','/driver/finance/earnings',
  '/owner/finance/earnings/:rid',
  '/admin/finance/orders/:orderId/prepare-payables',
  '/admin/finance/orders/:orderId/transfer-preview',
  '/finance/cash/:orderId/submit','/admin/finance/cash/:orderId/review',
 ])assert.ok(src.includes(route),route);
 assert.match(src,/delivered_at FROM orders WHERE id=\$1 FOR UPDATE/);
 assert.match(src,/pin_verified=true/);
 assert.match(src,/ON CONFLICT\(order_id,payee_kind\) DO NOTHING/);
 assert.match(src,/PAYEE_ALLOCATION_CONFLICT/);
 assert.match(src,/TRANSFER_PREVIEW_UNAVAILABLE/);
 assert.doesNotMatch(src,/stripe\.transfers\.create\(|stripe\.payouts\.create\(/);
});
