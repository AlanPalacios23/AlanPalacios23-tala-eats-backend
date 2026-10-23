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

const paymentTypes=new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
]);

export async function ingestSignedLiveStripeWebhook(
  rawBody:Buffer,signature:string,provider:Pick<Stripe,'webhooks'>,
  pool:Pool,settings:ValidatedLiveSettings):
  Promise<{received:true;queued:boolean}>{
  const event=verifyLiveStripeEvent(provider,settings,rawBody,signature);
  if(!/^evt_[A-Za-z0-9]+$/.test(event.id))
    throw new LiveGateError('BAD_LIVE_EVENT_ID');
  if(!paymentTypes.has(event.type))
    return {received:true,queued:false};
  const object=event.data.object as {object?:string;id?:string};
  if(object.object!=='payment_intent' ||
    !object.id||!/^pi_[A-Za-z0-9]+$/.test(object.id))
    throw new LiveGateError('BAD_LIVE_EVENT_OBJECT');
  // Conditional ON CONFLICT protects immutable Stripe event identity.
  // Do not overwrite type or object_id when the same evt ID arrives again.
  const r=await pool.query<{status:string}>(`
    INSERT INTO stripe_webhook_events
      (id,type,stripe_account_id,object_id,status,delivery_count,received_at)
    VALUES($1,$2,NULL,$3,'RECEIVED',1,NOW())
    ON CONFLICT (id) DO UPDATE
      SET delivery_count=stripe_webhook_events.delivery_count+1
      WHERE stripe_webhook_events.type=EXCLUDED.type
        AND stripe_webhook_events.object_id=EXCLUDED.object_id
        AND stripe_webhook_events.stripe_account_id IS NULL
    RETURNING status
  `,[event.id,event.type,object.id]);
  if(r.rowCount!==1)throw new LiveGateError('DURABLE_EVENT_IDENTITY_CONFLICT');
  return {received:true,queued:r.rows[0]?.status!=='PROCESSED'};
}

/**
 * Bounded, re-entrant worker sweep. Signed HTTP ingest happened previously;
 * the worker re-fetches the durable event and PaymentIntent from Stripe and
 * relies on PostgreSQL row locks to serialize duplicate payment callbacks.
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
      AND stripe_account_id IS NULL
      AND type IN ('payment_intent.succeeded',
                   'payment_intent.payment_failed',
                   'payment_intent.canceled')
    ORDER BY received_at,id
    LIMIT $1
  `,[maximum]);
  let reconciled=0,held=0;
  for(const row of rows.rows){
    try{
      await reconcileRecordedLiveStripeEvent(row.id,provider,pool,settings);
      reconciled++;
    }catch{
      // No PII/provider response leaked to worker logs; PG receipt remains
      // RECIEVED/FAILED and manual monitoring must alert on stale records.
      held++;
    }
  }
  return {checked:rows.rows.length,reconciled,held};
}
