import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matchesSignedLiveDeliveryCapture,isRealLiveCheckoutProvenance}
 from '../src/marketplace/live-delivery-policy.ts';

const order={
 id:418,orderType:'delivery',paymentMethod:'stripe',paymentStatus:'paid',
 paymentProvider:'stripe',paymentProviderId:'pi_livetest123',
 total:{toFixed:()=> '249.00'},refundedAmount:{toFixed:()=> '0.00'},
};
const receipt={
 account:'stripe_live_collected',direction:'credit',kind:'stripe_live_payment',
 idempotencyKey:'order:418:stripe-live:collected',
 amount:{toFixed:()=> '249.00'},
};
test('signed LIVE capture requires exact order, provider, kind and full amount',()=>{
 assert.equal(matchesSignedLiveDeliveryCapture(order,receipt),true);
 for(const edit of [
  {orderType:'pickup'},{paymentMethod:'cash'},{paymentStatus:'pending'},
  {paymentStatus:'refunded'},{paymentProvider:'mercadopago'},
  {paymentProviderId:'pi_invalid-!'},{id:419},
  {refundedAmount:{toFixed:()=> '0.01'}},{total:{toFixed:()=> '0.00'}},
 ])assert.equal(matchesSignedLiveDeliveryCapture({...order,...edit},receipt),false,
  JSON.stringify(Object.keys(edit)));
 for(const edit of [
  {account:'stripe_test_collected'},{direction:'debit'},
  {kind:'stripe_test_payment'},{idempotencyKey:'order:999:stripe-live:collected'},
  {amount:{toFixed:()=> '248.99'}},
 ])assert.equal(matchesSignedLiveDeliveryCapture(order,{...receipt,...edit}),false);
 assert.equal(matchesSignedLiveDeliveryCapture(order,null),false);
});
test('LIVE checkout provenance rejects staging fixtures and arbitrary metadata',()=>{
 const hmac='a'.repeat(64);
 assert.equal(isRealLiveCheckoutProvenance(JSON.stringify({
  live_delivery_checkout_v1:true,checkout_intent_hmac:hmac})),true);
 assert.equal(isRealLiveCheckoutProvenance(JSON.stringify({
  stage_driver_fixture:true,checkout_intent_hmac:hmac})),false);
 assert.equal(isRealLiveCheckoutProvenance(JSON.stringify({
  stage_delivery_customer_v1:true,checkout_intent_hmac:hmac})),false);
 assert.equal(isRealLiveCheckoutProvenance(JSON.stringify({
  live_delivery_checkout_v1:true,checkout_intent_hmac:'invalid'})),false);
 assert.equal(isRealLiveCheckoutProvenance('garbage'),false);
 assert.equal(isRealLiveCheckoutProvenance(null),false);
});
test('future LIVE dispatch, PIN and financial work remain under three locked release flags',()=>{
 const cfg=readFileSync(new URL('../src/config.ts',import.meta.url),'utf8');
 const dispatcher=readFileSync(new URL('../src/marketplace/driver.ts',import.meta.url),'utf8');
 const live=readFileSync(new URL('../src/marketplace/live-delivery-payment.ts',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../src/live/production-worker.ts',import.meta.url),'utf8');
 const checkout=readFileSync(new URL('../src/marketplace/checkout.ts',import.meta.url),'utf8');
 for(const flag of [
  'LIVE_DELIVERY_DISPATCH_ENABLED','LIVE_DELIVERY_CARD_CHECKOUT_ENABLED',
  'LIVE_DELIVERY_RELEASE_APPROVED']){
  assert.match(cfg,new RegExp(flag+": z\\.enum\\(\\['false','true'\\]\\)\\.default\\('false'\\)"));
  assert.ok(cfg.includes("'"+flag+"'"));
  assert.ok(live.includes('config.'+flag));
 }
 assert.match(cfg,/RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED/);
 assert.match(dispatcher,/liveDeliveryTenderAllowed\(tx,row\)/);
 assert.match(dispatcher,/liveDeliveryTenderAllowed\(tx,o\)/);
 assert.match(dispatcher,/FOR UPDATE SKIP LOCKED/);
 assert.match(dispatcher,/await throttlePin\(orderId,actor\.id\)/);
 assert.match(worker,/sweepLiveDeliveryReady\(\)/);
 assert.match(worker,/if\(stopping\|\|readyBusy\|\|!liveDispatchReleased\(\)\)return/);
 assert.match(checkout,/const liveStripe=cardStripePickup&&/);
 assert.doesNotMatch(checkout,/live_delivery_checkout_v1:true/);
});
