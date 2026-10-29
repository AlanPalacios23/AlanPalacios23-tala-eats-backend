/**
 * RC13.1 — READ-ONLY merchant weekly settlement statement calculator.
 * No DB writes, bank/SPEI or Stripe calls, balance creation or tax CFDI.
 * Cash is owned by the shop ONLY after a confirmed physical handover.
 * Independent integer-centavo conservation for every delivered order.
 */
export type MerchantWeekTender='cash'|'stripe';
export type MerchantWeekOrder={
 orderId:number;restaurantId:number;tender:MerchantWeekTender;
 fulfillment:'pickup'|'platform_delivery'|'merchant_delivery';
 orderCompleted:boolean;
 customerPaidMinor:bigint;merchantEarnedMinor:bigint;
 driverEarnedMinor:bigint;platformGrossMinor:bigint;
 cashReceivedByMerchant:boolean; // includes 2-actor courier->shop handover
 stripeCapturedVerified:boolean; // actual signed PSP collection evidence
 stripeFundsAvailable:boolean;  // confirmed settlement, NOT only 'paid'
 openFinancialCase:boolean;
};
export type MerchantWeekRow={
 orderId:number;tender:MerchantWeekTender;fulfillment:MerchantWeekOrder['fulfillment'];
 customerPaidMinor:bigint;merchantEarnedMinor:bigint;driverEarnedMinor:bigint;
 platformGrossMinor:bigint;cashMerchantHoldingMinor:bigint;
 cashMerchantOwesPlatformMinor:bigint;cardPlatformOwesMerchantMinor:bigint;
 eligibility:'eligible'|'hold';holdReasons:string[];
};
export type MerchantWeekSummary={
 restaurantId:number;currency:'MXN';rows:MerchantWeekRow[];
 totalCustomerPaidMinor:bigint;totalMerchantEarnedMinor:bigint;
 totalDriverEarnedMinor:bigint;totalPlatformGrossMinor:bigint;
 // These are mutually exclusive outputs of NETTING, not transfer receipts.
 cardPayableMinor:bigint;cashDuePlatformMinor:bigint;
 netPayableToMerchantMinor:bigint;netDueFromMerchantMinor:bigint;
 heldOrderCount:number;readyForHumanReview:boolean;
 bankTransferExecuted:false;stripeTransferExecuted:false;
 cashBankDepositConfirmed:false;cfdiIssued:false;
};
const MAX=10_000_000_000n;
const nonnegative=(v:bigint)=>typeof v==='bigint'&&v>=0n&&v<=MAX;
function requireValue(ok:boolean,reason:string):void{
 if(!ok)throw Error(reason);
}
export function calculateMerchantWeek(
 restaurantId:number,orders:readonly MerchantWeekOrder[],
):MerchantWeekSummary{
 requireValue(Number.isSafeInteger(restaurantId)&&restaurantId>0,
  'WEEK_INVALID_RESTAURANT');
 requireValue(orders.length<=100000,'WEEK_TOO_MANY_ORDERS');
 const seen=new Set<number>(),rows:MerchantWeekRow[]=[];
 let totalCustomer=0n,totalMerchant=0n,totalDriver=0n,totalPlatform=0n;
 let cardPayable=0n,cashDue=0n,held=0;
 for(const order of orders){
  requireValue(Number.isSafeInteger(order.orderId)&&order.orderId>0,
   'WEEK_INVALID_ORDER');
  requireValue(!seen.has(order.orderId),'WEEK_DUPLICATE_ORDER');
  seen.add(order.orderId);
  requireValue(order.restaurantId===restaurantId,'WEEK_WRONG_RESTAURANT');
  requireValue(['cash','stripe'].includes(order.tender),'WEEK_TENDER_INVALID');
  requireValue(['pickup','platform_delivery','merchant_delivery'].includes(
   order.fulfillment),'WEEK_FULFILLMENT_INVALID');
  const amounts=[order.customerPaidMinor,order.merchantEarnedMinor,
   order.driverEarnedMinor,order.platformGrossMinor];
  requireValue(amounts.every(nonnegative),'WEEK_INVALID_MONEY');
  requireValue(order.customerPaidMinor>0n&&order.merchantEarnedMinor>0n,
   'WEEK_EMPTY_ORDER');
  requireValue(order.customerPaidMinor===
   order.merchantEarnedMinor+order.driverEarnedMinor+
   order.platformGrossMinor,'WEEK_SPLIT_NOT_CONSERVED');
  requireValue(order.fulfillment!=='pickup'||order.driverEarnedMinor===0n,
   'WEEK_PICKUP_DRIVER_INVALID');
  const holdReasons:string[]=[];
  if(!order.orderCompleted)holdReasons.push('ORDER_NOT_DELIVERED');
  if(order.openFinancialCase)holdReasons.push('OPEN_FINANCIAL_CASE');
  if(order.tender==='cash'&&!order.cashReceivedByMerchant)
   holdReasons.push('CASH_MERCHANT_RECEIPT_NOT_PROVEN');
  if(order.tender==='stripe'&&!order.stripeCapturedVerified)
   holdReasons.push('STRIPE_CAPTURE_NOT_RECONCILED');
  if(order.tender==='stripe'&&!order.stripeFundsAvailable)
   holdReasons.push('STRIPE_FUNDS_NOT_AVAILABLE');
  const eligible=holdReasons.length===0;
  const cashMerchantHolding=order.tender==='cash'&&eligible?
   order.customerPaidMinor:0n;
  // Full cash amount is in shop's custody; net settlement charges the shop
  // for platform gross plus delivery driver earned (paid independently).
  const cashMerchantOwes=order.tender==='cash'&&eligible?
   order.customerPaidMinor-order.merchantEarnedMinor:0n;
  const cardPlatformOwes=order.tender==='stripe'&&eligible?
   order.merchantEarnedMinor:0n;
  rows.push({
   orderId:order.orderId,tender:order.tender,fulfillment:order.fulfillment,
   customerPaidMinor:order.customerPaidMinor,
   merchantEarnedMinor:order.merchantEarnedMinor,
   driverEarnedMinor:order.driverEarnedMinor,
   platformGrossMinor:order.platformGrossMinor,
   cashMerchantHoldingMinor:cashMerchantHolding,
   cashMerchantOwesPlatformMinor:cashMerchantOwes,
   cardPlatformOwesMerchantMinor:cardPlatformOwes,
   eligibility:eligible?'eligible':'hold',holdReasons,
  });
  totalCustomer+=order.customerPaidMinor;
  totalMerchant+=order.merchantEarnedMinor;
  totalDriver+=order.driverEarnedMinor;
  totalPlatform+=order.platformGrossMinor;
  if(eligible){cashDue+=cashMerchantOwes;cardPayable+=cardPlatformOwes;}
  else held++;
 }
 const net=cardPayable-cashDue;
 return {
  restaurantId,currency:'MXN',rows,
  totalCustomerPaidMinor:totalCustomer,
  totalMerchantEarnedMinor:totalMerchant,
  totalDriverEarnedMinor:totalDriver,
  totalPlatformGrossMinor:totalPlatform,
  cardPayableMinor:cardPayable,cashDuePlatformMinor:cashDue,
  netPayableToMerchantMinor:net>0n?net:0n,
  netDueFromMerchantMinor:net<0n?-net:0n,
  heldOrderCount:held,readyForHumanReview:held===0,
  bankTransferExecuted:false,stripeTransferExecuted:false,
  cashBankDepositConfirmed:false,cfdiIssued:false,
 };
}
