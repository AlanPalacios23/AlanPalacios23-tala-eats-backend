/**
 * Stripe Connect treasury webhook inbox + read-back reconciliation.
 * A DEDICATED endpoint uses the CONNECT webhook signing secret, never the
 * platform's whsec. Production activation is opt-in and OFF by default.
 * This file can ONLY reconcile an already-submitted payout; it cannot create
 * bank payouts, Stripe transfers, or mark a statement as a cash deposit.
 */
import {Router,raw} from 'express';
import type Stripe from 'stripe';
import type {Pool,PoolClient} from 'pg';
import {decideConnectedPayoutEvent,type TreasuryPayoutState} from './treasury-webhook-policy.js';
const types=new Set(['payout.created','payout.updated','payout.paid','payout.failed','payout.canceled']);
const sane=(prefix:string,s:unknown)=>typeof s==='string'&&
 new RegExp('^'+prefix+'[A-Za-z0-9]+$').test(s);
const approvedAccount=(a:unknown)=>sane('acct_',a);
export function ingestTreasurySignedEvent(
 rawBody:Buffer,signature:string,provider:Pick<Stripe,'webhooks'>,secret:string
):{eventId:string;eventType:string;accountId:string;payoutId:string}|null{
 if(!Buffer.isBuffer(rawBody)||rawBody.length<10||rawBody.length>256*1024||
    !signature||signature.length>4096||!secret.startsWith('whsec_'))
  throw Error('CONNECT_WEBHOOK_SIGNATURE_REQUIRED');
 const event=provider.webhooks.constructEvent(rawBody,signature,secret);
 if(!event.livemode||!approvedAccount(event.account)||
    !sane('evt_',event.id))throw Error('CONNECT_WEBHOOK_LIVE_IDENTITY_INVALID');
 if(!types.has(event.type))return null;
 const obj=event.data.object;
 if(obj.object!=='payout'||!sane('po_',obj.id))
  throw Error('CONNECT_WEBHOOK_PAYOUT_IDENTITY_INVALID');
 return {eventId:event.id,eventType:event.type,accountId:event.account!,
  payoutId:obj.id};
}
export async function persistTreasurySignedEvent(
 pool:Pool,data:{eventId:string;eventType:string;accountId:string;payoutId:string}
):Promise<{queued:boolean}>{
 if(!sane('evt_',data.eventId)||!types.has(data.eventType)||
    !approvedAccount(data.accountId)||!sane('po_',data.payoutId))
  throw Error('CONNECT_WEBHOOK_EVENT_NOT_VALIDATED');
 const result=await pool.query<{state:string}>(`
 INSERT INTO tala_live_treasury_events(event_id,connected_account_id,event_type,stripe_object_id,state)
 VALUES($1,$2,$3,$4,'received')
 ON CONFLICT(event_id) DO UPDATE SET event_id=EXCLUDED.event_id
 WHERE tala_live_treasury_events.connected_account_id=EXCLUDED.connected_account_id
 AND tala_live_treasury_events.event_type=EXCLUDED.event_type
 AND tala_live_treasury_events.stripe_object_id=EXCLUDED.stripe_object_id
 RETURNING state
 `,[data.eventId,data.accountId,data.eventType,data.payoutId]);
 if(result.rows.length!==1)throw Error('CONNECT_WEBHOOK_EVENT_CONFLICT');
 return {queued:result.rows[0]!.state!=='processed'};
}
type EventRow={event_id:string;event_type:string;connected_account_id:string;
 stripe_object_id:string;state:string};
type WithdrawalRow={id:string;payee_kind:'restaurant'|'driver';payee_id:number;
 connected_account_id:string;bank_destination_id:string;amount_minor:string;
 state:TreasuryPayoutState;stripe_payout_id:string|null};
