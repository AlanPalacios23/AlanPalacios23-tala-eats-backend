import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {previewRecipientOrders} from '../dist/finance/recipient-readiness.js';

const good=(id,more={})=>({
 id,status:'delivered',paymentStatus:'paid',
 paymentMethod:'cash',orderType:'pickup',
 restaurantPayout:'85.00',driverEarning:'0.00',
 tip:'10.00',cashCollected:'117.00',...more,
});
test('cash income is NEVER Stripe balance even when pickup is delivered',()=>{
 const v=previewRecipientOrders('restaurant',[good(1)],true);
 assert.equal(v.pending_review_cash,'85.00');
 assert.equal(v.pending_review_stripe_test,'0.00');
 assert.equal(v.available_for_withdrawal,'0.00');
 assert.equal(v.eligible,false);
 assert.equal(v.connect_capability_verified,false);
 assert.equal(v.reconciliation_hold,true);
});
test('Stripe TEST is not transferable LIVE or withdrawable',()=>{
 const v=previewRecipientOrders('restaurant',[good(2,{
  paymentMethod:'stripe',cashCollected:'0.00',
 })],true);
 assert.equal(v.pending_review_stripe_test,'85.00');
 assert.equal(v.available_for_withdrawal,'0.00');
 assert.equal(v.eligible,false);
});
test('driver earns stage delivery fee plus tip, but cash is not Connect money',()=>{
 const v=previewRecipientOrders('driver',[good(3,{
  orderType:'delivery',driverEarning:'32.00',
  restaurantPayout:'85.00',cashCollected:'161.50',
  tip:'12.00',
 })],true);
 assert.equal(v.pending_review_cash,'44.00');
 assert.equal(v.available_for_withdrawal,'0.00');
});
test('unpaid, canceled or unsupported delivered orders excluded',()=>{
 const v=previewRecipientOrders('restaurant',[
  good(1,{paymentStatus:'pending'}),
  good(2,{status:'cancelled'}),
  good(3,{paymentMethod:'stripe',orderType:'delivery'}),
  good(4,{paymentMethod:'wallet'}),
 ],true);
 assert.equal(v.pending_review_cash,'0.00');
 assert.equal(v.pending_review_stripe_test,'0.00');
});
test('anomalous card cash capture, duplicate IDs or incomplete pages fail closed',()=>{
 assert.throws(()=>previewRecipientOrders('restaurant',[
  good(1,{paymentMethod:'stripe'}),
 ],true),/STRIPE_ORDER_CANNOT_CONTAIN_CASH_COLLECTED/);
 assert.throws(()=>previewRecipientOrders('restaurant',[good(1),good(1)],true),
  /DUPLICATE_OR_INVALID_ORDER_SNAPSHOT/);
 assert.throws(()=>previewRecipientOrders('driver',[good(1)],false),
  /RECIPIENT_PREVIEW_REQUIRES_COMPLETE_PAGINATION/);
});
test('many exact-cent records conserve amounts without floating point',()=>{
 const orders=Array.from({length:1000},(_,i)=>good(i+1,{
  restaurantPayout:'0.01',tip:'0.00',cashCollected:'0.01',
 }));
 const v=previewRecipientOrders('restaurant',orders,true);
 assert.equal(v.pending_review_cash,'10.00');
 assert.equal(v.available_for_withdrawal,'0.00');
 assert.equal(v.sampled_orders,1000);
});
test('routes preserve authorization and never enable Stripe Connect payout writes',()=>{
 const src=readFileSync(new URL('../src/parity/routes.ts',import.meta.url),'utf8');
 assert.match(src,/await payee\(req\)/);
 assert.match(src,/account_api:'v2'/);
 assert.match(src,/recipient_transfer_capability_active:false/);
 assert.match(src,/withdrawals_enabled:false/);
 assert.match(src,/available_for_withdrawal:'0.00'/);
 assert.match(src,/previewRecipientOrders/);
 assert.match(src,/financialUnavailable\('withdrawal_requires_verified_ledger_and_provider'\)/);
 assert.match(src,/financialUnavailable\('stripe_split_settlement'\)/);
});
