import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryCapability} from '../dist/live/pickup-readiness.js';
import {buildPublicPaymentContracts} from '../dist/payments/public-contract.js';
const restaurant={id:20,is_open:true,pickup_enabled:false,
  verification_status:'verified',onboarding_status:'approved',
  owner_id:22,owner_email:'merchant@example.com',owner_active:true,
  stripe_account_id:'acct_APPROVED',owner_approved_at:new Date()};
const connect={id:'acct_APPROVED',email:'merchant@example.com',country:'MX',
  details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}};
test('RC12.3 delivery-only merchant may take card or cash without enabling pickup',()=>{
 const d=deliveryCapability(restaurant,connect,true,'acct_PLATFORM',true,true,true);
 assert.deepEqual({ready:d.ready,cash:d.cash_enabled,card:d.stripe_enabled},
   {ready:true,cash:true,card:true});
 assert.equal(d.order_type,'delivery');
});
test('RC12.3 delivery needs real GPS, approved owner and Connect; not test shop',()=>{
 const checks=[
  deliveryCapability(restaurant,connect,true,'acct_PLATFORM',true,true,false),
  deliveryCapability(restaurant,connect,true,'acct_PLATFORM',false,false,true),
  deliveryCapability({...restaurant,verification_status:'pending'},connect,true,'acct_PLATFORM',true,true,true),
  deliveryCapability({...restaurant,owner_active:false},connect,true,'acct_PLATFORM',true,true,true),
  deliveryCapability(restaurant,{...connect,id:'acct_PLATFORM'},true,'acct_PLATFORM',true,true,true),
  deliveryCapability(restaurant,{...connect,details_submitted:false},true,'acct_PLATFORM',true,true,true),
  deliveryCapability(restaurant,connect,false,'acct_PLATFORM',true,true,true),
 ];
 for(const x of checks){assert.equal(x.ready,false,x.reason);assert.equal(x.cash_enabled,false);assert.equal(x.stripe_enabled,false);}
});
const production={
 environment:'production',cashEnabled:true,liveCashPickupEnabled:false,
 stripeTestEnabled:false,stripeLiveEnabled:true,financialWritesEnabled:true,
 releaseApproved:true,refundsEnabled:true,manualSettlementApproved:true,
 publishableKey:'pk_live_public1234567890123456789012',
 pricingV162Enabled:false,liveCashDeliveryEnabled:false,liveCardDeliveryEnabled:false,
};
test('RC12.3 marketing contract cannot advertise card delivery from pickup stripe',()=>{
 const closed=buildPublicPaymentContracts(production).methods;
 assert.equal(closed.cash_available,false);
 assert.equal(closed.delivery_checkout_supported,false);
 assert.equal(closed.delivery_stripe_supported,false);
 assert.equal(closed.delivery_cash_supported,false);
 assert.equal(closed.methods.find(m=>m.id==='stripe').enabled,true);
 const card=buildPublicPaymentContracts({...production,liveCardDeliveryEnabled:true}).methods;
 assert.equal(card.delivery_checkout_supported,true);
 assert.equal(card.delivery_stripe_supported,true);
 assert.equal(card.delivery_cash_supported,false);
 assert.equal(card.cash_available,false);
 const cash=buildPublicPaymentContracts({...production,liveCashDeliveryEnabled:true}).methods;
 assert.equal(cash.delivery_cash_supported,true);
 assert.equal(cash.delivery_stripe_supported,false);
 assert.equal(cash.cash_available,false);
 const pickup=buildPublicPaymentContracts({...production,liveCashPickupEnabled:true}).methods;
 assert.equal(pickup.cash_available,true);
 assert.equal(pickup.delivery_checkout_supported,false);
 const all=buildPublicPaymentContracts({...production,liveCashPickupEnabled:true,
   liveCashDeliveryEnabled:true,liveCardDeliveryEnabled:true}).methods;
 assert.equal(all.delivery_cash_supported,true);
 assert.equal(all.delivery_stripe_supported,true);
 assert.equal(all.cash_available,true);
});
