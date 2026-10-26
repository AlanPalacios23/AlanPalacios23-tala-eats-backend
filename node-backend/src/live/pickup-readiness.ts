/** Non-financial LIVE pickup capability projection.
 * Only checkout POST and the Stripe PaymentIntent POST authorize transactions.
 * This is a read-only fail-closed indicator for the customer checkout screen.
 */
export interface PickupMerchant {
 id:number;is_open:boolean;pickup_enabled:boolean;verification_status:string;
 onboarding_status:string;owner_id:number|null;owner_email:string|null;
 owner_active:boolean|null;stripe_account_id:string|null;
 owner_approved_at:Date|null;
}
export interface StripeSellerSnapshot {
 id:string;country?:string|null;email?:string|null;details_submitted?:boolean;
 payouts_enabled?:boolean;capabilities?:{transfers?:string|null}|null;
}
export type PickupCapability={
 restaurant_id:number;order_type:'pickup';ready:boolean;
 cash_enabled:boolean;stripe_enabled:boolean;reason:string;
};
export function pickupCapability(
 merchant:PickupMerchant|null,
 seller:StripeSellerSnapshot|null,
 platformReady:boolean,
 platformStripeAccountId:string|undefined,
 cashFlagEnabled:boolean,
):PickupCapability {
 const id=merchant?.id??0;
 const block=(reason:string):PickupCapability=>({
  restaurant_id:id,order_type:'pickup',ready:false,
  cash_enabled:false,stripe_enabled:false,reason,
 });
 if(!merchant)return block('RESTAURANT_NOT_FOUND');
 if(merchant.verification_status!=='verified'||
    merchant.onboarding_status!=='approved'||
    !merchant.is_open||!merchant.pickup_enabled||
    !merchant.owner_id||!merchant.owner_active||!merchant.owner_email)
   return block('RESTAURANT_NOT_AVAILABLE');
 // Do not advertise real cash orders for a merchant without an approved
 // settlement contract: even physical cash must have platform commission.
 if(!merchant.owner_approved_at||!merchant.stripe_account_id||!seller)
   return block('SELLER_CONNECT_NOT_APPROVED');
 if(!platformReady)return block('LIVE_CHECKOUT_NOT_APPROVED');
 if(seller.id!==merchant.stripe_account_id||
    seller.id===platformStripeAccountId||seller.country!=='MX'||
    seller.email?.trim().toLowerCase()!==merchant.owner_email.trim().toLowerCase()||
    seller.details_submitted!==true||seller.payouts_enabled!==true||
    seller.capabilities?.transfers!=='active')
   return block('SELLER_CONNECT_NOT_READY');
 return {restaurant_id:id,order_type:'pickup',ready:true,
  cash_enabled:cashFlagEnabled,stripe_enabled:true,reason:'READY'};
}
