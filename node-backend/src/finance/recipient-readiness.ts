/**
 * Read-only recipient preview for Flutter Restaurant/Driver.
 *
 * Never computes a payout entitlement from an order total or an estimate.
 * In particular:
 * - Cash collected by a restaurant/driver is NOT Stripe balance.
 * - Stripe TEST receipts are NOT transferable live funds.
 * - No balance is withdrawable without actual LIVE Connect transfer capability,
 *   verified payout source, reconciliation, refunds/disputes reserve and KYC.
 * This module intentionally has no provider API/DB writes.
 */
export type RecipientKind='restaurant'|'driver';
export type RecipientOrderSnapshot={
  id:number;
  status:string;
  paymentStatus:string;
  paymentMethod:string;
  orderType:string;
  // Server-side decimal strings. Do not accept client-provided amounts.
  restaurantPayout:string;
  driverEarning:string;
  tip:string;
  cashCollected:string;
  refundedAmount:string;
  total:string;
  /** Must come from the immutable Stripe TEST ledger, never Flutter. */
  stripeReceiptVerified:boolean;
};
export type RecipientPreview={
  currency:'MXN';
  scope:'historical_nonwithdrawable_stage_preview';
  source:'server_order_snapshot';
  pending_review_cash:string;
  pending_review_stripe_test:string;
  available_for_withdrawal:'0.00';
  eligible:false;
  connect_capability_verified:false;
  reconciliation_hold:true;
  includes_unpaid_orders:false;
  complete:boolean;
  sampled_orders:number;
  held_for_review_orders:number;
};
const cents=(raw:string):bigint=>{
  if(!/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(raw))
    throw new Error('UNVERIFIED_FINANCIAL_DECIMAL');
  const [whole,frac]=raw.split('.');
  return BigInt(whole!)*100n+BigInt(frac!);
};
const money=(x:bigint):string=>(x/100n).toString()+'.'+(x%100n).toString().padStart(2,'0');

/** Returned amounts are only estimates for reconciliation, never payout quotes. */
export function previewRecipientOrders(
  recipient:RecipientKind,
  orders:readonly RecipientOrderSnapshot[],
  complete:boolean,
):RecipientPreview {
  if(!complete||orders.length>5000)
    throw new Error('RECIPIENT_PREVIEW_REQUIRES_COMPLETE_PAGINATION');
  const seen=new Set<number>();
  let pendingCash=0n,pendingTest=0n,heldForReview=0;
  for(const order of orders){
    if(!Number.isSafeInteger(order.id)||order.id<=0||seen.has(order.id))
      throw new Error('DUPLICATE_OR_INVALID_ORDER_SNAPSHOT');
    seen.add(order.id);
    if(order.status!=='delivered'||order.paymentStatus!=='paid')continue;
    // Real cash can be physically collected by different parties; it is
    // NOT Stripe receivables or available Connect funds.
    if(order.paymentMethod!=='cash'&&order.paymentMethod!=='stripe')continue;
    if(order.paymentMethod==='stripe'&&order.orderType!=='pickup')continue;
    // Even the non-withdrawable preview must NOT count refunded sales or
    // fraudulent/legacy paid flags without a provider-backed receipt.
    if(cents(order.refundedAmount)!==0n||
       (order.paymentMethod==='stripe'&&!order.stripeReceiptVerified)){
      heldForReview++;
      continue;
    }
    const restaurant=cents(order.restaurantPayout);
    const driver=cents(order.driverEarning);
    const tip=cents(order.tip);
    const physicalCash=cents(order.cashCollected);
    if(restaurant<0n||driver<0n||tip<0n||physicalCash<0n)
      throw new Error('NEGATIVE_FINANCIAL_INPUT');
    const earning=recipient==='restaurant'
      ?restaurant
      :driver+(order.orderType==='delivery'?tip:0n);
    if(order.paymentMethod==='cash')pendingCash+=earning;
    else{
      if(physicalCash!==0n)
        throw new Error('STRIPE_ORDER_CANNOT_CONTAIN_CASH_COLLECTED');
      if(cents(order.total)===0n)
        throw new Error('STRIPE_RECEIPT_ZERO_TOTAL');
      pendingTest+=earning;
    }
  }
  return {
    currency:'MXN',scope:'historical_nonwithdrawable_stage_preview',
    source:'server_order_snapshot',
    pending_review_cash:money(pendingCash),
    pending_review_stripe_test:money(pendingTest),
    available_for_withdrawal:'0.00',eligible:false,
    connect_capability_verified:false,reconciliation_hold:true,
    includes_unpaid_orders:false,complete:true,sampled_orders:orders.length,
    held_for_review_orders:heldForReview,
  };
}
