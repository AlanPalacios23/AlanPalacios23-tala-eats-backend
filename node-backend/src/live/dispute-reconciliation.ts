/**
 * RC8 LIVE: durably link a verified Stripe dispute to a captured Tala Eats
 * order and require manual finance review. No automatic dispute acceptance,
 * fund transfer, charge reversal, payouts or inventory changes.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError} from './guard.js';

type Provider=Pick<Stripe,'events'|'disputes'|'charges'|'paymentIntents'>;
const allowed=new Set(['charge.dispute.created','charge.dispute.closed']);
const positive=/^[1-9][0-9]{0,9}$/;
const decimal=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
const cents=(value:string)=>{
 if(!decimal.test(value))throw new LiveGateError('DISPUTE_ORDER_AMOUNT_INVALID');
 const [a,b]=value.split('.');
 return Number(a)*100+Number(b);
};
export async function holdRecordedLiveDispute(
 eventId:string,provider:Provider,pool:Pool
):Promise<{received:true;alreadyProcessed:boolean;manualReviewRequired:true}>{
 if(!/^evt_[A-Za-z0-9]+$/.test(eventId))
  throw new LiveGateError('DISPUTE_EVENT_ID_INVALID');
 const recorded=await pool.query<{type:string;objectId:string;stripeAccountId:string|null}>(
  'SELECT type,"objectId","stripeAccountId" FROM stripe_webhook_events WHERE id=$1',[eventId]);
 const original=recorded.rows[0];
 if(!original||original.stripeAccountId!==null||!allowed.has(original.type)||
    !/^dp_[A-Za-z0-9]+$/.test(original.objectId))
  throw new LiveGateError('DISPUTE_SIGNED_RECEIPT_MISSING');
 const signed=await provider.events.retrieve(eventId);
 if(!signed.livemode||signed.account||signed.id!==eventId||
    signed.type!==original.type||
    (signed.data.object as {id?:string}).id!==original.objectId)
  throw new LiveGateError('DISPUTE_SIGNED_REMOTE_MISMATCH');
 // Stripe objects are re-fetched: event order and snapshot state are untrusted.
 const dispute=await provider.disputes.retrieve(original.objectId);
 const chargeId=typeof dispute.charge==='string'?dispute.charge:dispute.charge?.id;
 if(dispute.id!==original.objectId||!chargeId||
    !/^ch_[A-Za-z0-9]+$/.test(chargeId)||
    !Number.isSafeInteger(dispute.amount)||dispute.amount<1||
    dispute.currency!=='mxn')
  throw new LiveGateError('DISPUTE_REMOTE_DETAILS_INVALID');
 const charge=await provider.charges.retrieve(chargeId);
 const piId=typeof charge.payment_intent==='string'?
  charge.payment_intent:charge.payment_intent?.id;
 if(!charge.livemode||charge.id!==chargeId||!piId||
    !/^pi_[A-Za-z0-9]+$/.test(piId)||charge.currency!=='mxn'||
    !charge.paid||!Number.isSafeInteger(charge.amount)||
    dispute.amount>charge.amount)
  throw new LiveGateError('DISPUTE_CHARGE_PROOF_INVALID');
 const pi=await provider.paymentIntents.retrieve(piId);
 const orderId=Number(pi.metadata.order_id);
 const buyerId=Number(pi.metadata.buyer_id);
 if(!pi.livemode||pi.id!==piId||pi.currency!=='mxn'||
    pi.status!=='succeeded'||pi.amount_received!==pi.amount||
    pi.metadata.tala_mode!=='rc8_live_pickup'||
    !positive.test(pi.metadata.order_id??'')||
    !positive.test(pi.metadata.buyer_id??'')||
    !Number.isSafeInteger(orderId)||!Number.isSafeInteger(buyerId)||
    pi.amount!==charge.amount)
  throw new LiveGateError('DISPUTE_PAYMENT_IDENTITY_INVALID');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const found=await client.query<{type:string;objectId:string;status:string}>(
   'SELECT type,"objectId",status FROM stripe_webhook_events WHERE id=$1 AND "stripeAccountId" IS NULL FOR UPDATE',
   [eventId]);
  const row=found.rows[0];
  if(!row||row.type!==original.type||row.objectId!==original.objectId)
    throw new LiveGateError('DISPUTE_RECEIPT_CHANGED');
  if(row.status==='PROCESSED'){
   await client.query('COMMIT');
   return {received:true,alreadyProcessed:true,manualReviewRequired:true};
  }
  const orders=await client.query<{
   id:number;user_id:number;restaurant_id:number;total:string;
   payment_method:string;payment_provider:string;payment_provider_id:string;
   payment_status:string;
  }>(
   'SELECT id,user_id,restaurant_id,total::text,payment_method,payment_provider,payment_provider_id,payment_status FROM orders WHERE id=$1 FOR UPDATE',
   [orderId]);
  const order=orders.rows[0];
  if(!order||order.user_id!==buyerId||
     order.payment_method!=='stripe'||order.payment_provider!=='stripe'||
     order.payment_provider_id!==piId||
     !['paid','partially_refunded','refunded'].includes(order.payment_status)||
     cents(order.total)!==pi.amount)
   throw new LiveGateError('DISPUTE_ORDER_NOT_CAPTURED');
  const originalCapture=await client.query<{amount:string}>(
   "SELECT amount::text AS amount FROM financial_ledger_entries WHERE order_id=$1 AND account='stripe_live_collected' AND kind='stripe_live_payment' AND direction='credit' AND idempotency_key=$2 FOR UPDATE",
   [orderId,'order:'+orderId+':stripe-live:collected']);
  if(originalCapture.rows.length!==1||
     cents(originalCapture.rows[0]!.amount)!==pi.amount)
   throw new LiveGateError('DISPUTE_CAPTURE_LEDGER_NOT_FOUND');
  // Persistent manual review marker: even if a notification is delivered,
  // the financial readiness SQL must keep it on HOLD until audited resolution.
  await client.query(
   "INSERT INTO event_outbox(event_key,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,last_error,created_at) VALUES($1,'order',$2,'order.dispute_review_required',$3,'pending',0,'',NOW()) ON CONFLICT(event_key) DO NOTHING",
   ['order:'+orderId+':stripe-live-dispute:'+dispute.id+':'+original.type,
    String(orderId),
    JSON.stringify({order_id:orderId,dispute_id:dispute.id,
     event_type:original.type,provider:'stripe_live',
     inventory:'hold',merchant_payout:'hold',manual_review_required:true})]);
  await client.query(
   "INSERT INTO order_events(order_id,status,actor_user_id,metadata_json,created_at) VALUES($1,'dispute_review',NULL,$2,NOW())",
   [orderId,JSON.stringify({source:'stripe_live_dispute',
    stripe_event_id:eventId,dispute_id:dispute.id})]);
  await client.query(
   'UPDATE stripe_webhook_events SET status=$2,"processedAt"=NOW() WHERE id=$1',
   [eventId,'PROCESSED']);
  await client.query('COMMIT');
  return {received:true,alreadyProcessed:false,manualReviewRequired:true};
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{client.release();}
}
