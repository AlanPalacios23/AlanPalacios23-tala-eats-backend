/**
 * A declined Stripe LIVE PaymentIntent is NOT a captured charge.
 *
 * Reconcile the signed, durable payment_intent.payment_failed receipt only
 * after Stripe re-fetch and order binding. A card failure must not globally
 * block readiness forever, cancel an order, release stock or post a ledger.
 * The customer may supply another payment method for the same Intent.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError} from './guard.js';

type Provider=Pick<Stripe,'events'|'paymentIntents'>;
const pos=/^[1-9][0-9]{0,9}$/;
const decimal=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
function cents(value:string):number {
 if(!decimal.test(value))throw new LiveGateError('DECLINE_ORDER_AMOUNT_INVALID');
 const [a,b]=value.split('.');
 return Number(a)*100+Number(b);
}
export async function reconcileRecordedLivePaymentFailure(
 eventId:string,provider:Provider,pool:Pool
):Promise<{received:true;alreadyProcessed:boolean;charged:false}>{
 if(!/^evt_[A-Za-z0-9]+$/.test(eventId))
  throw new LiveGateError('DECLINE_EVENT_INVALID');
 const persisted=await pool.query<{type:string;objectId:string;stripeAccountId:string|null}>(
  'SELECT type,"objectId","stripeAccountId" FROM stripe_webhook_events WHERE id=$1',[eventId]);
 const e=persisted.rows[0];
 if(!e||e.type!=='payment_intent.payment_failed'||e.stripeAccountId!==null||
    !/^pi_[A-Za-z0-9]+$/.test(e.objectId))
  throw new LiveGateError('DECLINE_SIGNED_RECEIPT_MISSING');
 const event=await provider.events.retrieve(eventId);
 if(!event.livemode||event.account||event.id!==eventId||event.type!==e.type||
    (event.data.object as {id?:string}).id!==e.objectId)
  throw new LiveGateError('DECLINE_SIGNED_REMOTE_MISMATCH');
 const intent=await provider.paymentIntents.retrieve(e.objectId);
 const orderId=Number(intent.metadata.order_id);
 const buyerId=Number(intent.metadata.buyer_id);
 if(!intent.livemode||intent.id!==e.objectId||
    intent.currency!=='mxn'||intent.metadata.tala_mode!=='rc8_live_pickup'||
    !pos.test(intent.metadata.order_id??'')||
    !pos.test(intent.metadata.buyer_id??'')||
    !Number.isSafeInteger(orderId)||!Number.isSafeInteger(buyerId)||
    !Number.isSafeInteger(intent.amount)||intent.amount<100)
  throw new LiveGateError('DECLINE_INTENT_INVALID');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const receipts=await client.query<{type:string;objectId:string;status:string}>(
   'SELECT type,"objectId",status FROM stripe_webhook_events WHERE id=$1 AND "stripeAccountId" IS NULL FOR UPDATE',[eventId]);
  const receipt=receipts.rows[0];
  if(!receipt||receipt.type!==e.type||receipt.objectId!==e.objectId)
   throw new LiveGateError('DECLINE_RECEIPT_CHANGED');
  if(receipt.status==='PROCESSED'){
   await client.query('COMMIT');
   return {received:true,alreadyProcessed:true,charged:false};
  }
  const orders=await client.query<{
   id:number;user_id:number;payment_method:string;payment_provider:string;
   payment_provider_id:string;total:string;payment_status:string;
  }>(
   'SELECT id,user_id,payment_method,payment_provider,payment_provider_id,total::text,payment_status FROM orders WHERE id=$1 FOR UPDATE',
   [orderId]);
  const o=orders.rows[0];
  if(!o||o.user_id!==buyerId||o.payment_method!=='stripe'||
     o.payment_provider!=='stripe'||
     ![intent.id,'pi_reserving_rc8_live'].includes(o.payment_provider_id)||
     cents(o.total)!==intent.amount)
   throw new LiveGateError('DECLINE_ORDER_IDENTITY_INVALID');
  // Even if the Intent now succeeded, the old signed failure is valid and
  // must not undo a paid order. A separate success receipt settles money.
  if(!['pending','paid','partially_refunded','refunded','canceled'].includes(o.payment_status))
   throw new LiveGateError('DECLINE_ORDER_PAYMENT_STATE_INVALID');
  await client.query(
   'UPDATE stripe_webhook_events SET status=$2,"processedAt"=NOW() WHERE id=$1',
   [eventId,'PROCESSED']);
  await client.query('COMMIT');
  return {received:true,alreadyProcessed:false,charged:false};
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{client.release();}
}
