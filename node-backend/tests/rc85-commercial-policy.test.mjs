import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteTalaRC85,RC85_TERMS} from '../dist/live/rc85-commercial-policy.js';
test('RC85 home delivery: client MXN253, merchant 170, driver 32, platform 51 before Stripe',()=>{
 const q=quoteTalaRC85({productsMinor:20000n,discountMinor:0n,tipMinor:0n,
  fulfillment:'platform_delivery'});
 assert.equal(q.totalMinor,25300n);
 assert.equal(q.restaurantPayableMinor,17000n);
 assert.equal(q.driverPayableMinor,3200n);
 assert.equal(q.platformGrossBeforeStripeAndTaxMinor,5100n);
 assert.equal(q.shippingMinor,3900n);
 assert.equal(RC85_TERMS.clientServiceBps,700);
});
test('driver tip MXN20 fully goes to driver, never platform or seller',()=>{
 const q=quoteTalaRC85({productsMinor:20000n,discountMinor:0n,tipMinor:2000n,
  fulfillment:'platform_delivery'});
 assert.equal(q.totalMinor,27300n);
 assert.equal(q.driverPayableMinor,5200n);
 assert.equal(q.restaurantPayableMinor,17000n);
 assert.equal(q.platformGrossBeforeStripeAndTaxMinor,5100n);
 assert.equal(q.commissionOnTipMinor,0n);
});
test('restaurant-own delivery: merchant receives shipping and customer tip',()=>{
 const q=quoteTalaRC85({productsMinor:20000n,discountMinor:0n,tipMinor:1000n,
  fulfillment:'merchant_delivery'});
 assert.equal(q.restaurantPayableMinor,21900n);
 assert.equal(q.driverPayableMinor,0n);
 assert.equal(q.platformGrossBeforeStripeAndTaxMinor,4400n);
});
test('pickup: seller receives full tip and no platform driver fee',()=>{
 const q=quoteTalaRC85({productsMinor:20000n,discountMinor:0n,tipMinor:2000n,
  fulfillment:'pickup'});
 assert.equal(q.totalMinor,23400n);
 assert.equal(q.restaurantPayableMinor,19000n);
 assert.equal(q.driverPayableMinor,0n);
 assert.equal(q.platformGrossBeforeStripeAndTaxMinor,4400n);
});
test('invalid discount and negative money cannot be quoted',()=>{
 assert.throws(()=>quoteTalaRC85({productsMinor:100n,discountMinor:101n,tipMinor:0n,fulfillment:'pickup'}));
 assert.throws(()=>quoteTalaRC85({productsMinor:-1n,discountMinor:0n,tipMinor:0n,fulfillment:'pickup'}));
});
