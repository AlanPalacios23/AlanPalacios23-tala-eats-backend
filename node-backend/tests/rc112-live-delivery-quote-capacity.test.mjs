import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {freshDriverNearPickup} from '../src/marketplace/delivery-runtime.ts';

const origin={lat:20.6534,lng:-103.704};
const now=Date.parse('2026-10-28T22:00:00.000Z');
const signal=(lat,lng,when)=>JSON.stringify({
 lat,lng,reported_at:new Date(when).toISOString(),
});
test('LIVE driver radius requires real recent GPS and rejects absent, stale, future or distant locations',()=>{
 assert.equal(freshDriverNearPickup(signal(origin.lat,origin.lng,now),origin,now,8),true);
 assert.equal(freshDriverNearPickup(signal(origin.lat+.005,origin.lng,now-60000),origin,now,8),true);
 assert.equal(freshDriverNearPickup(signal(origin.lat+.2,origin.lng,now),origin,now,8),false);
 assert.equal(freshDriverNearPickup(signal(origin.lat,origin.lng,now-120001),origin,now,8),false);
 assert.equal(freshDriverNearPickup(signal(origin.lat,origin.lng,now+1000),origin,now,8),false);
 assert.equal(freshDriverNearPickup(null,origin,now,8),false);
 assert.equal(freshDriverNearPickup('garbage',origin,now,8),false);
 assert.equal(freshDriverNearPickup(signal(999,origin.lng,now),origin,now,8),false);
 assert.equal(freshDriverNearPickup(signal(origin.lat,origin.lng,now),origin,now,31),false);
 assert.equal(freshDriverNearPickup(signal(origin.lat,origin.lng,now),{lat:91,lng:1},now,8),false);
});
test('production delivery capacity uses verified active idle drivers and isolated fresh Redis keys',()=>{
 const cap=readFileSync(new URL('../src/marketplace/live-delivery-capacity.ts',import.meta.url),'utf8');
 for(const required of [
  "config.NODE_ENV!=='production'","config.LIVE_DRIVER_PRESENCE_ENABLED!=='true'",
  "config.MERCHANT_MANAGED_DELIVERY==='true'",
  "isVerified:true,isOnline:true","role:'driver',isActive:true",
  "const MAX_CANDIDATES=100","status:{in:[...ACTIVE_STATUSES]}",
  "driverLocationKey('production',p.userId)","freshDriverNearPickup(",
  "catch{","return false;",
 ])assert.ok(cap.includes(required),required);
 assert.doesNotMatch(cap,/\.create\(|\.update\(|\.upsert\(|stripe\.|paymentIntents\.create/);
});
test('LIVE route returns genuine server quote but cannot create a paid delivery or advertise enabled checkout',()=>{
 const routes=readFileSync(new URL('../src/marketplace/routes.ts',import.meta.url),'utf8');
 const section=routes.split("stageOrdersRouter.post('/delivery-quote'")[1]
   .split("stageOrdersRouter.post('/quote'")[0];
 assert.ok(section.includes("await user(req,['customer'])"));
 assert.ok(section.includes("config.NODE_ENV==='production'"));
 assert.ok(section.includes('await hasReachableLiveDriver('));
 assert.ok(section.includes('calculatePickupQuoteFromCatalog('));
 assert.ok(section.includes('calculateDefaultCommercial('));
 assert.ok(section.includes("if(livePreview&&data.payment_method==='stripe')"));
 assert.ok(section.includes("delivery_checkout_supported:stagePreview"));
 assert.ok(section.includes("checkout_blocker:'LIVE_DELIVERY_CHECKOUT_NOT_RELEASED'"));
 assert.ok(section.includes("driver_assignment_guaranteed:false"));
 assert.doesNotMatch(section,/stripe\.paymentIntents\.create|marketOrder\.create|\.\$transaction|return 201/);
 const cfg=readFileSync(new URL('../src/config.ts',import.meta.url),'utf8');
 const orders=routes.split("stageOrdersRouter.post('/',async(req,res)=>{")[1]
  .split("ownerRouter.post('/orders/:orderId/complete'")[0];
 assert.ok(cfg.includes('RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED'));
 assert.ok(orders.includes('const liveCard=isStripePickupIntent(req.body)&&'));
 assert.ok(orders.includes("config.NODE_ENV==='staging'&&"));
});
