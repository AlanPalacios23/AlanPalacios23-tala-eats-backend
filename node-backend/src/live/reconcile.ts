/**
 * Authenticated LIVE signed-webhook reconciliation against a separate
 * production PostgreSQL database. Payment capture and order release occur in
 * one ACID commit. No transfers, automatic payouts or refunds are enabled.
 * IMPORTANT: requires a separately secured HTTP ingress, worker and
 * full refund/dispute handler before the LIVE rollout can be approved.
 */
import type Stripe from 'stripe';
import type { Pool,PoolClient } from 'pg';
import {liveReceiptIdentity,LiveGateError,
  type ValidatedLiveSettings} from './guard.js';
import {verifyLiveStripeEvent} from './stripe-payments.js';
import type {LiveStripeApi} from './stripe-payments.js';

const allowed=new Set(['payment_intent.succeeded',
  'payment_intent.payment_failed','payment_intent.canceled']);
type OrderRow={
  id:number;user_id:number;restaurant_id:number;total:string;
  status:string;payment_status:string;payment_method:string;
  payment_provider:string;payment_provider_id:string;order_type:string;
  refunded_amount:string;restaurant_payout:string;
  platform_revenue:string;payment_processing_fee:string;
  contribution_margin:string;
};
const decimal=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
function minor(s:string):number{
  if(!decimal.test(s))throw new LiveGateError('LIVE_DECIMAL_INVALID');
  const [a,b]=s.split('.');
  return Number(a)*100+Number(b);
}
function accountEntry(
 client:PoolClient,order:OrderRow,account:string,raw:string,
 direction:'credit'|'debit'='credit') {
  return client.query(`
    INSERT INTO financial_ledger_entries
      (order_id,user_id,restaurant_id,account,direction,amount,
       currency,kind,description,idempotency_key,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,'MXN','order_settlement',
      'RC8 LIVE cobro confirmado, transferencia pendiente',$7,NOW())
  `,[order.id,order.user_id,order.restaurant_id,
     account,direction,raw,'order:'+order.id+':live:ledger:'+account]);
}
async function verifiedReceipt(client:PoolClient,order:OrderRow){
  const r=await client.query<{id:number;amount:string}>(`
    SELECT id,amount::text AS amount FROM financial_ledger_entries
    WHERE order_id=$1 AND account='stripe_live_collected'
      AND kind='stripe_live_payment' AND direction='credit'
      AND idempotency_key=$2 FOR UPDATE
  `,[order.id,'order:'+order.id+':stripe-live:collected']);
  if(r.rows.length!==1||minor(r.rows[0]!.amount)!==minor(order.total))
    throw new LiveGateError('PAID_ORDER_MISSING_IMMUTABLE_LIVE_RECEIPT');
}
export async function reconcileSignedLiveStripeWebhook(
 rawBody:Buffer,signature:string,provider:LiveStripeApi,
 pool:Pool,settings:ValidatedLiveSettings):
 Promise<{received:true;alreadyProcessed:boolean}>{
  const signed=verifyLiveStripeEvent(provider,settings,rawBody,signature);
  return reconcileLiveVerifiedEvent(signed,provider,pool,settings);
}

/**
 * Worker-side reconciliation of a previously verified and durable webhook.
 * NEVER process arbitrary Stripe event IDs that are absent from our inbox.
 */
