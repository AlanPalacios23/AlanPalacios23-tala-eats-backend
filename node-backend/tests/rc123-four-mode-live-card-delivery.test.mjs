import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLivePickupPaymentIntent,LIVE_PI_RESERVED} from '../dist/live/stripe-payments.js';
import {liveReceiptIdentity,LiveGateError} from '../dist/live/guard.js';
import {liveSettlementPostings} from '../dist/live/ledger-posting.js';

const read=(file)=>readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
const settings={maxOrderMinor:50000,publishableKey:'pk_live_public_test_placeholder'};
const mkStore=(fulfillment)=>{
 let calls=0;
 return {reserveForPayment:async(id,buyer,max,allow)=>{
   calls++;
   assert.equal(max,50000);
   assert.equal(allow,true);
   return {id,buyerId:buyer,amountMinor:25300,currency:'mxn',method:'stripe',
     fulfillment,status:'awaiting_payment',paymentStatus:'pending',
     intentId:LIVE_PI_RESERVED,createdAtMs:Date.now(),refundedMinor:0};
  },attachStripeIntent:async(id,buyer,intent)=>id===18&&buyer===7&&intent==='pi_RC123pilot',
  calls:()=>calls};
};
test('RC12.3 Stripe card delivery creates a separate idempotent, exact-amount intent',async()=>{
 const store=mkStore('delivery'),requests=[];
 const stripe={paymentIntents:{create:async(req,opts)=>{
   requests.push({req,opts});
   return {id:'pi_RC123pilot',livemode:true,currency:'mxn',amount:25300,
     status:'requires_payment_method',client_secret:'test_customer_secret',
     metadata:req.metadata};
 },retrieve:async()=>{throw Error('unexpected retrieve')}}};
 const out=await createLivePickupPaymentIntent(store,stripe,settings,18,7,true);
 assert.equal(out.amount_minor,25300);
 assert.equal(out.payment_intent_id,'pi_RC123pilot');
 assert.equal(requests.length,1);
 assert.equal(requests[0].req.metadata.tala_mode,'rc8_live_delivery');
 assert.equal(requests[0].opts.idempotencyKey,'tala-live-v1-delivery-order-18');
 assert.equal(requests[0].req.allowed_payment_method_types[0],'card');
});
test('RC12.3 delivery cannot reserve without explicit payment release',async()=>{
 const row={id:18,buyerId:7,amountMinor:25300,currency:'mxn',method:'stripe',
     fulfillment:'delivery',status:'awaiting_payment',paymentStatus:'pending',
     intentId:LIVE_PI_RESERVED,createdAtMs:Date.now(),refundedMinor:0};
 const fake={reserveForPayment:async()=>row,attachStripeIntent:async()=>true};
 await assert.rejects(createLivePickupPaymentIntent(fake,{paymentIntents:{}},settings,18,7),
  e=>e instanceof LiveGateError&&e.reason==='ORDER_NOT_ELIGIBLE');
});
test('RC12.3 signed capture binds delivery vs pickup and forbids swapped mode',()=>{
 const intent={livemode:true,id:'pi_RC123pilot',amount:25300,
  amount_received:25300,currency:'mxn',status:'succeeded',
  metadata:{tala_mode:'rc8_live_delivery',order_id:'18',buyer_id:'7'}};
 assert.equal(liveReceiptIdentity(intent,{id:18,buyerId:7,amountMinor:25300,fulfillment:'delivery'}),true);
 assert.throws(()=>liveReceiptIdentity(intent,{id:18,buyerId:7,amountMinor:25300,fulfillment:'pickup'}),LiveGateError);
 assert.throws(()=>liveReceiptIdentity({...intent,amount_received:0},
   {id:18,buyerId:7,amountMinor:25300,fulfillment:'delivery'}),LiveGateError);
});
test('RC12.3 restaurant+driver+platform card delivery money conserves exact cents',()=>{
 const figures={total:'253.00',restaurantPayout:'170.00',driverEarning:'32.00',
  platformRevenue:'51.00',paymentProcessingFee:'7.00',
  contributionMargin:'44.00',fulfillment:'delivery'};
 const rows=liveSettlementPostings(figures);
 assert.ok(rows.some(x=>x.account==='driver_payable'&&x.amount==='32.00'));
 assert.ok(rows.some(x=>x.account==='restaurant_payable'&&x.amount==='170.00'));
 assert.throws(()=>liveSettlementPostings({...figures,driverEarning:'31.99'}),
  /LIVE_DELIVERY_PAYEE_CONSERVATION_MISMATCH/);
 assert.throws(()=>liveSettlementPostings({...figures,driverEarning:'0.00'}),
  /LIVE_DELIVERY_PAYEE_CONSERVATION_MISMATCH/);
});
test('RC12.3 no card-to-door charge without independent LIVE dispatch + reconciliation',()=>{
 const checkout=read('marketplace/checkout.ts');
 const http=read('live/checkout-router.ts');
 const store=read('live/postgres-store.ts');
 const recon=read('live/reconcile.ts');
 const runtime=read('config.ts');
 assert.ok(checkout.includes('const liveStripeDelivery=liveDispatchReleased()&&isStageStripeDeliveryIntent(raw)'));
 assert.ok(checkout.includes('live_delivery_checkout_v1:true'));
 assert.ok(checkout.includes('await hasReachableLiveDriver'));
 assert.ok(http.includes('g.deliveryReleased===true'));
 assert.ok(store.includes("allowDelivery&&row.order_type==='delivery'"));
 assert.ok(recon.includes('isRealLiveCheckoutProvenance'));
 assert.ok(recon.includes('LIVE_DELIVERY_CHECKOUT_ORIGIN_NOT_VERIFIED'));
 assert.ok(runtime.includes('RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED'));
 assert.doesNotMatch(runtime,/STRIPE_CONNECT_TRANSFERS_ENABLED:\s*z\.enum\(\['true'/);
});
