/**
 * RC9 Treasury: non-spending recovery of an ambiguous Connect payout.
 * Stripe may have accepted payouts.create() before the response was lost.
 * NEVER resubmit. Locate by durable withdrawal metadata, verify identities,
 * then attach its payout ID. A terminal status still needs a signed webhook
 * and durable ledger posting before the UI may call it "paid".
 *
 * Worker opt-in remains OFF until a separately audited treasury release.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
type ReadOnlyPayouts=Pick<Stripe,'payouts'>;
type PendingRow={id:string;state:string;payee_kind:'restaurant'|'driver';
 payee_id:number;connected_account_id:string;bank_destination_id:string;
 amount_minor:string;stripe_payout_id:string|null};
export type PayoutRecovery='unknown'|'submitted'|'terminal_event_pending'|'already_resolved';
const idValid=(v:string)=>/^[1-9][0-9]{0,15}$/.test(v);
export async function recoverUnknownTreasuryPayout(
 pool:Pool,provider:ReadOnlyPayouts,withdrawalId:string
):Promise<PayoutRecovery>{
 if(!idValid(withdrawalId))throw Error('TREASURY_WITHDRAWAL_ID_INVALID');
 const found=await pool.query<PendingRow>(
  'SELECT id::text,state,payee_kind,payee_id,connected_account_id,bank_destination_id,amount_minor::text,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1',
  [withdrawalId]);
 const row=found.rows[0];
 if(!row)throw Error('TREASURY_WITHDRAWAL_NOT_FOUND');
 if(row.state!=='unknown'||row.stripe_payout_id!==null)return 'already_resolved';
 if(!/^acct_[A-Za-z0-9]+$/.test(row.connected_account_id)||
    !/^ba_[A-Za-z0-9]+$/.test(row.bank_destination_id)||
    !/^\d{1,15}$/.test(row.amount_minor)||
    !Number.isSafeInteger(row.payee_id)||row.payee_id<1||
    !['restaurant','driver'].includes(row.payee_kind))
  throw Error('TREASURY_UNKNOWN_IDENTITY_HOLD');
 const amount=Number(row.amount_minor);
 if(!Number.isSafeInteger(amount)||amount<100)
  throw Error('TREASURY_UNKNOWN_AMOUNT_INVALID');
 let cursor:string|undefined;
 let completed=false;
 let match:Stripe.Payout|null=null;
 const expectedLive=process.env.NODE_ENV==='production';
 for(let page=0;page<10;page++){
  // Read-only Stripe list: never issue a new payout to resolve a timeout.
  const list=await provider.payouts.list(
   {limit:100,...(cursor?{starting_after:cursor}:{})},
   {stripeAccount:row.connected_account_id});
  if(!Array.isArray(list.data)||list.data.length>100)
   throw Error('TREASURY_STRIPE_PAYOUT_PAGE_INVALID');
  for(const payout of list.data){
   if(payout.metadata?.tala_treasury_withdrawal!==withdrawalId)continue;
   if(match)throw Error('TREASURY_MULTIPLE_PAYOUTS_SAME_WITHDRAWAL_HOLD');
   if(!/^po_[A-Za-z0-9]+$/.test(payout.id)||
      payout.livemode!==expectedLive||payout.automatic!==false||
      payout.currency!=='mxn'||payout.amount!==amount||
      payout.destination!==row.bank_destination_id||
      payout.metadata?.tala_payee_kind!==row.payee_kind||
      payout.metadata?.tala_payee_id!==String(row.payee_id))
    throw Error('TREASURY_FOREIGN_OR_ALTERED_PAYOUT_HOLD');
   match=payout;
  }
  if(!list.has_more){completed=true;break;}
  const last=list.data.at(-1)?.id;
  if(!last||last===cursor)throw Error('TREASURY_PAYOUT_PAGINATION_STALLED');
  cursor=last;
 }
 // Fail closed if we have not examined the complete payout history.
 if(!completed)throw Error('TREASURY_PAYOUT_HISTORY_INCOMPLETE');
 if(!match)return 'unknown';
 // Never upgrade to 'paid' on polling alone; only signed Connect events
 // may post the immutable bank-payout-paid ledger entry.
 const terminal=['paid','failed','canceled'].includes(match.status);
 if(!terminal&&!['pending','in_transit'].includes(match.status))
  throw Error('TREASURY_PAYOUT_STATUS_UNRECOGNIZED');
 const target=terminal?'unknown':'submitted';
 const updated=await pool.query(
  'UPDATE tala_live_treasury_withdrawals SET stripe_payout_id=$2,state=$3,updated_at=NOW() WHERE id=$1 AND state=$4 AND stripe_payout_id IS NULL AND connected_account_id=$5 AND bank_destination_id=$6 AND amount_minor=$7',
  [withdrawalId,match.id,target,'unknown',row.connected_account_id,
   row.bank_destination_id,row.amount_minor]);
 if(updated.rowCount!==1)throw Error('TREASURY_PAYOUT_RECOVERY_RACE_HOLD');
 return terminal?'terminal_event_pending':'submitted';
}
export async function scanUnknownTreasuryPayouts(
 pool:Pool,provider:ReadOnlyPayouts,limit=2
):Promise<{checked:number;found:number;held:number}>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>5)
  throw Error('TREASURY_RECOVERY_BATCH_INVALID');
 const found=await pool.query<{id:string}>(
  "SELECT id::text FROM tala_live_treasury_withdrawals WHERE state='unknown' AND stripe_payout_id IS NULL ORDER BY created_at,id LIMIT $1",
  [limit]);
 let resolved=0,held=0;
 for(const row of found.rows){
  try{
   const status=await recoverUnknownTreasuryPayout(pool,provider,row.id);
   if(status==='submitted'||status==='terminal_event_pending')resolved++;
   else held++;
  }catch{held++;}
 }
 return {checked:found.rows.length,found:resolved,held};
}
