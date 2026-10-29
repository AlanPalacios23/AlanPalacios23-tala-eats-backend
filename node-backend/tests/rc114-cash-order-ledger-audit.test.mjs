import test from 'node:test';
import assert from 'node:assert/strict';
import {auditDeliveredLiveCashOrder as audit}
  from '../src/finance/rc114-cash-order-ledger-audit.mjs';

const order=()=>({
 id:456,orderType:'delivery',paymentMethod:'cash',status:'delivered',
 paymentStatus:'paid',driverId:101,
 subtotal:'100.00',discount:'0.00',deliveryFee:'39.00',tip:'10.00',
 serviceFee:'7.00',total:'156.00',platformCommission:'15.00',
 restaurantPayout:'85.00',driverEarning:'32.00',platformRevenue:'29.00',
 cashCollected:'156.00',refundedAmount:'0.00',
 paymentProcessingFee:'0.00',contributionMargin:'29.00',
});
const ledger=()=>[
 ['gmv','156.00'],['restaurant_payable','85.00'],
 ['driver_payable','42.00'],['platform_revenue','29.00'],
 ['contribution_margin','29.00'],
].map(([account,amount])=>({
 kind:'order_settlement',account,amount,currency:'MXN',direction:'credit',
 idempotencyKey:'order:456:ledger:'+account,
})).concat([{
 kind:'cash_delivery_collection',account:'cash_collected_by_driver',
 amount:'156.00',currency:'MXN',direction:'credit',
 idempotencyKey:'order:456:cash-delivery:collected',
}]);
const pin=()=>({orderId:456,driverId:101,pinVerified:true});
const codes=(o=order(),e=ledger(),p=pin())=>audit(o,e,p).findings;
test('RC11.4 normal cash delivery ties customer, seller, driver and platform in centavos',()=>{
 assert.deepEqual(codes(),[]);
 assert.deepEqual(audit(order(),ledger(),pin()),{
  pass:true,findings:[],withdrawable:false,
 });
});
test('RC11.4 refuses missing/duplicate collection or a wrong collected amount',()=>{
 assert.ok(codes(order(),ledger().slice(0,-1)).includes(
  'LEDGER_ENTRY_COUNT_CASH_COLLECTED_BY_DRIVER'));
 assert.ok(codes(order(),[...ledger(),ledger().at(-1)]).includes(
  'LEDGER_ENTRY_COUNT_CASH_COLLECTED_BY_DRIVER'));
 assert.ok(codes({...order(),cashCollected:'0.00'}).includes(
  'CASH_COLLECTED_MISMATCH'));
});
test('RC11.4 refuses wrong financial allocation and wrong ledger amount',()=>{
 assert.ok(codes({...order(),restaurantPayout:'95.00'}).includes(
  'RESTAURANT_PAYABLE_MISMATCH'));
 const e=ledger();e[2]={...e[2],amount:'41.99'};
 assert.ok(codes(order(),e).includes('LEDGER_AMOUNT_DRIVER_PAYABLE'));
 assert.ok(codes({...order(),platformRevenue:'30.00'}).includes(
  'ORDER_SPLIT_NOT_CONSERVED'));
});
test('RC11.4 refuses forged or absent PIN proof and wrong lifecycle',()=>{
 assert.ok(codes(order(),ledger(),null).includes('MISSING_MATCHING_PIN_PROOF'));
 assert.ok(codes(order(),ledger(),{...pin(),driverId:999}).includes(
  'MISSING_MATCHING_PIN_PROOF'));
 assert.ok(codes({...order(),status:'on_the_way'}).includes(
  'DELIVERY_NOT_PAID_AND_COMPLETED'));
});
test('RC11.4 holds refund/dispute and bad currency/key; never withdrawable',()=>{
 const e=ledger();
 e[0]={...e[0],currency:'USD'};
 assert.ok(codes(order(),e).includes('INVALID_LEDGER_CURRENCY_OR_DIRECTION'));
 const f=ledger();
 f[1]={...f[1],idempotencyKey:'wrong'};
 assert.ok(codes(order(),f).includes('LEDGER_ENTRY_IDENTITY_RESTAURANT_PAYABLE'));
 const g=ledger();
 g.push({kind:'stripe_live_dispute',account:'review',amount:'1.00',
  direction:'debit',currency:'MXN',idempotencyKey:'dispute:1'});
 assert.ok(codes(order(),g).includes('FINANCIAL_RISK_REQUIRES_REVIEW'));
 assert.equal(audit(order(),ledger(),pin()).withdrawable,false);
});
test('RC11.4 refuses false cash contribution margin or unexplained settlement credit',()=>{
 assert.ok(codes({...order(),contributionMargin:'28.00'}).includes(
  'CASH_PROCESSING_OR_MARGIN_MISMATCH'));
 const extra=ledger();extra.push({kind:'order_settlement',account:'bonus',
  amount:'100.00',direction:'credit',currency:'MXN',idempotencyKey:'misc:bonus'});
 assert.ok(codes(order(),extra).includes('UNRECOGNIZED_SETTLEMENT_ACCOUNT'));
});
test('RC11.4 detects invalid money and does not round floats',()=>{
 assert.ok(codes({...order(),total:'156.001'}).includes('INVALID_ORDER_MONEY'));
 assert.ok(codes({...order(),total:'156e2'}).includes('INVALID_ORDER_MONEY'));
 assert.ok(codes({...order(),refundedAmount:'10.00'}).includes(
  'REFUND_REQUIRES_SEPARATE_RECONCILIATION'));
});