export async function reconcileRecordedLiveStripeEvent(
 eventId:string,provider:LiveStripeApi,pool:Pool,settings:ValidatedLiveSettings):
 Promise<{received:true;alreadyProcessed:boolean}>{
  if(!/^evt_[A-Za-z0-9]+$/.test(eventId))
    throw new LiveGateError('INVALID_RECORDED_EVENT_ID');
  const recorded=await pool.query<{
    type:string;object_id:string;stripe_account_id:string|null;
  }>(`SELECT type,object_id,stripe_account_id
      FROM stripe_webhook_events WHERE id=$1`,[eventId]);
  const existing=recorded.rows[0];
  if(!existing||existing.stripe_account_id!==null||
     !allowed.has(existing.type)||!/^pi_[A-Za-z0-9]+$/.test(existing.object_id))
    throw new LiveGateError('SIGNED_RECEIPT_NOT_RECORDED');
  // Stripe's authenticated API is the second trust boundary.
  const signed=await provider.events.retrieve(eventId);
  const object=signed.data.object as {id?:string};
  if(!signed.livemode||signed.account||signed.id!==eventId||
     signed.type!==existing.type||object.id!==existing.object_id)
    throw new LiveGateError('DURABLE_AND_STRIPE_EVENT_MISMATCH');
  return reconcileLiveVerifiedEvent(signed,provider,pool,settings);
}

