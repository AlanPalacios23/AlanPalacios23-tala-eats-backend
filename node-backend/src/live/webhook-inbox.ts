/**
 * RC8 LIVE durable webhook inbox. Acknowledge only after the signed event
 * identity is durably saved in independent PRODUCTION PostgreSQL.
 * Never accepts TEST, Connect, or a webhook without a Stripe-Signature.
 *
 * This library has NO registered HTTP route or running job loop; the future
 * isolated production runtime must call ingest on HTTP and drain on worker.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError,type ValidatedLiveSettings} from './guard.js';
import {verifyLiveStripeEvent,type LiveStripeApi} from './stripe-payments.js';
import {reconcileRecordedLiveStripeEvent} from './reconcile.js';
import {reconcileRecordedLiveRefund} from './refund-reconciliation.js';
import {reconcileRecordedLiveCanceledIntent} from './cancel-reconciliation.js';
import {reconcileRecordedLiveRefundFailure} from './refund-failure-reconciliation.js';
import {holdRecordedLiveDispute} from './dispute-reconciliation.js';
import {reconcileRecordedLivePaymentFailure} from './payment-failure-reconciliation.js';

const paymentTypes=new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
]);
// Refund/dispute events can come from Stripe itself or a bank. Never lose
// them: persist as actionable holds until reversal logic is implemented.
const reversalTypes=new Set([
  'charge.refunded','charge.dispute.created','charge.dispute.closed',
  'refund.created','refund.updated','refund.failed','charge.refund.updated',
]);

export async function ingestSignedLiveStripeWebhook(
  rawBody:Buffer,signature:string,provider:Pick<Stripe,'webhooks'>,
  pool:Pool,settings:ValidatedLiveSettings):
  Promise<{received:true;queued:boolean}>{
  const event=verifyLiveStripeEvent(provider,settings,rawBody,signature);
  if(!/^evt_[A-Za-z0-9]+$/.test(event.id))
    throw new LiveGateError('BAD_LIVE_EVENT_ID');
  if(!paymentTypes.has(event.type)&&!reversalTypes.has(event.type))
    return {received:true,queued:false};
  const object=event.data.object as {object?:string;id?:string};
  const type=paymentTypes.has(event.type)?'payment_intent':
    event.type==='charge.refunded'?'charge':
    event.type.startsWith('charge.dispute.')?'dispute':'refund';
  const prefix=type==='payment_intent'?'pi_':
    type==='charge'?'ch_':type==='dispute'?'dp_':'re_';
  if(object.object!==type||!object.id||
     !new RegExp('^'+prefix+'[A-Za-z0-9]+$').test(object.id))
    throw new LiveGateError('BAD_LIVE_EVENT_OBJECT');
  // Conditional ON CONFLICT protects immutable Stripe event identity.
  // Do not overwrite type or "objectId" when the same evt ID arrives again.
  const r=await pool.query<{status:string}>(`
    INSERT INTO stripe_webhook_events
      (id,type,"stripeAccountId","objectId",status,"deliveryCount","receivedAt")
    VALUES($1,$2,NULL,$3,'RECEIVED',1,NOW())
    ON CONFLICT (id) DO UPDATE
      SET "deliveryCount"=stripe_webhook_events."deliveryCount"+1
      WHERE stripe_webhook_events.type=EXCLUDED.type
        AND stripe_webhook_events."objectId"=EXCLUDED."objectId"
        AND stripe_webhook_events."stripeAccountId" IS NULL
    RETURNING status
  `,[event.id,event.type,object.id]);
  if(r.rowCount!==1)throw new LiveGateError('DURABLE_EVENT_IDENTITY_CONFLICT');
  return {received:true,queued:r.rows[0]?.status!=='PROCESSED'};
}

/**
 * Bounded, re-entrant worker sweep. Signed HTTP ingest happened previously;
 * the worker re-fetches the durable event and PaymentIntent from Stripe and
 * relies on PostgreSQL row locks to serialize duplicate payment callbacks.
 * Failed/canceled and refund/dispute receipts remain in HOLD outside
 * this payment-success-only sweep;
 * their handler must reconcile reversals separately. This prevents a dispute
 * from starving all ordinary payment receipts in a bounded retry batch.
 * Errors preserve RECEIVED receipts for reconciliation; never lose a charge.
 */
export async function drainLiveSignedReceipts(
  provider:LiveStripeApi,pool:Pool,settings:ValidatedLiveSettings,
  maximum=20):Promise<{checked:number;reconciled:number;held:number}>{
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>50)
    throw new LiveGateError('LIVE_DRAIN_BATCH_INVALID');
  const rows=await pool.query<{id:string}>(`
    SELECT id FROM stripe_webhook_events
    WHERE status IN ('RECEIVED','FAILED')
      AND "stripeAccountId" IS NULL
      AND type IN ('payment_intent.succeeded')
    ORDER BY "receivedAt",id
    LIMIT $1
  `,[maximum]);
  let reconciled=0,held=0;
  for(const row of rows.rows){
    try{
      await reconcileRecordedLiveStripeEvent(row.id,provider,pool,settings);
      reconciled++;
    }catch{
      // No PII/provider response leaked to worker logs; PG receipt remains
      // RECEIVED/FAILED and manual monitoring must alert on stale records.
      held++;
    }
  }
  return {checked:rows.rows.length,reconciled,held};
}


