/**
 * Durable treasury disbursement coordinator. Not mounted while RC9 kill switch
 * is false. The DB CAS takes place BEFORE Stripe call, and timeout preserves
 * 'unknown' permanently until a verified Connect event/read-back resolves it.
 * Never launch a second payment with a different idempotency key on retry.
 */
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {mockableTransferExecution,mockableBankPayoutExecution,
  type TransferReservation,type PayoutReservation} from './treasury-execution.js';
import {NODE_TREASURY_LIVE_EXECUTION_ENABLED} from './treasury-policy.js';
import type {TransferPrerequisites} from './transfer-planning.js';

const integer=(s:string)=>{const v=Number(s);
 if(!/^\d{1,12}$/.test(s)||!Number.isSafeInteger(v))throw Error('TREASURY_MONEY_INVALID');
 return v;};
const dbId=(v:string)=>/^[1-9][0-9]{0,15}$/.test(v);
const assertLiveGate=()=>{
 if(process.env.NODE_ENV==='production'&&!NODE_TREASURY_LIVE_EXECUTION_ENABLED)
  throw Error('TREASURY_PRODUCTION_DISBURSEMENT_LOCKED');
};
type StoredPayout={
 id:string;payee_kind:'restaurant'|'driver';payee_id:number;
 state:string;connected_account_id:string;bank_destination_id:string;
 amount_minor:string;stripe_payout_id:string|null;requested_by_user_id:number;
 reviewed_by_user_id:number|null;approved_by_user_id:number|null;
};
type StoredTransfer={
 id:string;state:string;order_id:number;payee_kind:'restaurant'|'driver';
 payee_id:number;connected_account_id:string;source_charge_id:string;
 amount_minor:string;idempotency_key:string;reviewed_by_user_id:number|null;
 approved_by_user_id:number|null;stripe_transfer_id:string|null;
};
export async function dispatchTreasuryWithdrawal(
 pool:Pool,provider:Pick<Stripe,'payouts'>,id:string,
 verifiedAvailableMinor:number,releaseApproved:boolean
):Promise<{id:string;state:'submitted'|'unknown';stripePayoutId?:string}>{
 assertLiveGate();
 if(!dbId(id)||!Number.isSafeInteger(verifiedAvailableMinor)||verifiedAvailableMinor<100)
  throw Error('TREASURY_REQUEST_UNVERIFIED');
 if(!releaseApproved)throw Error('TREASURY_PAYOUT_NOT_RELEASED');
 const client=await pool.connect();let begun=false;
 let row:StoredPayout;
 try{
  await client.query('BEGIN');begun=true;
  const result=await client.query<StoredPayout>(
   'SELECT id::text,payee_kind,payee_id,state,connected_account_id,bank_destination_id,amount_minor::text,stripe_payout_id,requested_by_user_id,reviewed_by_user_id,approved_by_user_id FROM tala_live_treasury_withdrawals WHERE id=$1 FOR UPDATE',
   [id]);
  if(result.rows.length!==1||result.rows[0]!.state!=='reserved'||
    result.rows[0]!.stripe_payout_id!==null)
   throw Error('TREASURY_REQUEST_ALREADY_DISPATCHED_OR_UNKNOWN');
  row=result.rows[0]!;
  if(row.reviewed_by_user_id===null||row.approved_by_user_id===null||
     row.reviewed_by_user_id===row.approved_by_user_id||
     row.reviewed_by_user_id===row.requested_by_user_id||
     row.approved_by_user_id===row.requested_by_user_id)
   throw Error('TREASURY_BANK_DUAL_APPROVAL_REQUIRED');
  if(integer(row.amount_minor)>verifiedAvailableMinor)
   throw Error('TREASURY_VERIFIED_AVAILABLE_CHANGED');
  // CAS before ANY provider call; retry sees submitted or unknown and will
  // read Stripe instead of submitting a second payout.
  const updated=await client.query(
   "UPDATE tala_live_treasury_withdrawals SET state='submitted',updated_at=NOW() WHERE id=$1 AND state='reserved' AND stripe_payout_id IS NULL",
   [id]);
  if(updated.rowCount!==1)throw Error('TREASURY_DISPATCH_RACE');
  await client.query('COMMIT');begun=false;
 }catch(e){if(begun)await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
 const reservation:PayoutReservation={
  id,state:'reserved',kind:row!.payee_kind,payeeId:row!.payee_id,
  accountId:row!.connected_account_id,bankId:row!.bank_destination_id,
  amountMinor:integer(row!.amount_minor),
  idempotencyKey:'tala:treasury:payout:v1:'+id,
  verifiedWithdrawableMinor:verifiedAvailableMinor,
  // Recorded reviewer + approver from PostgreSQL; never fabricated.
  approved:{reviewedBy:row!.reviewed_by_user_id!,approvedBy:row!.approved_by_user_id!}
 };
 try{
  const remote=await mockableBankPayoutExecution(provider,reservation,releaseApproved);
  const saved=await pool.query(
   "UPDATE tala_live_treasury_withdrawals SET stripe_payout_id=$2,updated_at=NOW() WHERE id=$1 AND state='submitted' AND stripe_payout_id IS NULL",
   [id,remote.payoutId]);
  if(saved.rowCount!==1)throw Error('TREASURY_REMOTE_PAYOUT_MUST_BE_RECONCILED');
  return {id,state:'submitted',stripePayoutId:remote.payoutId};
 }catch{
  // Never mark a network timeout as FAILED or free funds: Stripe may have
  // already executed the payout. Reconciliation must prove its identity.
  await pool.query(
   "UPDATE tala_live_treasury_withdrawals SET state='unknown',updated_at=NOW() WHERE id=$1 AND state='submitted'",
   [id]).catch(()=>{});
  return {id,state:'unknown'};
 }
}
export async function dispatchTreasuryTransfer(
 pool:Pool,provider:Pick<Stripe,'transfers'|'charges'>,
 id:string,input:TransferPrerequisites,releaseApproved:boolean
):Promise<{id:string;state:'completed'|'unknown';stripeTransferId?:string}>{
 assertLiveGate();
 if(!dbId(id)||!releaseApproved)throw Error('TREASURY_TRANSFER_NOT_RELEASED');
 const client=await pool.connect();let begun=false;let row:StoredTransfer;
 try{
  await client.query('BEGIN');begun=true;
  const r=await client.query<StoredTransfer>(
   'SELECT id::text,state,order_id,payee_kind,payee_id,connected_account_id,source_charge_id,amount_minor::text,idempotency_key,reviewed_by_user_id,approved_by_user_id,stripe_transfer_id FROM tala_live_treasury_transfers WHERE id=$1 FOR UPDATE',
   [id]);
  if(r.rows.length!==1)throw Error('TREASURY_TRANSFER_NOT_FOUND');
  row=r.rows[0]!;
  if(row.state!=='reserved'||row.stripe_transfer_id!==null||
    row.reviewed_by_user_id===null||row.approved_by_user_id===null||
    row.reviewed_by_user_id===row.approved_by_user_id||
    row.order_id!==input.orderId||row.payee_kind!==input.kind||
    row.payee_id!==input.payeeId||row.connected_account_id!==input.stripeAccountId||
    row.source_charge_id!==input.chargeId||
    integer(row.amount_minor)!==input.amountMinor)
   throw Error('TREASURY_TRANSFER_RESERVATION_CHANGED');
  const q=await client.query(
   "UPDATE tala_live_treasury_transfers SET state='submitted',updated_at=NOW() WHERE id=$1 AND state='reserved' AND stripe_transfer_id IS NULL",
   [id]);
  if(q.rowCount!==1)throw Error('TREASURY_TRANSFER_DISPATCH_RACE');
  await client.query('COMMIT');begun=false;
 }catch(e){if(begun)await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
 const reservation:TransferReservation={
  id,state:'reserved',
  approved:{reviewedBy:row!.reviewed_by_user_id!,approvedBy:row!.approved_by_user_id!},
  input,idempotencyKey:row!.idempotency_key
 };
 try{
  const transfer=await mockableTransferExecution(provider,reservation,releaseApproved);
  const saved=await pool.query(
   "UPDATE tala_live_treasury_transfers SET state='completed',stripe_transfer_id=$2,updated_at=NOW() WHERE id=$1 AND state='submitted' AND stripe_transfer_id IS NULL",
   [id,transfer.transferId]);
  if(saved.rowCount!==1)throw Error('TREASURY_TRANSFER_POST_STRIPE_STORAGE_HOLD');
  return {id,state:'completed',stripeTransferId:transfer.transferId};
 }catch{
  await pool.query(
   "UPDATE tala_live_treasury_transfers SET state='unknown',updated_at=NOW() WHERE id=$1 AND state='submitted'",
   [id]).catch(()=>{});
  return {id,state:'unknown'};
 }
}
