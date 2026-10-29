/** RC8.5 financial obligations: integer centavos, no PSP side effects.
 * All amounts must originate from backend-persisted order pricing, never
 * client-submitted estimates. These are PAYABLES, not bank payouts.
 */
export type Fulfillment='pickup'|'platform_delivery'|'merchant_delivery';
export type Tender='stripe'|'cash';
export type Party='restaurant'|'driver';
export type Obligation={party:Party;payeeId:number;amountMinor:number};
export type CashCustody={
 collectorKind:Party;collectorId:number;collectedMinor:number;
 retainedMinor:number;duePlatformMinor:number;state:'awaiting_evidence';
};
export type MoneyPlan={
 fulfillment:Fulfillment;tender:Tender;orderId:number;
 totalMinor:number;obligations:Obligation[];
 grossPlatformMinor:number;cash:CashCustody|null;
 transferCreated:false;
};
export type OrderAmounts={
 orderId:number;restaurantId:number;driverUserId:number|null;
 orderType:string;merchantManagedDelivery:boolean;tender:Tender;
 totalMinor:number;restaurantPayableMinor:number;driverBaseMinor:number;
 tipMinor:number;status:string;paymentStatus:string;
 deliveryProven:boolean;captured:boolean;openCases:number;
};
const valid=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=100000000;
function requireSafe(value:boolean,code:string):void {
 if(!value)throw Error(code);
}
export function buildMoneyPlan(o:OrderAmounts):MoneyPlan{
 for(const n of [o.orderId,o.restaurantId])requireSafe(Number.isSafeInteger(n)&&n>0,'IDENTITY_INVALID');
 for(const n of [o.totalMinor,o.restaurantPayableMinor,o.driverBaseMinor,o.tipMinor])
   requireSafe(valid(n),'INVALID_MONEY');
 requireSafe(['stripe','cash'].includes(o.tender),'TENDER_INVALID');
 const fulfillment:Fulfillment=o.orderType==='pickup'?'pickup':
   o.orderType==='delivery'?
     (o.merchantManagedDelivery?'merchant_delivery':'platform_delivery'):
     (()=>{throw Error('FULFILLMENT_UNSUPPORTED');})();
 // No money earmarked as available until proof of successful completion.
 requireSafe(o.status==='delivered','NOT_DELIVERED');
 requireSafe(o.deliveryProven,'DELIVERY_PROOF_REQUIRED');
 requireSafe(o.openCases===0,'OPEN_INCIDENTS');
 requireSafe(o.tender==='cash'||(o.paymentStatus==='paid'&&o.captured),
   'CAPTURE_NOT_VERIFIED');
 requireSafe(o.tender!=='cash'||o.paymentStatus!=='refunded','CASH_REFUND_HOLD');
 const driver=fulfillment==='platform_delivery'?
   o.driverBaseMinor+o.tipMinor:0;
 requireSafe(valid(driver),'DRIVER_AMOUNT_INVALID');
 if(fulfillment==='platform_delivery')
   requireSafe(Number.isSafeInteger(o.driverUserId)&&Number(o.driverUserId)>0,
     'DRIVER_IDENTITY_REQUIRED');
 else requireSafe(o.driverUserId===null||fulfillment==='merchant_delivery',
   'UNEXPECTED_DRIVER_FOR_PICKUP');
 requireSafe(o.restaurantPayableMinor>0,'SELLER_PAYABLE_MISSING');
 const distribution=o.restaurantPayableMinor+driver;
 requireSafe(valid(distribution)&&distribution<=o.totalMinor,
   'ALLOCATIONS_EXCEED_COLLECTION');
 const obligations:Obligation[]=[
   {party:'restaurant',payeeId:o.restaurantId,amountMinor:o.restaurantPayableMinor}
 ];
 if(fulfillment==='platform_delivery'){
   requireSafe(driver>0,'DRIVER_PAYABLE_MISSING');
   obligations.push({party:'driver',payeeId:o.driverUserId!,amountMinor:driver});
 }
 const cashCollector:CashCustody|null=o.tender==='cash'?(()=>{
   const collector=fulfillment==='platform_delivery'?obligations[1]!:obligations[0]!;
   // A platform courier is a temporary cash CUSTODIAN, never the payee
   // of his delivery wage out of customer money. Entire amount must be
   // handed to the restaurant and independently acknowledged under RC13.5.
   // This obligation is custody before handoff, NOT platform revenue.
   const retained=fulfillment==='platform_delivery'?0:collector.amountMinor;
   return {collectorKind:collector.party,collectorId:collector.payeeId,
     collectedMinor:o.totalMinor,retainedMinor:retained,
     duePlatformMinor:o.totalMinor-retained,state:'awaiting_evidence'};
 })():null;
 return {orderId:o.orderId,fulfillment,tender:o.tender,
   totalMinor:o.totalMinor,obligations,
   grossPlatformMinor:o.totalMinor-distribution,
   cash:cashCollector,transferCreated:false};
}
export function cashStatusTransition(status:string,action:'submit'|'review'|'settle'){
 const transitions={submit:['awaiting_evidence','submitted'],review:['submitted','reviewed'],
   settle:['reviewed','settled']} as const;
 const [from,to]=transitions[action];
 if(status!==from)throw Error('CASH_STATE_TRANSITION_DENIED');
 return to;
}
export function cashCollectorWhoMaySubmit(
 actorId:number,kind:Party,collectorId:number,ownerUserId:number|null
):boolean {
 return Number.isSafeInteger(actorId)&&actorId>0 &&
   (kind==='driver'?actorId===collectorId:actorId===ownerUserId);
}
