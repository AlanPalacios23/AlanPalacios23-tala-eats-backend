import test from 'node:test';
import assert from 'node:assert/strict';
import {
 calculateMerchantWeek,
} from '../dist/live/weekly-merchant-statement.js';

function order(id,tender,fulfillment){
 const delivery=fulfillment==='platform_delivery';
 const pickup=fulfillment==='pickup';
 const gross=pickup?21400n:25300n;
 const driver=delivery?3200n:0n;
 const platform=pickup?4400n:delivery?5100n:8300n;
 return {orderId:id,restaurantId:77,tender,fulfillment,
  orderCompleted:true,customerPaidMinor:gross,
  merchantEarnedMinor:17000n,driverEarnedMinor:driver,
  platformGrossMinor:platform,cashReceivedByMerchant:tender==='cash',
  stripeCapturedVerified:tender==='stripe',
  stripeFundsAvailable:tender==='stripe',openFinancialCase:false};
}
test('RC13.1 four modes: netted weekly restaurant statement and zero financial writes',()=>{
 const result=calculateMerchantWeek(77,[
  order(1,'cash','pickup'),order(2,'cash','platform_delivery'),
  order(3,'stripe','pickup'),order(4,'stripe','platform_delivery'),
 ]);
 assert.equal(result.totalCustomerPaidMinor,93400n);
 assert.equal(result.totalMerchantEarnedMinor,68000n);
 assert.equal(result.totalDriverEarnedMinor,6400n);
 assert.equal(result.totalPlatformGrossMinor,19000n);
 assert.equal(result.cardPayableMinor,34000n);
 assert.equal(result.cashDuePlatformMinor,12700n);
 assert.equal(result.netPayableToMerchantMinor,21300n);
 assert.equal(result.netDueFromMerchantMinor,0n);
 assert.equal(result.rows[1].cashMerchantHoldingMinor,25300n);
 assert.equal(result.rows[1].cashMerchantOwesPlatformMinor,8300n);
 assert.equal(result.heldOrderCount,0);
 assert.equal(result.readyForHumanReview,true);
 assert.equal(result.bankTransferExecuted,false);
 assert.equal(result.stripeTransferExecuted,false);
 assert.equal(result.cashBankDepositConfirmed,false);
 assert.equal(result.cfdiIssued,false);
});
test('RC13.1 all cash creates merchant debt, never a negative payout',()=>{
 const result=calculateMerchantWeek(77,[
  order(10,'cash','pickup'),order(11,'cash','platform_delivery'),
 ]);
 assert.equal(result.cardPayableMinor,0n);
 assert.equal(result.cashDuePlatformMinor,12700n);
 assert.equal(result.netDueFromMerchantMinor,12700n);
 assert.equal(result.netPayableToMerchantMinor,0n);
});
test('RC13.1 cash with courier not handed to shop is on HOLD',()=>{
 const missing={...order(12,'cash','platform_delivery'),
  cashReceivedByMerchant:false};
 const result=calculateMerchantWeek(77,[missing]);
 assert.equal(result.heldOrderCount,1);
 assert.equal(result.cashDuePlatformMinor,0n);
 assert.equal(result.netPayableToMerchantMinor,0n);
 assert.equal(result.rows[0].cashMerchantHoldingMinor,0n);
 assert.deepEqual(result.rows[0].holdReasons,
  ['CASH_MERCHANT_RECEIPT_NOT_PROVEN']);
 assert.equal(result.readyForHumanReview,false);
});
test('RC13.1 Stripe charge can be verified but held until available',()=>{
 const waiting={...order(13,'stripe','pickup'),
  stripeFundsAvailable:false};
 const result=calculateMerchantWeek(77,[waiting]);
 assert.equal(result.cardPayableMinor,0n);
 assert.equal(result.rows[0].eligibility,'hold');
 assert.deepEqual(result.rows[0].holdReasons,['STRIPE_FUNDS_NOT_AVAILABLE']);
});
test('RC13.1 hold cases, incomplete orders, duplicates and split errors',()=>{
 const disputed={...order(14,'stripe','platform_delivery'),
  openFinancialCase:true};
 const result=calculateMerchantWeek(77,[disputed]);
 assert.equal(result.cardPayableMinor,0n);
 assert.equal(result.heldOrderCount,1);
 assert.throws(()=>calculateMerchantWeek(77,[
  order(15,'cash','pickup'),order(15,'stripe','pickup'),
 ]),/WEEK_DUPLICATE_ORDER/);
 assert.throws(()=>calculateMerchantWeek(77,[{
  ...order(16,'cash','pickup'),merchantEarnedMinor:17100n,
 }]),/WEEK_SPLIT_NOT_CONSERVED/);
 assert.throws(()=>calculateMerchantWeek(77,[{
  ...order(17,'cash','pickup'),restaurantId:999,
 }]),/WEEK_WRONG_RESTAURANT/);
});
