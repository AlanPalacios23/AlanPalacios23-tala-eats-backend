import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildPublicPaymentContracts} from '../dist/payments/public-contract.js';

const live={
 environment:'production',cashEnabled:true,liveCashPickupEnabled:true,
 stripeTestEnabled:false,stripeLiveEnabled:true,financialWritesEnabled:true,
 releaseApproved:true,refundsEnabled:true,manualSettlementApproved:true,
 publishableKey:'pk_live_public1234567890123456789012',pricingV162Enabled:false,
 stagingDeliveryCashEnabled:false,stagingDeliveryStripeTestEnabled:false,
};
test('RC11.4 public PWA delivery remains disabled before LIVE cash financial release',()=>{
 const p=buildPublicPaymentContracts({...live,liveCashDeliveryEnabled:false});
 assert.equal(p.methods.delivery_checkout_supported,false);
 assert.equal(p.methods.delivery_cash_supported,false);
 assert.equal(p.methods.delivery_quote_supported,false);
 assert.equal(p.methods.delivery_stripe_supported,false);
 assert.equal(p.methods.methods.find(m=>m.id==='stripe').mode,'live-stripe-pickup');
 assert.equal(p.methods.methods.find(m=>m.id==='cash').enabled,true);
});
test('RC11.4 advertises cash LIVE delivery only after all production capabilities',()=>{
 const p=buildPublicPaymentContracts({...live,liveCashDeliveryEnabled:true});
 assert.equal(p.methods.delivery_checkout_supported,true);
 assert.equal(p.methods.delivery_cash_supported,true);
 assert.equal(p.methods.delivery_quote_supported,true);
 assert.equal(p.methods.delivery_stripe_supported,false);
 assert.equal(p.methods.delivery_base_fee,'39.00');
 assert.equal(p.methods.service_fee_rate,'0.07');
 assert.equal(p.methods.commercial_pricing_version,'1.5.2');
 assert.equal(p.methods.pickup_checkout_supported,true);
});
test('RC11.4 preserves fail-closed when cash approval or financial identity is incomplete',()=>{
 for(const change of [
  {liveCashDeliveryEnabled:false},
  {stripeLiveEnabled:false},
  {releaseApproved:false},
  {financialWritesEnabled:false},
  {refundsEnabled:false},
  {manualSettlementApproved:false},
  {publishableKey:'pk_test_public12345678901234'},
  {pricingV162Enabled:true},
 ]){
  const p=buildPublicPaymentContracts({...live,liveCashDeliveryEnabled:true,...change});
  assert.equal(p.methods.delivery_checkout_supported,false,JSON.stringify(change));
  assert.equal(p.methods.delivery_cash_supported,false,JSON.stringify(change));
  assert.equal(p.methods.delivery_stripe_supported,false,JSON.stringify(change));
 }
 const stage=buildPublicPaymentContracts({...live,environment:'staging',
   liveCashDeliveryEnabled:true,stagingDeliveryCashEnabled:false});
 assert.equal(stage.methods.delivery_cash_supported,false);
});
test('RC11.4 PWA capability is derived from actual triple-flag LIVE release function',()=>{
 const src=readFileSync(new URL('../src/parity/routes.ts',import.meta.url),'utf8');
 const liveSrc=readFileSync(new URL('../src/marketplace/live-cash-delivery.ts',import.meta.url),'utf8');
 const contract=readFileSync(new URL('../src/payments/public-contract.ts',import.meta.url),'utf8');
 assert.ok(src.includes('liveCashDeliveryEnabled:liveCashDeliveryReleased()'));
 assert.ok(liveSrc.includes("config.LIVE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'"));
 assert.ok(liveSrc.includes("config.LIVE_DELIVERY_CASH_DISPATCH_ENABLED==='true'"));
 assert.ok(liveSrc.includes("config.LIVE_DELIVERY_CASH_RELEASE_APPROVED==='true'"));
 assert.ok(contract.includes('delivery_checkout_supported:stageDeliveryCash||liveDeliveryCash||stageDeliveryStripe||liveDeliveryStripe'));
 assert.ok(contract.includes('delivery_cash_supported:stageDeliveryCash||liveDeliveryCash'));
 assert.ok(contract.includes('delivery_quote_supported:stageDeliveryCash||liveDeliveryCash||stageDeliveryStripe||liveDeliveryStripe'));
});
