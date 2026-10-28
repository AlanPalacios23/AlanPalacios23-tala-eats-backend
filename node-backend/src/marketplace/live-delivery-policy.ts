/** Pure payment proof policy: test without production env, keys or DB. */
export type LiveMoney={toFixed:(places:number)=>string};
export type LiveDeliveryOrder={
 id:number;orderType:string;paymentMethod:string;paymentStatus:string;
 paymentProvider:string;paymentProviderId:string;total:LiveMoney;refundedAmount:LiveMoney;
};
export type LiveLedgerReceipt={
 account:string;direction:string;kind:string;idempotencyKey:string;amount:LiveMoney;
};
export function matchesSignedLiveDeliveryCapture(order:LiveDeliveryOrder,
 receipt:LiveLedgerReceipt|null):boolean{
 return order.id>0&&order.orderType==='delivery'&&
  order.paymentMethod==='stripe'&&order.paymentStatus==='paid'&&
  order.paymentProvider==='stripe'&&/^pi_[A-Za-z0-9]+$/.test(order.paymentProviderId)&&
  order.refundedAmount.toFixed(2)==='0.00'&&
  order.total.toFixed(2)!=='0.00'&&
  Boolean(receipt&&receipt.account==='stripe_live_collected'&&
   receipt.direction==='credit'&&receipt.kind==='stripe_live_payment'&&
   receipt.idempotencyKey==='order:'+order.id+':stripe-live:collected'&&
   receipt.amount.toFixed(2)===order.total.toFixed(2));
}
export function isRealLiveCheckoutProvenance(metadataJson:string|null):boolean{
 if(!metadataJson)return false;
 try{
  const m=JSON.parse(metadataJson);
  return m.live_delivery_checkout_v1===true&&
   typeof m.checkout_intent_hmac==='string'&&
   /^[a-f0-9]{64}$/.test(m.checkout_intent_hmac);
 }catch{return false;}
}
