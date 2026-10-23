/**
 * RC8 Stripe LIVE refund reconciliation. This function never creates a
 * refund: it reconciles a real, settled refund already issued in Stripe.
 * Payouts, inventory restoration and disputes remain on HOLD for review.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError} from './guard.js';

type Provider=Pick<Stripe,'events'|'refunds'|'paymentIntents'>;
const decimal=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
function cents(value:string):number {
 if(!decimal.test(value))throw new LiveGateError('REFUND_DECIMAL_INVALID');
 const [whole,fraction]=value.split('.');
 return Number(whole)*100+Number(fraction);
}
const format=(value:number):string=>{
 if(!Number.isSafeInteger(value)||value<0)
   throw new LiveGateError('REFUND_AMOUNT_INVALID');
 return Math.floor(value/100)+'.'+String(value%100).padStart(2,'0');
};
const eventTypes=new Set(['refund.created','refund.updated']);
const Q={
 recorded:'SELECT type,"objectId","stripeAccountId" FROM stripe_webhook_events WHERE id=$1',
 receipt:'SELECT type,"objectId",status FROM stripe_webhook_events WHERE id=$1 AND "stripeAccountId" IS NULL FOR UPDATE',
 order:'SELECT id,user_id,restaurant_id,total::text,refunded_amount::text,payment_provider_id,payment_status,payment_method,payment_provider FROM orders WHERE id=$1 FOR UPDATE',
 original:"SELECT amount::text AS amount FROM financial_ledger_entries WHERE order_id=$1 AND account='stripe_live_collected' AND kind='stripe_live_payment' AND direction='credit' AND idempotency_key=$2 FOR UPDATE",
 duplicate:'SELECT order_id,amount::text AS amount FROM financial_ledger_entries WHERE idempotency_key=$1 FOR UPDATE',
 debit:"INSERT INTO financial_ledger_entries (order_id,user_id,restaurant_id,account,direction,amount,currency,kind,description,idempotency_key,created_at) VALUES($1,$2,$3,'stripe_live_collected','debit',$4,'MXN','stripe_live_refund','Stripe LIVE refund confirmed; payout/inventory HOLD',$5,NOW())",
 update:'UPDATE orders SET refunded_amount=$1,payment_status=$2 WHERE id=$3 AND refunded_amount=$4::numeric AND payment_provider_id=$5 RETURNING id',
 outbox:"INSERT INTO event_outbox (event_key,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,last_error,created_at) VALUES($1,'order',$2,'order.refund_review_required',$3,'pending',0,'',NOW())",
 orderEvent:"INSERT INTO order_events (order_id,status,actor_user_id,metadata_json,created_at) VALUES($1,'refund_review',$2,$3,NOW())",
 processed:"UPDATE stripe_webhook_events SET status='PROCESSED',\"processedAt\"=NOW() WHERE id=$1",
};
export async function reconcileRecordedLiveRefund(
 eventId:string,provider:Provider,pool:Pool
):Promise<{received:true;alreadyProcessed:boolean;manualReviewRequired:true}> {
 if(!/^evt_[A-Za-z0-9]+$/.test(eventId))
   throw new LiveGateError('BAD_REFUND_EVENT_ID');
 const stored=await pool.query<{type:string;objectId:string;stripeAccountId:string|null}>(Q.recorded,[eventId]);
 const saved=stored.rows[0];
 if(!saved||saved.stripeAccountId!==null||
    !eventTypes.has(saved.type)||!/^re_[A-Za-z0-9]+$/.test(saved.objectId))
   throw new LiveGateError('REFUND_SIGNED_RECEIPT_NOT_FOUND');
 const signed=await provider.events.retrieve(eventId);
 if(!signed.livemode||signed.account||signed.id!==eventId||
    signed.type!==saved.type||
    (signed.data.object as {id?:string}).id!==saved.objectId)
   throw new LiveGateError('REFUND_REMOTE_EVENT_MISMATCH');
 const refund=await provider.refunds.retrieve(saved.objectId);
 const piId=typeof refund.payment_intent==='string'?refund.payment_intent:null;
 // Refund has no livemode field in Stripe SDK v23. LIVE is proven by
 // the signed Stripe event and the independently retrieved PaymentIntent.
 if(refund.id!==saved.objectId||
    refund.status!=='succeeded'||refund.currency!=='mxn'||
    !Number.isSafeInteger(refund.amount)||refund.amount<1||
    !piId||!/^pi_[A-Za-z0-9]+$/.test(piId))
   throw new LiveGateError('REFUND_NOT_CONFIRMED');
 const pi=await provider.paymentIntents.retrieve(piId);
 const orderId=Number(pi.metadata.order_id);
 const buyerId=Number(pi.metadata.buyer_id);
 if(!pi.livemode||pi.id!==piId||pi.currency!=='mxn'||
    pi.status!=='succeeded'||pi.amount_received!==pi.amount||
    pi.metadata.tala_mode!=='rc8_live_pickup'||
    !/^[1-9][0-9]{0,9}$/.test(pi.metadata.order_id??'')||
    !/^[1-9][0-9]{0,9}$/.test(pi.metadata.buyer_id??'')||
    !Number.isSafeInteger(orderId)||!Number.isSafeInteger(buyerId)||
    refund.amount>pi.amount)
   throw new LiveGateError('REFUND_PI_IDENTITY_INVALID');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const receipt=await client.query<{type:string;objectId:string;status:string}>(Q.receipt,[eventId]);
  if(receipt.rows.length!==1||receipt.rows[0]?.type!==saved.type||
     receipt.rows[0]?.objectId!==saved.objectId)
    throw new LiveGateError('REFUND_RECEIPT_CONFLICT');
  if(receipt.rows[0]?.status==='PROCESSED'){
   await client.query('COMMIT');
   return {received:true,alreadyProcessed:true,manualReviewRequired:true};
  }
  const found=await client.query<{
   id:number;user_id:number;restaurant_id:number;total:string;
   refunded_amount:string;payment_provider_id:string;payment_status:string;
   payment_method:string;payment_provider:string;
  }>(Q.order,[orderId]);
  const order=found.rows[0];
  if(!order||order.user_id!==buyerId||order.payment_provider_id!==piId||
     order.payment_method!=='stripe'||order.payment_provider!=='stripe'||
     !['paid','partially_refunded','refunded'].includes(order.payment_status)||
     cents(order.total)!==pi.amount)
    throw new LiveGateError('REFUND_ORDER_IDENTITY_INVALID');
  const original=await client.query<{amount:string}>(Q.original,[
   orderId,'order:'+orderId+':stripe-live:collected'
  ]);
  if(original.rows.length!==1||cents(original.rows[0]!.amount)!==pi.amount)
    throw new LiveGateError('REFUND_CAPTURE_RECEIPT_MISSING');
  // Stripe refund ID, not webhook event ID, prevents posting the same money twice.
  const key='stripe-live:refund:'+refund.id+':collected';
  const existing=await client.query<{order_id:number;amount:string}>(Q.duplicate,[key]);
  if(existing.rows.length>1||(existing.rows.length===1&&(
    existing.rows[0]!.order_id!==orderId||
    cents(existing.rows[0]!.amount)!==refund.amount)))
    throw new LiveGateError('REFUND_LEDGER_DUPLICATE_CONFLICT');
  if(existing.rows.length===0){
   const previous=cents(order.refunded_amount);
   const next=previous+refund.amount;
   if(!Number.isSafeInteger(next)||next>pi.amount)
     throw new LiveGateError('REFUND_CUMULATIVE_OVERFLOW');
   await client.query(Q.debit,[orderId,buyerId,order.restaurant_id,
    format(refund.amount),key]);
   const state=next===pi.amount?'refunded':'partially_refunded';
   const updated=await client.query(Q.update,[
    format(next),state,orderId,order.refunded_amount,piId]);
   if(updated.rowCount!==1)
     throw new LiveGateError('REFUND_STATE_CAS_FAILED');
   await client.query(Q.outbox,[
    'order:'+orderId+':stripe-refund:'+refund.id,String(orderId),
    JSON.stringify({order_id:orderId,payment_status:state,refund_id:refund.id,
     provider:'stripe_live',payout:'hold',inventory:'hold'})]);
   await client.query(Q.orderEvent,[orderId,buyerId,
    JSON.stringify({source:'stripe_live_refund',stripe_event_id:eventId,refund_id:refund.id})]);
  }else{
   if(cents(order.refunded_amount)<refund.amount)
     throw new LiveGateError('REFUND_LEDGER_BALANCE_CONFLICT');
  }
  await client.query(Q.processed,[eventId]);
  await client.query('COMMIT');
  return {received:true,alreadyProcessed:existing.rows.length===1,
   manualReviewRequired:true};
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{client.release();}
}