/** Worker-side Stripe LIVE refund reconciliation.
 * Each succeeded refund debits collected funds once, then keeps merchant
 * payout and inventory on HOLD for an explicit operations review.
 */
export async function drainLiveRefundReceipts(
 provider:LiveStripeApi,pool:Pool,maximum=10
):Promise<{checked:number;reconciled:number;held:number}>{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>50)
   throw new LiveGateError('LIVE_REFUND_DRAIN_BATCH_INVALID');
 const sql="SELECT id FROM stripe_webhook_events WHERE status IN ('RECEIVED','FAILED') "+
   "AND \"stripeAccountId\" IS NULL AND type IN ('refund.created','refund.updated') "+
   "ORDER BY \"receivedAt\",id LIMIT $1";
 const rows=await pool.query<{id:string}>(sql,[maximum]);
 let reconciled=0,held=0;
 for(const row of rows.rows){
   try{
     await reconcileRecordedLiveRefund(row.id,provider,pool);
     reconciled++;
   }catch{
     // Retry later: never drop a signed refund event or expose payment data.
     held++;
   }
 }
 return {checked:rows.rows.length,reconciled,held};
}


/** Reconcile durable LIVE cancellation events, never payment_failed:
 * payment_failed is not terminal and may still be retried by the customer.
 * Inventory is returned only when remote Stripe proves zero capture.
 */
export async function drainLiveCanceledReceipts(
 provider:LiveStripeApi,pool:Pool,maximum=10
):Promise<{checked:number;reconciled:number;held:number}>{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>50)
   throw new LiveGateError('LIVE_CANCEL_DRAIN_BATCH_INVALID');
 const sql="SELECT id FROM stripe_webhook_events WHERE status IN ('RECEIVED','FAILED') "+
   "AND \"stripeAccountId\" IS NULL AND type='payment_intent.canceled' "+
   "ORDER BY \"receivedAt\",id LIMIT $1";
 const rows=await pool.query<{id:string}>(sql,[maximum]);
 let reconciled=0,held=0;
 for(const row of rows.rows){
   try{
     await reconcileRecordedLiveCanceledIntent(row.id,provider,pool);
     reconciled++;
   }catch{
     // Signed receipt remains on HOLD, no lost inventory/financial writes.
     held++;
   }
 }
 return {checked:rows.rows.length,reconciled,held};
}


/** Preserve failed refund evidence while posting a compensating collected-
 * money credit once. No provider mutations or merchant payout release.
 */
export async function drainLiveRefundFailures(
 provider:LiveStripeApi,pool:Pool,maximum=10
):Promise<{checked:number;reconciled:number;held:number}>{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>50)
   throw new LiveGateError('LIVE_REFUND_FAILURE_BATCH_INVALID');
 const sql="SELECT id FROM stripe_webhook_events WHERE status IN ('RECEIVED','FAILED') "+
  "AND \"stripeAccountId\" IS NULL AND type='refund.failed' "+
  "ORDER BY \"receivedAt\",id LIMIT $1";
 const rows=await pool.query<{id:string}>(sql,[maximum]);
 let reconciled=0,held=0;
 for(const row of rows.rows){
  try{
   await reconcileRecordedLiveRefundFailure(row.id,provider,pool);
   reconciled++;
  }catch{held++;}
 }
 return {checked:rows.rows.length,reconciled,held};
}


/** Disputes are never silently auto-refunded or auto-transferred.
 * Record Stripe-verified manual settlement holds against the matched order.
 */
export async function drainLiveDisputeReceipts(
 provider:LiveStripeApi,pool:Pool,maximum=10
):Promise<{checked:number;reconciled:number;held:number}>{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>50)
   throw new LiveGateError('LIVE_DISPUTE_DRAIN_BATCH_INVALID');
 const sql="SELECT id FROM stripe_webhook_events WHERE status IN ('RECEIVED','FAILED') "+
   "AND \"stripeAccountId\" IS NULL AND type IN ('charge.dispute.created','charge.dispute.closed') "+
   "ORDER BY \"receivedAt\",id LIMIT $1";
 const records=await pool.query<{id:string}>(sql,[maximum]);
 let reconciled=0,held=0;
 for(const row of records.rows){
   try{
     await holdRecordedLiveDispute(row.id,provider,pool);
     reconciled++;
   }catch{held++;}
 }
 return {checked:records.rows.length,reconciled,held};
}


/** Consume a signed declined-card receipt without interpreting it as final
 * cancellation. A subsequent successful payment is independently settled.
 */
export async function drainLivePaymentFailures(
 provider:LiveStripeApi,pool:Pool,maximum=20
):Promise<{checked:number;reconciled:number;held:number}>{
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>50)
  throw new LiveGateError('LIVE_PAYMENT_FAILURE_BATCH_INVALID');
 const sql="SELECT id FROM stripe_webhook_events WHERE status IN ('RECEIVED','FAILED') "+
  "AND \"stripeAccountId\" IS NULL AND type='payment_intent.payment_failed' "+
  "ORDER BY \"receivedAt\",id LIMIT $1";
 const rows=await pool.query<{id:string}>(sql,[maximum]);
 let reconciled=0,held=0;
 for(const row of rows.rows){
  try{
   await reconcileRecordedLivePaymentFailure(row.id,provider,pool);
   reconciled++;
  }catch{held++;}
 }
 return {checked:rows.rows.length,reconciled,held};
}
