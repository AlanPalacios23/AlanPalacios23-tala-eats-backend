/**
 * RC11.4: exact financial integrity audit for Stripe LIVE PICKUP.
 * Does not validate remote Stripe state and NEVER authorizes transfer/payout.
 * A durable signed webhook is necessary, not proof of available Stripe funds.
 * Delivery Stripe is NOT accepted until a separately audited capture adapter.
 */
function minor(v, signed=false){
 const s=typeof v==='string'?v:String(v);
 if(!(signed?/^-?(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/:/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/).test(s))
  throw Error('INVALID_MONEY');
 const neg=s.startsWith('-');
 const [a,b='']=(neg?s.slice(1):s).split('.');
 const n=BigInt(a)*100n+BigInt((b+'00').slice(0,2));
 return neg?-n:n;
}
const result=findings=>({pass:findings.length===0,findings:[...new Set(findings)].sort(),
 withdrawable:false,remoteStripeAttested:false});
export function auditCapturedLiveStripePickup(o,ledger,webhook,received){
 const e=[];
 if(!o||!Number.isSafeInteger(o.id)||o.id<1||!Array.isArray(ledger))
  return result(['AUDIT_INPUT_INVALID']);
 if(o.orderType!=='pickup'||o.paymentMethod!=='stripe')
  return result(['UNSUPPORTED_STRIPE_FULFILLMENT']);
 if(o.paymentStatus!=='paid'||!['received','confirmed','preparing','ready','delivered'].includes(o.status))
  e.push('ORDER_NOT_CAPTURED');
 if(o.paymentProvider!=='stripe'||typeof o.paymentProviderId!=='string'||
  !/^pi_[A-Za-z0-9]+$/.test(o.paymentProviderId))
  e.push('ORDER_PI_NOT_BOUND');
 if(!webhook||webhook.type!=='payment_intent.succeeded'||
    webhook.status!=='PROCESSED'||webhook.stripeAccountId!==null||
    webhook.objectId!==o.paymentProviderId||
    !/^evt_[A-Za-z0-9]+$/.test(webhook.id??''))
  e.push('DURABLE_SIGNED_RECEIPT_MISSING');
 let origin=null;
 try{origin=JSON.parse(received?.metadataJson??'null');}catch{}
 if(!received||received.status!=='received'||origin?.source!=='stripe_live_webhook'||
    origin?.stripe_event_id!==webhook?.id)
  e.push('ORDER_EVENT_WEBHOOK_BINDING_MISSING');
 const fields=[
  'total','subtotal','discount','tip','deliveryFee','serviceFee','platformCommission',
  'restaurantPayout','driverEarning','platformRevenue','paymentProcessingFee',
  'refundedAmount','cashCollected'
 ];
 let a={};try{a=Object.fromEntries(fields.map(k=>[k,minor(o[k])]));}
 catch{return result([...e,'INVALID_ORDER_CENTAVOS']);}
 if(a.total<=0n||a.discount>a.subtotal) e.push('ORDER_AMOUNT_INVALID');
 if(a.deliveryFee!==0n||a.driverEarning!==0n||a.cashCollected!==0n)
  e.push('PICKUP_HAS_DELIVERY_OR_CASH_MONEY');
 if(a.refundedAmount!==0n) e.push('REFUND_REQUIRES_SEPARATE_RECONCILIATION');
 const food=a.subtotal-a.discount;
 if(a.total!==food+a.tip+a.serviceFee)e.push('ORDER_TOTAL_MISMATCH');
 if(a.restaurantPayout!==food-a.platformCommission+a.tip)
  e.push('RESTAURANT_PAYABLE_MISMATCH');
 if(a.platformRevenue!==a.platformCommission+a.serviceFee)
  e.push('PLATFORM_REVENUE_MISMATCH');
 if(a.restaurantPayout+a.platformRevenue!==a.total)
  e.push('PICKUP_SPLIT_MISMATCH');
 const margin=a.platformRevenue-a.paymentProcessingFee;
 const expected=new Map([
  ['gmv',a.total],['restaurant_payable',a.restaurantPayout],
  ['platform_revenue',a.platformRevenue],
  ['payment_processing',-a.paymentProcessingFee],
  ['contribution_margin',margin],
  ['stripe_live_collected',a.total],
 ]);
 const recognized = new Set(expected.keys());
 for(const [account,value] of expected){
  const kind=account==='stripe_live_collected'?'stripe_live_payment':'order_settlement';
  const key='order:'+o.id+(account==='stripe_live_collected'?':stripe-live:collected':':live:ledger:'+account);
  const rows=ledger.filter(x=>x.account===account&&x.kind===kind);
  if(value===0n&&account!=='stripe_live_collected'){
   if(rows.length)e.push('UNEXPECTED_ZERO_ENTRY_'+account.toUpperCase());
   continue;
  }
  if(rows.length!==1){e.push('ENTRY_COUNT_'+account.toUpperCase());continue;}
  const row=rows[0];
  if(row.idempotencyKey!==key||row.currency!=='MXN'||
     row.direction!==(value<0n?'debit':'credit'))
   e.push('ENTRY_IDENTITY_'+account.toUpperCase());
  try{if(minor(row.amount)!==(value<0n?-value:value))
   e.push('ENTRY_AMOUNT_'+account.toUpperCase());}
  catch{e.push('ENTRY_MONEY_INVALID_'+account.toUpperCase());}
 }
 if(new Set(ledger.map(x=>x.idempotencyKey)).size!==ledger.length)
  e.push('DUPLICATE_LEDGER_IDEMPOTENCY');
 if(ledger.some(x=>x.currency!=='MXN'||!['debit','credit'].includes(x.direction)))
  e.push('LEDGER_INVALID_CURRENCY_OR_DIRECTION');
 if(ledger.some(x=>x.kind.includes('refund')||x.kind.includes('dispute')||
  x.kind==='order_cancellation'||x.account==='stripe_live_collected'&&x.direction==='debit'))
  e.push('REVERSAL_OR_DISPUTE_HOLD');
 if(ledger.some(x=>(x.kind==='stripe_live_payment'||x.kind==='order_settlement')&&
   !recognized.has(x.account)))
  e.push('UNRECOGNIZED_SETTLEMENT_ACCOUNT');
 return result(e);
}
