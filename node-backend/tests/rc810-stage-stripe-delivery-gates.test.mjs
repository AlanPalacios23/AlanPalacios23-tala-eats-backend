import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesSignedStagePayment,stageDeliveryTenderAllowed}
 from '../dist/marketplace/delivery-financial-proof.js';
import {buildPublicPaymentContracts} from '../dist/payments/public-contract.js';

const order={id:77,orderType:'delivery',paymentMethod:'stripe',
 paymentStatus:'paid',total:{toFixed:()=> '145.60'}};
const receipt={account:'stripe_test_collected',kind:'stripe_test_payment',
 direction:'credit',amount:{toFixed:()=> '145.60'},
 idempotencyKey:'order:77:stripe-test:collected'};

test('RC810 requires matching amount, type, direction and intent idempotency for paid delivery',()=>{
 assert.equal(matchesSignedStagePayment(order,receipt),true);
 for(const variant of [
  {...receipt,account:'cash_collected_by_driver'},
  {...receipt,kind:'order_settlement'},
  {...receipt,direction:'debit'},
  {...receipt,amount:{toFixed:()=> '145.59'}},
  {...receipt,idempotencyKey:'order:78:stripe-test:collected'},
  null,
 ]){
  assert.equal(matchesSignedStagePayment(order,variant),false);
 }
});
test('RC810 card delivery gate stays off when new dedicated stage flag is OFF',async()=>{
 const tx={stageFinancialLedgerEntry:{findUnique:async()=>receipt}};
 assert.equal(await stageDeliveryTenderAllowed(tx,order),false);
 assert.equal(await stageDeliveryTenderAllowed(tx,
  {...order,paymentStatus:'pending'}),false);
 assert.equal(await stageDeliveryTenderAllowed(tx,
  {...order,paymentMethod:'mercadopago'}),false);
});
test('RC810 public contract never advertises LIVE delivery cards',()=>{
 const opt={environment:'staging',cashEnabled:true,stripeTestEnabled:true,
 stripeLiveEnabled:false,financialWritesEnabled:false,releaseApproved:false,
 refundsEnabled:false,manualSettlementApproved:false,
 publishableKey:'pk_test_dummy123',stagingDeliveryCashEnabled:true,
 stagingDeliveryStripeTestEnabled:true};
 const a=buildPublicPaymentContracts(opt).methods;
 assert.equal(a.delivery_stripe_supported,true);
 assert.equal(a.delivery_cash_supported,true);
 assert.equal(a.delivery_quote_supported,true);
 for(const change of [
  {stagingDeliveryStripeTestEnabled:false},
  {stripeTestEnabled:false},
  {stagingDeliveryCashEnabled:false},
 ]){
  assert.equal(buildPublicPaymentContracts({...opt,...change})
   .methods.delivery_stripe_supported,false);
 }
 const live=buildPublicPaymentContracts({...opt,environment:'production',
 stripeTestEnabled:false,stripeLiveEnabled:true,
 financialWritesEnabled:true,releaseApproved:true,
 refundsEnabled:true,manualSettlementApproved:true,
 publishableKey:'pk_live_testdummy'}).methods;
 assert.equal(live.delivery_stripe_supported,false);
 assert.equal(live.delivery_checkout_supported,false);
});
