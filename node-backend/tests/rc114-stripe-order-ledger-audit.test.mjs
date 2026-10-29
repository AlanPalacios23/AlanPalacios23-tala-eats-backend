import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCapturedLiveStripePickup as audit}
 from '../src/finance/rc114-stripe-order-ledger-audit.mjs';
const order=()=>({
 id:412,orderType:'pickup',paymentMethod:'stripe',paymentStatus:'paid',status:'ready',
 paymentProvider:'stripe',paymentProviderId:'pi_Valid412',
 subtotal:'100.00',discount:'0.00',tip:'5.00',deliveryFee:'0.00',
 serviceFee:'7.00',platformCommission:'15.00',restaurantPayout:'90.00',
 driverEarning:'0.00',platformRevenue:'22.00',paymentProcessingFee:'4.00',
 total:'112.00',cashCollected:'0.00',refundedAmount:'0.00',
});
const webhook=()=>({id:'evt_412',type:'payment_intent.succeeded',status:'PROCESSED',
 stripeAccountId:null,objectId:'pi_Valid412'});
const origin=()=>({status:'received',
 metadataJson:JSON.stringify({source:'stripe_live_webhook',stripe_event_id:'evt_412'})});
const ledger=()=>[
 ['gmv','112.00','credit'],['restaurant_payable','90.00','credit'],
 ['platform_revenue','22.00','credit'],['payment_processing','4.00','debit'],
 ['contribution_margin','18.00','credit'],
].map(([account,amount,direction])=>({
 account,amount,direction,currency:'MXN',kind:'order_settlement',
 idempotencyKey:'order:412:live:ledger:'+account,
})).concat([{
 account:'stripe_live_collected',amount:'112.00',direction:'credit',
 currency:'MXN',kind:'stripe_live_payment',
 idempotencyKey:'order:412:stripe-live:collected',
}]);
const findings=(o=order(),l=ledger(),w=webhook(),r=origin())=>audit(o,l,w,r).findings;
test('RC11.4 verifies Stripe LIVE pickup DB/webhook posting, never calls it withdrawable',()=>{
 assert.deepEqual(findings(),[]);
 const out=audit(order(),ledger(),webhook(),origin());
 assert.equal(out.pass,true);
 assert.equal(out.withdrawable,false);
 assert.equal(out.remoteStripeAttested,false);
});
test('RC11.4 rejects missing remote proof and mismatched PI/event ID',()=>{
 assert.ok(findings(order(),ledger(),null).includes('DURABLE_SIGNED_RECEIPT_MISSING'));
 assert.ok(findings(order(),ledger(),{...webhook(),status:'RECEIVED'})
  .includes('DURABLE_SIGNED_RECEIPT_MISSING'));
 assert.ok(findings(order(),ledger(),{...webhook(),objectId:'pi_else'})
  .includes('DURABLE_SIGNED_RECEIPT_MISSING'));
 assert.ok(findings(order(),ledger(),webhook(),{...origin(),metadataJson:'{}'})
  .includes('ORDER_EVENT_WEBHOOK_BINDING_MISSING'));
});
test('RC11.4 rejects wrong capture amount, duplicated capture and illegal refund',()=>{
 const a=ledger();a.at(-1).amount='111.99';
 assert.ok(findings(order(),a).includes('ENTRY_AMOUNT_STRIPE_LIVE_COLLECTED'));
 const b=ledger();b.push({...b.at(-1)});
 assert.ok(findings(order(),b).includes('ENTRY_COUNT_STRIPE_LIVE_COLLECTED'));
 const c=ledger();c.push({account:'stripe_live_collected',direction:'debit',
  amount:'1.00',kind:'stripe_live_refund',currency:'MXN',idempotencyKey:'refund:1'});
 assert.ok(findings(order(),c).includes('REVERSAL_OR_DISPUTE_HOLD'));
});
test('RC11.4 checks pickup conservation, fees and unsupported delivery',()=>{
 assert.ok(findings({...order(),restaurantPayout:'89.00'}).includes('PICKUP_SPLIT_MISMATCH'));
 assert.ok(findings({...order(),serviceFee:'8.00'}).includes('ORDER_TOTAL_MISMATCH'));
 assert.ok(findings({...order(),orderType:'delivery'}).includes('UNSUPPORTED_STRIPE_FULFILLMENT'));
 assert.ok(findings({...order(),total:'1e2'}).includes('INVALID_ORDER_CENTAVOS'));
});
test('RC11.4 handles negative contribution margin as a debit',()=>{
 const a=order();a.paymentProcessingFee='30.00';
 const l=ledger();
 const processing=l.find(x=>x.account==='payment_processing');
 processing.amount='30.00';
 const contribution=l.find(x=>x.account==='contribution_margin');
 contribution.direction='debit';contribution.amount='8.00';
 assert.deepEqual(findings(a,l),[]);
});
