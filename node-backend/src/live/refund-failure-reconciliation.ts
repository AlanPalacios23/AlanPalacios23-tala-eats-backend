/**
 * Process a Stripe LIVE refund.failed that arrived via a signed durable inbox.
 * This DOES NOT initiate a Stripe action. The original refund debit remains
 * immutable and a once-only credit compensates the returned funds. Merchant
 * payouts and inventory are held for manual review.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError} from './guard.js';

type Provider=Pick<Stripe,'events'|'refunds'|'paymentIntents'>;
const money=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
const minor=(raw:string):number=>{
 if(!money.test(raw))throw new LiveGateError('REFUND_FAILURE_MONEY_INVALID');
 const [a,b]=raw.split('.');return Number(a)*100+Number(b);
};
const format=(n:number):string=>{
 if(!Number.isSafeInteger(n)||n<0)throw new LiveGateError('REFUND_FAILURE_AMOUNT_INVALID');
 return Math.floor(n/100)+'.'+String(n%100).padStart(2,'0');
};
export async function reconcileRecordedLiveRefundFailure(
 eventId:string,provider:Provider,pool:Pool
):Promise<{received:true;alreadyProcessed:boolean;manualReviewRequired:true}>{
 if(!/^evt_[A-Za-z0-9]+$/.test(eventId))
  throw new LiveGateError('REFUND_FAILURE_ID_INVALID');
 const recorded=await pool.query<{type:string;objectId:string;stripeAccountId:string|null}>(
  'SELECT type,"objectId","stripeAccountId" FROM stripe_webhook_events WHERE id=$1',[eventId]);
 const rec=recorded.rows[0];
 if(!rec||rec.type!=='refund.failed'||rec.stripeAccountId!==null||
    !/^re_[A-Za-z0-9]+$/.test(rec.objectId))
  throw new LiveGateError('SIGNED_REFUND_FAILURE_MISSING');
 const event=await provider.events.retrieve(eventId);
 if(!event.livemode||event.account||event.id!==eventId||event.type!==rec.type||
   (event.data.object as {id?:string}).id!==rec.objectId)
  throw new LiveGateError('REMOTE_REFUND_FAILURE_EVENT_MISMATCH');
 const refund=await provider.refunds.retrieve(rec.objectId);
 const piId=typeof refund.payment_intent==='string'?refund.payment_intent:null;
 if(refund.id!==rec.objectId||refund.status!=='failed'||refund.currency!=='mxn'||
    !Number.isSafeInteger(refund.amount)||refund.amount<1||
    !piId||!/^pi_[A-Za-z0-9]+$/.test(piId))
  throw new LiveGateError('REFUND_NOT_FAILED_OR_UNBOUND');
 const pi=await provider.paymentIntents.retrieve(piId);
 const id=Number(pi.metadata.order_id),buyer=Number(pi.metadata.buyer_id);
 if(!pi.livemode||pi.id!==piId||pi.status!=='succeeded'||
    pi.currency!=='mxn'||pi.amount_received!==pi.amount||
    pi.metadata.tala_mode!=='rc8_live_pickup'||
    !/^[1-9][0-9]{0,9}$/.test(pi.metadata.order_id??'')||
    !/^[1-9][0-9]{0,9}$/.test(pi.metadata.buyer_id??'')||
    !Number.isSafeInteger(id)||!Number.isSafeInteger(buyer)||
    refund.amount>pi.amount)
  throw new LiveGateError('REFUND_FAILURE_PI_INVALID');

 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const lock=await client.query<{type:string;objectId:string;status:string}>(
   'SELECT type,"objectId",status FROM stripe_webhook_events WHERE id=$1 AND "stripeAccountId" IS NULL FOR UPDATE',[eventId]);
  if(lock.rows.length!==1||lock.rows[0]!.type!==rec.type||
     lock.rows[0]!.objectId!==rec.objectId)
    throw new LiveGateError('REFUND_FAILURE_INBOX_CHANGED');
  if(lock.rows[0]!.status==='PROCESSED'){
   await client.query('COMMIT');
   return {received:true,alreadyProcessed:true,manualReviewRequired:true};
  }
  const rows=await client.query<{
   id:number;user_id:number;restaurant_id:number;total:string;
   refunded_amount:string;payment_provider_id:string;payment_method:string;
   payment_provider:string;payment_status:string;
  }>(
   'SELECT id,user_id,restaurant_id,total::text,refunded_amount::text,payment_provider_id,payment_method,payment_provider,payment_status FROM orders WHERE id=$1 FOR UPDATE',[id]);
  const order=rows.rows[0];
  if(!order||order.user_id!==buyer||order.payment_provider_id!==piId||
     order.payment_method!=='stripe'||order.payment_provider!=='stripe'||
     !['partially_refunded','refunded'].includes(order.payment_status)||
     minor(order.total)!==pi.amount)
    throw new LiveGateError('REFUND_FAILURE_ORDER_MISMATCH');
  const refundKey='stripe-live:refund:'+refund.id+':collected';
  const original=await client.query<{order_id:number;amount:string}>(
   "SELECT order_id,amount::text AS amount FROM financial_ledger_entries WHERE idempotency_key=$1 AND account='stripe_live_collected' AND kind='stripe_live_refund' AND direction='debit' FOR UPDATE",
   [refundKey]);
  if(original.rows.length!==1||original.rows[0]!.order_id!==id||
     minor(original.rows[0]!.amount)!==refund.amount)
   throw new LiveGateError('FAILED_REFUND_ORIGINAL_LEDGER_MISSING');
  const reversalKey='stripe-live:refund-failed:'+refund.id+':collected';
  const reversed=await client.query<{order_id:number;amount:string}>(
   'SELECT order_id,amount::text AS amount FROM financial_ledger_entries WHERE idempotency_key=$1 FOR UPDATE',
   [reversalKey]);
  if(reversed.rows.length>1||(reversed.rows.length===1&&
     (reversed.rows[0]!.order_id!==id||minor(reversed.rows[0]!.amount)!==refund.amount)))
   throw new LiveGateError('FAILED_REFUND_REVERSAL_CONFLICT');
  if(reversed.rows.length===0){
   const previous=minor(order.refunded_amount);
   if(previous<refund.amount)throw new LiveGateError('FAILED_REFUND_EXCEEDS_BALANCE');
   const next=previous-refund.amount;
   await client.query(
    "INSERT INTO financial_ledger_entries(order_id,user_id,restaurant_id,account,direction,amount,currency,kind,description,idempotency_key,created_at) VALUES($1,$2,$3,'stripe_live_collected','credit',$4,'MXN','stripe_live_refund_failure','Stripe LIVE refund failed; review seller/inventory HOLD',$5,NOW())",
    [id,buyer,order.restaurant_id,format(refund.amount),reversalKey]);
   const changed=await client.query(
    'UPDATE orders SET refunded_amount=$1,payment_status=$2 WHERE id=$3 AND refunded_amount=$4::numeric AND payment_provider_id=$5 RETURNING id',
    [format(next),next===0?'paid':'partially_refunded',id,order.refunded_amount,piId]);
   if(changed.rowCount!==1)throw new LiveGateError('FAILED_REFUND_CAS_CONFLICT');
   await client.query(
    "INSERT INTO event_outbox(event_key,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,last_error,created_at) VALUES($1,'order',$2,'order.refund_failure_review_required',$3,'pending',0,'',NOW())",
    ['order:'+id+':stripe-refund-failed:'+refund.id,String(id),
     JSON.stringify({order_id:id,refund_id:refund.id,provider:'stripe_live',payout:'hold',inventory:'hold'})]);
   await client.query(
    "INSERT INTO order_events(order_id,status,actor_user_id,metadata_json,created_at) VALUES($1,'refund_review',$2,$3,NOW())",
    [id,buyer,JSON.stringify({source:'stripe_live_refund_failed',stripe_event_id:eventId,refund_id:refund.id})]);
  }else{
   // Another verified failed event has already reversed this refund.
   // Do not mutate balances twice.
   if(minor(order.refunded_amount)>pi.amount)
     throw new LiveGateError('FAILED_REFUND_BALANCE_INVALID');
  }
  await client.query(
   "INSERT INTO tala_live_financial_cases (order_id,case_type,stripe_object_id,last_event_id,status,updated_at) VALUES ($1,'refund_failure',$2,$3,'open',NOW()) ON CONFLICT(case_type,stripe_object_id) DO UPDATE SET last_event_id=EXCLUDED.last_event_id,status='open',reviewed_by_user_id=NULL,reviewed_at=NULL,resolved_by_user_id=NULL,resolved_at=NULL,evidence_ref=NULL,updated_at=NOW()",
   [id,refund.id,eventId]);
  await client.query(
   'UPDATE stripe_webhook_events SET status=$2,"processedAt"=NOW() WHERE id=$1',
   [eventId,'PROCESSED']);
  await client.query('COMMIT');
  return {received:true,alreadyProcessed:reversed.rows.length===1,manualReviewRequired:true};
 }catch(e){
  await client.query('ROLLBACK').catch(()=>{});
  throw e;
 }finally{client.release();}
}