export async function reconcileOneTreasuryEvent(
 pool:Pool,provider:Pick<Stripe,'payouts'>,eventId:string
):Promise<'processed'|'review_required'>{
 if(!sane('evt_',eventId))throw Error('BAD_TREASURY_EVENT_ID');
 const client=await pool.connect();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  const r=await client.query<EventRow>(
   'SELECT event_id,event_type,connected_account_id,stripe_object_id,state FROM tala_live_treasury_events WHERE event_id=$1 FOR UPDATE',[eventId]);
  const e=r.rows[0];
  if(!e)throw Error('TREASURY_RECEIPT_NOT_FOUND');
  if(e.state==='processed'){await client.query('COMMIT');begun=false;return 'processed';}
  if(e.state==='review_required'){await client.query('COMMIT');begun=false;return 'review_required';}
  if(!types.has(e.event_type)||!approvedAccount(e.connected_account_id)||
     !sane('po_',e.stripe_object_id))throw Error('TREASURY_RECEIPT_INVALID');
  const payout=await provider.payouts.retrieve(e.stripe_object_id,
   {},{stripeAccount:e.connected_account_id});
  if(payout.id!==e.stripe_object_id||!payout.livemode||
     payout.automatic!==false||payout.currency!=='mxn'||
     !payout.metadata?.tala_treasury_withdrawal)
    throw Error('TREASURY_FOREIGN_PAYOUT_HOLD');
  const withdrawalId=payout.metadata.tala_treasury_withdrawal;
  if(!/^[1-9][0-9]{0,15}$/.test(withdrawalId))
   throw Error('TREASURY_WITHDRAWAL_METADATA_INVALID');
  const rows=await client.query<WithdrawalRow>(
   'SELECT id::text,payee_kind,payee_id,connected_account_id,bank_destination_id,amount_minor::text,state,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1 FOR UPDATE',
   [withdrawalId]);
  const w=rows.rows[0];
  if(!w)throw Error('TREASURY_UNKNOWN_BANK_PAYOUT_HOLD');
  const decision=decideConnectedPayoutEvent({
   eventId:e.event_id,eventType:e.event_type,
   livemode:payout.livemode,accountId:e.connected_account_id,
   payoutId:payout.id,amountMinor:payout.amount,currency:payout.currency,
   providerDestination:typeof payout.destination==='string'?payout.destination:'',
   metadata:{withdrawalId, payeeKind:payout.metadata?.tala_payee_kind??'',
    payeeId:payout.metadata?.tala_payee_id??''},
   remoteStatus:payout.status
  },{
   id:w.id,state:w.state,payeeKind:w.payee_kind,payeeId:w.payee_id,
   accountId:w.connected_account_id,bankDestination:w.bank_destination_id,
   amountMinor:Number(w.amount_minor),payoutId:w.stripe_payout_id
  });
  const updated=await client.query(
   'UPDATE tala_live_treasury_withdrawals SET state=$2,stripe_payout_id=$3,updated_at=NOW() WHERE id=$1',
   [w.id,decision.target,payout.id]);
  if(updated.rowCount!==1)throw Error('TREASURY_WITHDRAWAL_CAS_FAILED');
  // Ledger is INSERT-ONLY: one successful payout posting per withdrawal.
  // Failed/canceled requests have no bank-payout-paid receipt.
  if(decision.ledgerEffect==='bank_payout_paid'){
   const l=await client.query(
    "INSERT INTO tala_live_treasury_ledger(withdrawal_id,event_id,kind,amount_minor,currency) VALUES($1,$2,'bank_payout_paid',$3,'mxn') ON CONFLICT(withdrawal_id,kind) DO NOTHING",
    [w.id,e.event_id,w.amount_minor]);
   if(l.rowCount!==1)throw Error('TREASURY_DUPLICATE_LEDGER_CONFLICT');
  }
  const receipt=await client.query(
   'UPDATE tala_live_treasury_events SET state=$2,reconciled_at=NOW() WHERE event_id=$1 AND state=$3',
   [eventId,decision.requiresManualReview?'review_required':'processed','received']);
  if(receipt.rowCount!==1)throw Error('TREASURY_RECEIPT_CAS_FAILED');
  await client.query('COMMIT');begun=false;
  return decision.requiresManualReview?'review_required':'processed';
 }catch(e){if(begun)await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
}
export async function drainTreasuryConnectEvents(pool:Pool,provider:Pick<Stripe,'payouts'>,
 max=10):Promise<{checked:number;processed:number;held:number}>{
 if(!Number.isSafeInteger(max)||max<1||max>25)throw Error('TREASURY_BATCH_INVALID');
 const rows=await pool.query<{event_id:string}>(
  "SELECT event_id FROM tala_live_treasury_events WHERE state='received' ORDER BY received_at,event_id LIMIT $1",
  [max]);
 let processed=0,held=0;
 for(const e of rows.rows){
  try{
   const status=await reconcileOneTreasuryEvent(pool,provider,e.event_id);
   if(status==='processed')processed++;else held++;
  }catch{held++;}
 }
 return {checked:rows.rows.length,processed,held};
}
export function buildTreasuryConnectWebhookRouter(provider:Pick<Stripe,'webhooks'>,
 pool:Pool,secret:string){
 const router=Router();
 router.post('/stripe-connect',raw({type:'application/json',limit:'256kb'}),
  async(req,res)=>{
   res.setHeader('Cache-Control','no-store');
   const signature=req.get('stripe-signature')??'';
   try{
    const data=ingestTreasurySignedEvent(req.body,signature,provider,secret);
    if(!data){res.status(200).json({received:true,queued:false});return;}
    const persisted=await persistTreasurySignedEvent(pool,data);
    res.status(200).json({received:true,queued:persisted.queued});
   }catch(err){
    if(err instanceof Error&&
       (err.name==='StripeSignatureVerificationError'||
        /CONNECT_WEBHOOK_(SIGNATURE|LIVE_IDENTITY|PAYOUT_IDENTITY|EVENT_NOT_VALIDATED)/.test(err.message))){
     res.status(400).json({error:'CONNECT_WEBHOOK_VERIFICATION_FAILED'});return;
    }
    // Never acknowledge a non-durable or inconsistent payout receipt.
    res.status(503).json({error:'CONNECT_WEBHOOK_DURABLE_HOLD'});
   }
 });
 return router;
}
