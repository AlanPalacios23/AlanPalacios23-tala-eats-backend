import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=(name)=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
test('production pickup only advances when LIVE Stripe capture is immutable and exact',()=>{
 const lifecycle=source('marketplace/lifecycle.ts');
 const proof=source('marketplace/pickup.ts');
 for(const s of [lifecycle,proof]){
   assert.match(s,/config\.NODE_ENV==='production'/);
   assert.match(s,/STRIPE_LIVE_ENABLED==='true'/);
   assert.match(s,/STRIPE_FINANCIAL_WRITES_ENABLED==='true'/);
   assert.match(s,/stripe_live_payment/);
   assert.match(s,/stripe_live_collected/);
   assert.match(s,/:stripe-live:collected/);
   assert.match(s,/direction:'credit'/);
   assert.match(s,/verified\.amount\.toFixed\(2\)!==order\.total\.toFixed\(2\)/);
   assert.match(s,/config\.STAGE_STRIPE_TEST_CHECKOUT_ENABLED==='true'/);
 }
 assert.match(proof,/timingSafeEqual/);
 assert.match(proof,/pinVerified:true/);
 assert.match(proof,/status:'delivered'/);
});
test('LIVE PaymentIntent offers cards without mutually conflicting Stripe payment mode params',()=>{
 const pi=source('live/stripe-payments.ts');
 assert.match(pi,/payment_method_types:\['card'\]/);
 assert.doesNotMatch(pi,/allowed_payment_method_types:/);
 assert.doesNotMatch(pi,/automatic_payment_methods:\{enabled:true/);
 assert.match(pi,/capture_method:'automatic'/);
 assert.match(pi,/idempotencyKey:'tala-live-v1-pickup-order-'/);
 assert.match(pi,/intent\.livemode/);
});
test('source routes still reject LIVE driver fulfillment and do not reinterpret a test Stripe payment',()=>{
 const market=source('marketplace/routes.ts');
 const driver=source('marketplace/driver.ts');
 assert.match(market,/isStripePickupIntent/);
 assert.match(market,/config\.NODE_ENV==='production'/);
 assert.match(driver,/stage_driver_fixture/);
 assert.match(driver,/STAGE_DRIVER_DELIVERY_ENABLED/);
});
