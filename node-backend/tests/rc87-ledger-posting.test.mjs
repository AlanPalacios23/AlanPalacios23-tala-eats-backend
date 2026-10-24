import test from 'node:test';
import assert from 'node:assert/strict';
import {liveSettlementPostings} from '../dist/live/ledger-posting.js';
const paid={
 total:'100.00',restaurantPayout:'85.00',platformRevenue:'15.00',
 paymentProcessingFee:'9.00',contributionMargin:'6.00',
};
test('RC8.7 reconciles positive margin to immutable credits and fee debit',()=>{
 assert.deepEqual(liveSettlementPostings(paid),[
  {account:'gmv',amount:'100.00',direction:'credit'},
  {account:'restaurant_payable',amount:'85.00',direction:'credit'},
  {account:'platform_revenue',amount:'15.00',direction:'credit'},
  {account:'payment_processing',amount:'9.00',direction:'debit'},
  {account:'contribution_margin',amount:'6.00',direction:'credit'},
 ]);
});
test('RC8.7 accepts a legitimate negative margin without blocking Stripe receipt',()=>{
 const result=liveSettlementPostings({
  total:'12.00',restaurantPayout:'10.20',platformRevenue:'1.80',
  paymentProcessingFee:'3.50',contributionMargin:'-1.70',
 });
 assert.deepEqual(result.at(-1),
  {account:'contribution_margin',amount:'1.70',direction:'debit'});
 assert.equal(result.some(x=>x.amount.startsWith('-')),false);
});
test('RC8.7 zero margin never invents an empty ledger entry',()=>{
 const x=liveSettlementPostings({...paid,
  paymentProcessingFee:'15.00',contributionMargin:'0.00'});
 assert.equal(x.some(z=>z.account==='contribution_margin'),false);
});
test('RC8.7 rejects malformed, mismatched or negative cash figures',()=>{
 for(const sample of [
  {...paid,contributionMargin:'8.00'},
  {...paid,platformRevenue:'-2.00'},
  {...paid,paymentProcessingFee:'1e3'},
  {...paid,total:'0.00'},
  {...paid,restaurantPayout:'9999.00'},
  {...paid,contributionMargin:'-1.700'},
 ])assert.throws(()=>liveSettlementPostings(sample),RangeError);
});