async function reconcileLiveVerifiedEvent(
 signed:Stripe.Event,provider:LiveStripeApi,
 pool:Pool,_settings:ValidatedLiveSettings):
 Promise<{received:true;alreadyProcessed:boolean}>{
  if(!/^evt_[A-Za-z0-9]+$/.test(signed.id))
    throw new LiveGateError('INVALID_SIGNED_EVENT_ID');
  if(!allowed.has(signed.type))return {received:true,alreadyProcessed:false};
  const object=signed.data.object as Stripe.PaymentIntent;
  if(object.object!=='payment_intent'||!/^pi_[A-Za-z0-9]+$/.test(object.id))
    throw new LiveGateError('INVALID_PAYMENT_INTENT_OBJECT');
  // Re-read provider state: signed events may be delayed/out of order.
  const [stripeEvent,intent]=await Promise.all([
    provider.events.retrieve(signed.id),
    provider.paymentIntents.retrieve(object.id),
  ]);
  if(!stripeEvent.livemode||stripeEvent.type!==signed.type||
     (stripeEvent.data.object as {id?:string}).id!==object.id||
     !intent.livemode||intent.id!==object.id||intent.currency!=='mxn')
    throw new LiveGateError('STRIPE_REMOTE_PROOF_MISMATCH');
  const orderId=Number(intent.metadata.order_id);
  const buyerId=Number(intent.metadata.buyer_id);
  if(!Number.isSafeInteger(orderId)||orderId<=0||
     !Number.isSafeInteger(buyerId)||buyerId<=0||
     intent.metadata.tala_mode!=='rc8_live_pickup')
    throw new LiveGateError('UNKNOWN_LIVE_PAYMENT_IDENTITY');

  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Durable receipt locked before money/account mutations. Any exception
    // rolls back both the receipt and the order/ledger changes; Stripe retries.
    await client.query(`
      INSERT INTO stripe_webhook_events
        (id,type,stripe_account_id,object_id,status,delivery_count,received_at)
      VALUES ($1,$2,NULL,$3,'RECEIVED',1,NOW())
      ON CONFLICT(id) DO UPDATE SET delivery_count=
        stripe_webhook_events.delivery_count+1
    `,[signed.id,signed.type,object.id]);
    const receipt=await client.query<{
      type:string;object_id:string;status:string;
    }>(`SELECT type,object_id,status FROM stripe_webhook_events
       WHERE id=$1 FOR UPDATE`,[signed.id]);
    const stored=receipt.rows[0];
    if(!stored||stored.type!==signed.type||stored.object_id!==object.id)
      throw new LiveGateError('WEBHOOK_EVENT_IDENTITY_CONFLICT');
    if(stored.status==='PROCESSED'){
      await client.query('COMMIT');
      return {received:true,alreadyProcessed:true};
    }
    const found=await client.query<OrderRow>(`
      SELECT id,user_id,restaurant_id,total::text,status,payment_status,
        payment_method,payment_provider,payment_provider_id,order_type,
        refunded_amount::text,restaurant_payout::text,
        platform_revenue::text,payment_processing_fee::text,
        contribution_margin::text
      FROM orders WHERE id=$1 FOR UPDATE
    `,[orderId]);
    const order=found.rows[0];
    if(!order||order.user_id!==buyerId||
       order.order_type!=='pickup'||order.payment_method!=='stripe'||
       order.payment_provider!=='stripe'||
       order.payment_provider_id!==intent.id||
       minor(order.total)!==intent.amount||Number(order.refunded_amount)!==0)
      throw new LiveGateError('ORDER_PROVIDER_BINDING_INVALID');
    if(signed.type==='payment_intent.succeeded'){
      liveReceiptIdentity(intent,{id:orderId,buyerId,amountMinor:minor(order.total)});
      if(order.payment_status==='paid'){
        await verifiedReceipt(client,order);
      }else{
        if(order.status!=='awaiting_payment'||order.payment_status!=='pending')
          throw new LiveGateError('LIVE_ORDER_STATE_REQUIRES_REVIEW');
        const pre=await client.query(`
          SELECT id FROM financial_ledger_entries
          WHERE order_id=$1 AND
            (kind='order_settlement' OR kind='stripe_live_payment')
        `,[orderId]);
        if(pre.rowCount!==0)throw new LiveGateError('PREEXISTING_LEDGER_UNRECONCILED');
        const changed=await client.query(`
          UPDATE orders SET payment_status='paid',status='received'
          WHERE id=$1 AND status='awaiting_payment' AND payment_status='pending'
          RETURNING id
        `,[orderId]);
        if(changed.rowCount!==1)throw new LiveGateError('PAYMENT_STATE_CAS_CONFLICT');
        for(const [account,value,direction] of [
          ['gmv',order.total,'credit'],
          ['restaurant_payable',order.restaurant_payout,'credit'],
          ['platform_revenue',order.platform_revenue,'credit'],
          ['payment_processing',order.payment_processing_fee,'debit'],
          ['contribution_margin',order.contribution_margin,'credit'],
        ] as const){
          if(minor(value)>0)await accountEntry(client,order,account,value,direction);
        }
        await client.query(`
          INSERT INTO financial_ledger_entries
          (order_id,user_id,restaurant_id,account,direction,amount,
           currency,kind,description,idempotency_key,created_at)
          VALUES($1,$2,$3,'stripe_live_collected','credit',$4,'MXN',
                 'stripe_live_payment','RC8 LIVE captura verificada, no retirable',
                 $5,NOW())
        `,[orderId,buyerId,order.restaurant_id,order.total,
           'order:'+orderId+':stripe-live:collected']);
        for(const [eventKey,eventType] of [
          ['order:'+orderId+':created','order.created'],
          ['order:'+orderId+':stripe-live-paid','order.paid'],
        ] as const){
          await client.query(`
            INSERT INTO event_outbox
            (event_key,aggregate_type,aggregate_id,event_type,payload_json,
             status,attempts,last_error,created_at)
            VALUES($1,'order',$2,$3,$4,'pending',0,'',NOW())
          `,[eventKey,String(orderId),eventType,JSON.stringify({
            order_id:orderId,user_id:buyerId,restaurant_id:order.restaurant_id,
            status:'received',payment_status:'paid',provider:'stripe_live',
          })]);
        }
        await client.query(`
          INSERT INTO order_events
          (order_id,status,actor_user_id,metadata_json,created_at)
          VALUES($1,'received',$2,$3,NOW())
        `,[orderId,buyerId,JSON.stringify({
          source:'stripe_live_webhook',stripe_event_id:signed.id,
        })]);
      }
    }
    // Failed/canceled events are retained; this routine NEVER frees stock
    // without a separate provider-confirmed cancel/compensation transaction.
    await client.query(`
      UPDATE stripe_webhook_events
      SET status='PROCESSED',processed_at=NOW() WHERE id=$1
    `,[signed.id]);
    await client.query('COMMIT');
    return {received:true,alreadyProcessed:false};
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}
