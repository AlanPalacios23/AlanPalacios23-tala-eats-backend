/** Pure server-side cash checkout receipt marker contract. */
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
