import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path)=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');

test('RC12.2 production cash pickup must not inherit staging cash permission',()=>{
 const policy=read('marketplace/live-cash-delivery.ts');
 const config=read('config.ts');
 assert.match(policy,/config.NODE_ENV==='staging'&&config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true'/);
 for(const gate of [
  'config.LIVE_PICKUP_CASH_CHECKOUT_ENABLED',
  'config.LIVE_PICKUP_CASH_RELEASE_APPROVED',
  "config.STRIPE_LIVE_ENABLED==='true'",
  "config.STRIPE_FINANCIAL_WRITES_ENABLED==='true'",
  "config.STRIPE_MANUAL_SETTLEMENT_APPROVED==='true'",
 ])assert.ok(policy.includes(gate),gate);
 assert.ok(config.includes('RC122_PARTIAL_LIVE_CASH_PICKUP_RELEASE_FORBIDDEN'));
 assert.ok(config.includes('RC122_LIVE_CASH_PICKUP_REQUIRES_APPROVED_PRODUCTION_SETTLEMENT'));
 assert.ok(config.includes('LIVE_PICKUP_CASH_CHECKOUT_ENABLED:'));
 assert.ok(config.includes('LIVE_PICKUP_CASH_RELEASE_APPROVED:'));
 assert.match(policy,/config.NODE_ENV==='production'&&\s*config.LIVE_PICKUP_CASH_CHECKOUT_ENABLED/);
});

test('RC12.2 customer, checkout, seller lifecycle and handoff share same explicit cash pickup guard',()=>{
 const names=['marketplace/checkout.ts','marketplace/routes.ts',
   'marketplace/lifecycle.ts','marketplace/pickup.ts'];
 for(const name of names){
  const code=read(name);
  assert.ok(code.includes('cashPickupReleased'),name+' missing gate');
  assert.doesNotMatch(code,/STAGE_PICKUP_CASH_CHECKOUT_ENABLED/,name+' may accept staging cash in LIVE');
 }
 const checkout=read(names[0]);
 assert.ok(checkout.includes('(cash&&cashPickupReleased())'));
 assert.ok(checkout.includes('(cash&&liveCashPickupReleased())'));
 assert.ok(checkout.includes('Comercio LIVE sin titular y Connect aprobados'));
 assert.ok(checkout.includes('m.owner_approved_at IS NOT NULL'));
 assert.ok(checkout.includes('u.is_active=true'));
 assert.ok(checkout.includes("u.role='restaurant'"));
 assert.ok(checkout.includes("restaurant.onboardingStatus!=='approved'"));
 const stageOrders=read(names[1]);
 assert.ok(stageOrders.includes('isCashPickupIntent(req.body)&&cashPickupReleased()'));
 const lifecycle=read(names[2]);
 assert.ok(lifecycle.includes("o.orderType==='pickup'&&cashPickupReleased()"));
 assert.ok(lifecycle.includes("order.orderType==='pickup'&&cashPickupReleased()"));
 const proof=read(names[3]);
 assert.ok(proof.includes("const cash=order.paymentMethod==='cash'&&cashPickupReleased()"));
});

test('RC12.2 public pickup capability does not advertise stage cash in production',()=>{
 const app=read('app.ts');
 const readiness=read('live/pickup-readiness.ts');
 assert.ok(app.includes("import {cashPickupReleased,liveCashDeliveryReleased} from './marketplace/live-cash-delivery.js';"));
 assert.ok(app.includes('cashPickupReleased()'));
 assert.doesNotMatch(app,/config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true'/);
 assert.ok(app.includes("stagePickupCashEnabled:config.NODE_ENV==='staging'&&cashPickupReleased()"));
 assert.ok(readiness.includes('cash_enabled:cashFlagEnabled'));
});

test('RC12.2 cash pickup physical receipt remains a non-Stripe immutable handoff',()=>{
 const source=read('marketplace/pickup.ts');
 assert.ok(source.includes("account:'cash_collected_by_merchant'"));
 assert.ok(source.includes("kind:'cash_pickup_collection'"));
 assert.ok(source.includes("idempotencyKey:'order:'+order.id+':cash-pickup:collected'"));
 assert.ok(source.includes('cashCollected:cash?order.total'));
 assert.ok(source.includes("const namespace=config.NODE_ENV==='production'?'live':'stage'"));
 assert.doesNotMatch(source,/stripe\.(?:payouts|transfers|charges)\.create\(/);
});
