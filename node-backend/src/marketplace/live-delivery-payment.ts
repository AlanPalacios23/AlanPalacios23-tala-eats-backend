/**
 * RC9.6 — LIVE delivery is never proved by paymentStatus='paid' alone.
 * This contract is dormant until the independent production release gate
 * is approved. No Stripe calls, DB writes or payouts happen in this module.
 */
import {config} from '../config.js';

type Money={toFixed:(places:number)=>string};
type Order={
 id:number;orderType:string;paymentMethod:string;paymentStatus:string;
 paymentProvider:string;paymentProviderId:string;total:Money;refundedAmount:Money;
};
type LedgerRow={account:string;direction:string;kind:string;idempotencyKey:string;amount:Money};
type PgReader={
 stageOrderEvent:{findFirst:(opts:any)=>Promise<{metadataJson:string}|null>};
 stageFinancialLedgerEntry:{
  findUnique:(opts:any)=>Promise<LedgerRow|null>;
  findFirst:(opts:any)=>Promise<LedgerRow|null>;
 };
};

export const liveDispatchReleased=():boolean=>
 config.NODE_ENV==='production'&&
 config.LIVE_DRIVER_PRESENCE_ENABLED==='true'&&
 config.LIVE_DELIVERY_DISPATCH_ENABLED==='true'&&
 config.LIVE_DELIVERY_CARD_CHECKOUT_ENABLED==='true'&&
 config.LIVE_DELIVERY_RELEASE_APPROVED==='true'&&
 config.STRIPE_LIVE_ENABLED==='true'&&
 config.STRIPE_FINANCIAL_WRITES_ENABLED==='true';

export function matchesSignedLiveDeliveryCapture(order:Order,receipt:LedgerRow|null):boolean{
 return order.orderType==='delivery'&&order.paymentMethod==='stripe'&&
  order.paymentStatus==='paid'&&order.paymentProvider==='stripe'&&
  /^pi_[A-Za-z0-9]+$/.test(order.paymentProviderId)&&
  order.refundedAmount.toFixed(2)==='0.00'&&
  order.total.toFixed(2)!=='0.00'&&
  Boolean(receipt&&receipt.account==='stripe_live_collected'&&
   receipt.direction==='credit'&&receipt.kind==='stripe_live_payment'&&
   receipt.idempotencyKey==='order:'+order.id+':stripe-live:collected'&&
   receipt.amount.toFixed(2)===order.total.toFixed(2));
}

/**
 * Require an actual checkout-origin HMAC marker AND matching immutable LIVE
 * signed capture. Any refund, dispute or reversal => HOLD for manual review.
 * A synthetic staging fixture is not recognized in production.
 */
export async function liveDeliveryTenderAllowed(tx:PgReader,order:Order):Promise<boolean>{
 if(!liveDispatchReleased()||order.orderType!=='delivery'||order.paymentMethod!=='stripe')
  return false;
 const received=await tx.stageOrderEvent.findFirst({
  where:{orderId:order.id,status:'received'},orderBy:{id:'asc'},
  select:{metadataJson:true},
 });
 let legitimate=false;
 try{
  const m=JSON.parse(received?.metadataJson??'{}');
  legitimate=m.live_delivery_checkout_v1===true&&
    typeof m.checkout_intent_hmac==='string'&&
    /^[a-f0-9]{64}$/.test(m.checkout_intent_hmac);
 }catch{return false;}
 if(!legitimate)return false;
 const receipt=await tx.stageFinancialLedgerEntry.findUnique({
  where:{idempotencyKey:'order:'+order.id+':stripe-live:collected'},
 });
 if(!matchesSignedLiveDeliveryCapture(order,receipt))return false;
 const risk=await tx.stageFinancialLedgerEntry.findFirst({
  where:{orderId:order.id,OR:[
   {kind:{in:['stripe_live_refund','stripe_live_dispute','order_cancellation','stripe_live_reversal']}},
   {account:'stripe_live_collected',direction:'debit'},
  ]},select:{id:true},
 });
 return risk===null;
}
