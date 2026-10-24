import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPublicPaymentContracts} from '../dist/payments/public-contract.js';

const opts={
  environment:'staging',cashEnabled:true,stripeTestEnabled:true,
  stripeLiveEnabled:false,financialWritesEnabled:false,
  releaseApproved:false,refundsEnabled:false,
  manualSettlementApproved:false,publishableKey:'pk_test_public12345678901234567890',
};
const stripe=(x)=>x.methods.methods.find(m=>m.id==='stripe');
const cash=(x)=>x.methods.methods.find(m=>m.id==='cash');

test('staging Flutter API shows Stripe TEST and never advertises live collection',()=>{
  const r=buildPublicPaymentContracts(opts);
  assert.equal(stripe(r).enabled,true);
  assert.equal(stripe(r).mode,'stage-stripe-test-pickup');
  assert.equal(cash(r).enabled,true);
  assert.equal(r.stripeConfig.environment,'staging');
  assert.equal(r.stripeConfig.enabled,true);
  assert.equal(r.stripeConfig.publishable_key,opts.publishableKey);
  assert.equal(r.stripeConfig.financial_writes_enabled,false);
  assert.equal(r.methods.production_ready,false);
});

test('staging never exposes Stripe LIVE public key even if passed accidentally',()=>{
  const r=buildPublicPaymentContracts({
    ...opts,publishableKey:'pk_live_wrongmode12345678901234',
  });
  assert.equal(stripe(r).enabled,false);
  assert.equal(r.stripeConfig.publishable_key,null);
});

test('production Flutter API exposes LIVE card checkout with only public key',()=>{
  const key='pk_live_public1234567890123456789012345';
  const r=buildPublicPaymentContracts({
    ...opts,environment:'production',stripeTestEnabled:false,
    stripeLiveEnabled:true,financialWritesEnabled:true,
    releaseApproved:true,refundsEnabled:true,
    manualSettlementApproved:true,publishableKey:key,
  });
  assert.equal(stripe(r).enabled,true);
  assert.equal(stripe(r).mode,'live-stripe-pickup');
  assert.equal(r.methods.seller_connect_required,true);
  assert.equal(r.stripeConfig.enabled,true);
  assert.equal(r.stripeConfig.publishable_key,key);
  assert.equal(r.stripeConfig.merchant_country,'MX');
  assert.equal(r.stripeConfig.environment,'production');
  assert.equal(r.stripeConfig.financial_writes_enabled,true);
  assert.equal(r.paymentsConfig.checkout_ready,true);
  assert.equal(r.methods.production_ready,true);
  assert.doesNotMatch(JSON.stringify(r),/sk_live_|rk_live_|whsec_/);
});

test('production standby does not advertise cash or Stripe for disposable test merchants',()=>{
 const r=buildPublicPaymentContracts({...opts,environment:'production',
   cashEnabled:true,stripeTestEnabled:false,releaseApproved:false,
   stripeLiveEnabled:false,financialWritesEnabled:false,
   refundsEnabled:false,manualSettlementApproved:false,
   publishableKey:'pk_live_public1234567890123456789012'});
 assert.equal(cash(r).enabled,false);
 assert.equal(stripe(r).enabled,false);
 assert.equal(r.methods.cash_available,false);
 assert.equal(r.methods.methods.every(m=>m.enabled===false),true);
 assert.equal(r.stripeConfig.publishable_key,null);
});
test('production stays fail-closed without manual release and correct LIVE key',()=>{
  const base={...opts,environment:'production',
    stripeLiveEnabled:true,financialWritesEnabled:true,
    releaseApproved:true,refundsEnabled:true,
    manualSettlementApproved:true,publishableKey:'pk_live_public12345678901234567890'};
  for(const missing of ['releaseApproved','financialWritesEnabled',
    'refundsEnabled','manualSettlementApproved','stripeLiveEnabled']){
    const r=buildPublicPaymentContracts({...base,[missing]:false});
    assert.equal(stripe(r).enabled,false,missing);
    assert.equal(r.stripeConfig.publishable_key,null,missing);
  }
  const wrong=buildPublicPaymentContracts({...base,publishableKey:'pk_test_wrong1234567890123456789012'});
  assert.equal(stripe(wrong).enabled,false);
  assert.equal(wrong.stripeConfig.publishable_key,null);
});
