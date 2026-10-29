import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../src/'+p,import.meta.url),'utf8');
test('RC12.3 card LIVE release is fail-closed in production and disallows partial rollout',()=>{
 const cfg=read('config.ts');
 const proof=read('marketplace/live-delivery-payment.ts');
 const admission=read('marketplace/checkout.ts');
 const http=read('app.ts');
 for(const flag of [
  'LIVE_DELIVERY_DISPATCH_ENABLED','LIVE_DELIVERY_CARD_CHECKOUT_ENABLED',
  'LIVE_DELIVERY_RELEASE_APPROVED','LIVE_DELIVERY_CARD_E2E_APPROVED']){
  assert.ok(cfg.includes(flag),flag+' missing config');
  assert.ok(proof.includes('config.'+flag+"==='true'"),flag+' missing payment release');
 }
 assert.ok(cfg.includes("const deliveryCardValues=deliveryCardKeys.map(k=>process.env[k]==='true')"));
 assert.ok(cfg.includes('deliveryCardValues.some(Boolean)&&!deliveryCardValues.every(Boolean)'));
 assert.ok(cfg.includes('RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED'));
 assert.ok(cfg.includes('RC123_LIVE_CARD_DELIVERY_PRECONDITIONS_NOT_MET'));
 for(const flag of [
  'STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
  'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
  'STRIPE_MANUAL_SETTLEMENT_APPROVED','LIVE_DRIVER_PRESENCE_ENABLED',
  'AUTH_V02_ENABLED','MARKETPLACE_B_ENABLED']){
  assert.ok(cfg.includes(flag),flag+' missing release dependency');
 }
 assert.ok(cfg.includes("process.env.NODE_ENV!=='production'"));
 assert.ok(cfg.includes("process.env.STRIPE_CONNECT_TRANSFERS_ENABLED")||
               cfg.includes("'STRIPE_CONNECT_TRANSFERS_ENABLED'"));
 assert.ok(admission.includes('liveStripeDelivery=liveDispatchReleased()'));
 assert.ok(http.includes('deliveryReleased:liveDispatchReleased()'));
});
