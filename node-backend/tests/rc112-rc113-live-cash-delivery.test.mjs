import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isLiveCashCheckoutProvenance}
 from '../src/marketplace/live-cash-delivery-policy.ts';

const read=(name)=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('RC11.2 LIVE cash origin rejects staging fixtures, wrong markers and invalid HMAC',()=>{
 const h='f'.repeat(64);
 assert.equal(isLiveCashCheckoutProvenance(JSON.stringify({
  source:'checkout',live_delivery_cash_v1:true,checkout_intent_hmac:h
 })),true);
 for(const o of [
  {source:'client',live_delivery_cash_v1:true,checkout_intent_hmac:h},
  {source:'checkout',stage_driver_fixture:true,live_delivery_cash_v1:true,checkout_intent_hmac:h},
  {source:'checkout',stage_delivery_customer_v1:true,live_delivery_cash_v1:true,checkout_intent_hmac:h},
  {source:'checkout',live_delivery_cash_v1:false,checkout_intent_hmac:h},
  {source:'checkout',live_delivery_cash_v1:true,checkout_intent_hmac:'forged'},
 ]){
  assert.equal(isLiveCashCheckoutProvenance(JSON.stringify(o)),false);
 }
 assert.equal(isLiveCashCheckoutProvenance(null),false);
 assert.equal(isLiveCashCheckoutProvenance('{not-json'),false);
});
test('RC11.2 independent release is triple-key and card LIVE stays hard locked',()=>{
 const cfg=read('config.ts');
 const cash=read('marketplace/live-cash-delivery.ts');
 for(const flag of ['LIVE_DELIVERY_CASH_CHECKOUT_ENABLED',
   'LIVE_DELIVERY_CASH_DISPATCH_ENABLED','LIVE_DELIVERY_CASH_RELEASE_APPROVED']){
  assert.match(cfg,new RegExp(flag+": z\\.enum\\(\\['false','true'\\]\\)\\.default\\('false'\\)"));
  assert.ok(cash.includes('config.'+flag));
 }
 assert.ok(cfg.includes('RC112_PARTIAL_LIVE_CASH_DELIVERY_RELEASE_FORBIDDEN'));
 assert.ok(cfg.includes('RC112_LIVE_CASH_DELIVERY_REQUIRES_APPROVED_PRODUCTION_PRESENCE'));
 assert.ok(cfg.includes('RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED'));
 assert.ok(cash.includes("config.MERCHANT_MANAGED_DELIVERY!=='true'"));
});
test('RC11.2 LIVE cash order reuses a single idempotent inventory+ledger transaction',()=>{
 const checkout=read('marketplace/checkout.ts'),routes=read('marketplace/routes.ts');
 for(const value of [
  'const liveCashDelivery=liveCashDeliveryReleased()&&isStageCashDeliveryIntent(raw)',
  'const delivery=stageDelivery||liveCashDelivery',
  "if((liveCashDelivery||(cash&&liveCashPickupReleased()))&&account.role!=='customer')",
  "await hasReachableLiveDriver({lat:restaurant.lat,lng:restaurant.lng})",
  'live_delivery_cash_v1:true',
  'clientReference:data.client_reference','checkout_intent_hmac:fingerprint',
  'return db.$transaction(async tx=>',
  'UPDATE menu_items SET stock=stock-',
  'UPDATE ingredient_stocks SET quantity=quantity-',
  "kind:'order_settlement'",
 ]){
  assert.ok(checkout.includes(value),value);
 }
 assert.ok(routes.includes('liveCashDeliveryReleased()));'));
 const sig=checkout.indexOf('const liveStripe=(cardStripePickup||liveStripeDelivery)&&');
 assert.ok(sig>=0,'LIVE Stripe delivery can exist only after separate release');
 assert.ok(checkout.includes('liveDispatchReleased()&&isStageStripeDeliveryIntent(raw)'));
 assert.ok(read('config.ts').includes('RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED'));
});
test('RC11.3 LIVE cash pickup dispatch and PIN require same server-origin receipt',()=>{
 const worker=read('live/production-worker.ts');
 const dispatch=read('marketplace/driver.ts');
 const recovery=read('marketplace/live-delivery-dispatch.ts');
 const owner=read('marketplace/lifecycle.ts');
 const proof=read('marketplace/live-cash-delivery.ts');
 for(const expected of [
  "order.orderType!=='delivery'","order.paymentMethod!=='cash'",
  "order.paymentStatus!=='pending'","order.refundedAmount.toFixed(2)!=='0.00'",
  "isLiveCashCheckoutProvenance(origin?.metadataJson??null)",
 ])assert.ok(proof.includes(expected),expected);
 assert.ok(dispatch.includes('await liveCashDeliveryTenderAllowed(tx,row)'));
 assert.ok(dispatch.includes('await liveCashDeliveryTenderAllowed(tx,o)'));
 assert.ok(dispatch.includes("p.user?.role!=='driver'||!p.user?.isActive"));
 assert.ok(dispatch.includes('FOR UPDATE SKIP LOCKED'));
 assert.ok(dispatch.includes('await throttlePin(orderId,actor.id)'));
 assert.ok(dispatch.includes("kind:'cash_delivery_collection'"));
 assert.ok(owner.includes('await liveCashDeliveryTenderAllowed(tx,order)'));
 assert.ok(owner.includes('await dispatchStageDeliveryReady(resultId)'));
 assert.ok(recovery.includes('liveCashDeliveryReleased()'));
 assert.ok(worker.includes('sweepLiveDeliveryReady()'));
});
test('RC11.3 cash driver available offers never reveal recipient address, PIN or GPS',()=>{
 const driver=read('marketplace/driver.ts');
 const routes=read('marketplace/routes.ts');
 const start=driver.indexOf('export async function liveCashDriverOffers(');
 const end=driver.indexOf('export async function driverAccept(',start);
 const section=driver.slice(start,end);
 assert.ok(start>=0&&end>start);
 for(const v of ['liveCashDeliveryReleased()','await redisLocation(actor.id)',
   'await liveCashDeliveryTenderAllowed(db,order)','order.restaurant.name'])
  assert.ok(section.includes(v),v);
 assert.doesNotMatch(section,/customer:|deliveryPin|deliveryLat|deliveryLng|order\.address/);
 assert.ok(routes.includes('res.json(await liveCashDriverOffers(account,limit.data))'));
});
test('RC11.2 cancellation reverses ledger and stock only before pickup',()=>{
 const source=read('marketplace/lifecycle.ts');
 assert.ok(source.includes('await liveCashDeliveryTenderAllowed(tx,order)'));
 assert.ok(source.includes("if(!stripe&&!(order.status in feeRates))"));
 assert.ok(source.includes("WHERE id=${id}"));
 assert.ok(source.includes("'order_cancellation'")||source.includes("kind:'order_cancellation'"));
});
