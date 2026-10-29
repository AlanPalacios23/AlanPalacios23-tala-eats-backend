/** RC11.2/11.3 production CASH-at-door rules. No Stripe charge is created.
 * Before delivery, cash is a RECEIVABLE, never a merchant/driver bank balance.
 * The LIVE server itself must have persisted the customer's checkout intent.
 */
import {config} from '../config.js';
export const liveCashDeliveryReleased=():boolean=>
 config.NODE_ENV==='production'&&
 config.LIVE_DRIVER_PRESENCE_ENABLED==='true'&&
 config.LIVE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&
 config.LIVE_DELIVERY_CASH_DISPATCH_ENABLED==='true'&&
 config.LIVE_DELIVERY_CASH_RELEASE_APPROVED==='true'&&
 config.MERCHANT_MANAGED_DELIVERY!=='true';

export type LiveCashOrder={
 id:number;orderType:string;paymentMethod:string;paymentStatus:string;status:string;
 refundedAmount:{toFixed:(n:number)=>string};
 total:{toFixed:(n:number)=>string};
};
type Reader={stageOrderEvent:{
 findFirst:(args:any)=>Promise<{metadataJson:string}|null>
}};
export const isLiveCashCheckoutProvenance=(metadata:string|null):boolean=>{
 if(!metadata)return false;
 try{
  const v=JSON.parse(metadata);
  return v.source==='checkout'&&v.live_delivery_cash_v1===true&&
    v.stage_driver_fixture!==true&&v.stage_delivery_customer_v1!==true&&
    typeof v.checkout_intent_hmac==='string'&&
    /^[a-f0-9]{64}$/.test(v.checkout_intent_hmac);
 }catch{return false;}
};
export async function liveCashDeliveryTenderAllowed(
 tx:Reader,order:LiveCashOrder,
):Promise<boolean>{
 if(!liveCashDeliveryReleased()||order.orderType!=='delivery'||
    order.paymentMethod!=='cash'||order.paymentStatus!=='pending'||
    order.refundedAmount.toFixed(2)!=='0.00'||
    Number(order.total.toFixed(2))<=0||
    ['cancelled','delivered'].includes(order.status))return false;
 const origin=await tx.stageOrderEvent.findFirst({
  where:{orderId:order.id,status:'received'},orderBy:{id:'asc'},
  select:{metadataJson:true},
 });
 return isLiveCashCheckoutProvenance(origin?.metadataJson??null);
}
