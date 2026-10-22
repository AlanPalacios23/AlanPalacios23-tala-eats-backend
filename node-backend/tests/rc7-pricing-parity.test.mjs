import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateDefaultCommercial,fmtCents} from '../dist/finance/pricing.js';

const quote=(overrides={})=>calculateDefaultCommercial({
 policy:'v152',method:'cash',fulfillment:'pickup',
 subtotal:10000n,discount:0n,tip:1000n,...overrides,
});
test('v152 pickup has 15 percent commission and 7 percent service fee',()=>{
 const p=quote();
 assert.equal(fmtCents(p.commission),'15.00');
 assert.equal(fmtCents(p.serviceFee),'7.00');
 assert.equal(fmtCents(p.restaurantPayable),'95.00');
 assert.equal(fmtCents(p.total),'117.00');
});
test('v162 caps service fee at MXN 25',()=>{
 const p=quote({policy:'v162',subtotal:100000n,tip:0n});
 assert.equal(fmtCents(p.serviceFee),'25.00');
 assert.equal(fmtCents(p.total),'1025.00');
});
test('card TEST estimates provider processing separate from platform revenue',()=>{
 const p=quote({method:'stripe'});
 assert.equal(fmtCents(p.gatewayProcessingEstimate),'8.37');
 assert.equal(fmtCents(p.contributionMargin),'13.63');
});
test('delivery tip and base pay follow Python default v162 tariff',()=>{
 const p=quote({policy:'v162',fulfillment:'delivery',tip:1200n,
  distanceMilliKm:3500n});
 assert.equal(fmtCents(p.deliveryFee),'42.50');
 assert.equal(fmtCents(p.driverEarning),'38.00');
 assert.equal(fmtCents(p.driverPayable),'50.00');
 assert.equal(fmtCents(p.total),'161.50');
});
test('negative discount and distance are rejected',()=>{
 assert.throws(()=>quote({discount:20000n}),RangeError);
 assert.throws(()=>quote({distanceMilliKm:-1n}),RangeError);
});
