/**
 * Treasury RC9 — PostgreSQL reservation (NO Stripe call).
 * This module is not reachable from an HTTP payout route while the release
 * lock is false. Bank destination and provider balance come from SERVER reads,
 * never a client-controlled bank account or amount of 'available earnings'.
 */
import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {verifiedTotpCounter} from '../auth/crypto.js';
import {treasuryCanRequest,treasuryBalance,type TreasuryPayee} from './treasury-policy.js';

type VerifiedSnapshot={
 kind:TreasuryPayee; payeeId:number; ownerId:number; accountId:string;
 bankId:string;transferredMinor:bigint;stripeAvailableMinor:bigint;
 ownerApproved:boolean;connectReady:boolean;bankVerified:boolean;
 scheduleManual:boolean;openCases:number;unrecognizedPayouts:number;
 pendingTransfers:number;
};
export type ReserveWithdrawal={
 snapshot:VerifiedSnapshot; actorUserId:number; totp:string;
 clientKey:string;amountMinor:bigint; nowMs?:number;
};
type LockRow={id:string;amount_minor:string;state:string};
const maximumMinor=50000n,maximumDailyMinor=100000n;
const safeAmount=(x:bigint)=>typeof x==='bigint'&&x>=100n&&x<=maximumMinor;
const validId=(x:number)=>Number.isSafeInteger(x)&&x>0;
function requestValid(v:ReserveWithdrawal){
 if(!validId(v.actorUserId)||!validId(v.snapshot.payeeId)||
    v.actorUserId!==v.snapshot.ownerId||
    !['restaurant','driver'].includes(v.snapshot.kind)||
    !/^acct_[A-Za-z0-9]+$/.test(v.snapshot.accountId)||
    !/^ba_[A-Za-z0-9]+$/.test(v.snapshot.bankId)||
    !/^[a-f0-9-]{36}$/i.test(v.clientKey)||v.clientKey!==v.clientKey.toLowerCase()||
    !/^[0-9]{6}$/.test(v.totp)||!safeAmount(v.amountMinor))
  throw Error('TREASURY_REQUEST_INVALID');
}
function acceptedOtpStep(secret:string,otp:string,nowSeconds:number):bigint{
 const counter=verifiedTotpCounter(secret,otp,nowSeconds);
 if(counter===null)throw Error('TREASURY_TOTP_INVALID');
 return BigInt(counter);
}
export async function reserveTreasuryWithdrawal(pool:Pool,v:ReserveWithdrawal){
 requestValid(v);
 const client=await pool.connect();
 let began=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');began=true;
  // Strictly serializes all requests for a recipient across API/worker instances.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
   [v.snapshot.kind+':'+v.snapshot.payeeId+':treasury']);
  const owner=await client.query<{totp_secret:string;two_factor_enabled:boolean;role:string;is_active:boolean}>(
   'SELECT totp_secret,two_factor_enabled,role,is_active FROM users WHERE id=$1 FOR UPDATE',[v.actorUserId]);
  const me=owner.rows[0];
  if(!me||!me.is_active||!me.two_factor_enabled||me.role!==(v.snapshot.kind==='restaurant'?'restaurant':'driver'))
   throw Error('TREASURY_STRONG_AUTH_REQUIRED');
  const accountSql=v.snapshot.kind==='restaurant'?
   'SELECT m.stripe_account_id AS account_id,m.owner_approved_at IS NOT NULL AS approved FROM tala_live_merchant_accounts m JOIN restaurants r ON r.id=m.restaurant_id WHERE r.id=$1 AND r.owner_id=$2 FOR UPDATE OF m':
   'SELECT d.stripe_account_id AS account_id,d.owner_approved_at IS NOT NULL AS approved FROM tala_live_driver_accounts d JOIN driver_profiles p ON p.user_id=d.user_id WHERE d.user_id=$1 AND d.user_id=$2 AND p.is_verified=true FOR UPDATE OF d';
  const ac=await client.query<{account_id:string;approved:boolean}>(accountSql,
   [v.snapshot.payeeId,v.actorUserId]);
  if(ac.rows.length!==1||ac.rows[0]!.account_id!==v.snapshot.accountId||!ac.rows[0]!.approved)
   throw Error('TREASURY_CONNECT_IDENTITY_CHANGED');
  const nowSec=Math.floor((v.nowMs??Date.now())/1000);
  const otpStep=acceptedOtpStep(me.totp_secret,v.totp,nowSec);
  // A duplicate idempotency key is a status read, never a second transfer.
  const existing=await client.query<LockRow>(
   "SELECT id::text,amount_minor::text,state FROM tala_live_treasury_withdrawals WHERE payee_kind=$1 AND payee_id=$2 AND client_key=$3 FOR UPDATE",
   [v.snapshot.kind,v.snapshot.payeeId,v.clientKey]);
  if(existing.rows.length){
   if(BigInt(existing.rows[0]!.amount_minor)!==v.amountMinor)
    throw Error('TREASURY_IDEMPOTENCY_PAYLOAD_CONFLICT');
   await client.query('COMMIT');began=false;
   return {id:existing.rows[0]!.id,status:existing.rows[0]!.state,created:false};
  }
  // Prevent exceeding provider-verified funds even when multiple API workers
  // race, and fail closed on any unknown transfer or withdrawal.
  const [transfers,withdrawals,daily,holds]=await Promise.all([
   client.query<{amount_minor:string}>(
    "SELECT COALESCE(SUM(amount_minor),0)::text AS amount_minor FROM tala_live_treasury_transfers WHERE payee_kind=$1 AND payee_id=$2 AND state='completed'",
    [v.snapshot.kind,v.snapshot.payeeId]),
   client.query<{amount_minor:string;unknown:string}>(
    "SELECT COALESCE(SUM(amount_minor),0)::text AS amount_minor,COUNT(*) FILTER (WHERE state IN ('reserved','submitted','unknown','review_required'))::text AS unknown FROM tala_live_treasury_withdrawals WHERE payee_kind=$1 AND payee_id=$2 AND state IN ('reserved','submitted','unknown','review_required','paid')",
    [v.snapshot.kind,v.snapshot.payeeId]),
   client.query<{amount_minor:string}>(
    "SELECT COALESCE(SUM(amount_minor),0)::text AS amount_minor FROM tala_live_treasury_withdrawals WHERE payee_kind=$1 AND payee_id=$2 AND created_at >= DATE_TRUNC('day',now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City' AND state <> 'canceled'",
    [v.snapshot.kind,v.snapshot.payeeId]),
   client.query<{count:string}>(
    "SELECT COUNT(*)::text AS count FROM tala_live_treasury_transfers WHERE payee_kind=$1 AND payee_id=$2 AND state IN ('reserved','submitted','unknown','manual_hold')",
    [v.snapshot.kind,v.snapshot.payeeId])
  ]);
  const committed=BigInt(withdrawals.rows[0]?.amount_minor??'0');
  const proved=BigInt(transfers.rows[0]?.amount_minor??'0');
  if(proved!==v.snapshot.transferredMinor)throw Error('TREASURY_LEDGER_CHANGED');
  const balance=treasuryBalance({
   amountTransferredMinor:proved,committedWithdrawalsMinor:committed,
   stripeAvailableMinor:v.snapshot.stripeAvailableMinor,
   openFinancialCases:v.snapshot.openCases,
   pendingTransferCount:Number(holds.rows[0]?.count??'0')+v.snapshot.pendingTransfers,
   unrecognizedProviderPayouts:v.snapshot.unrecognizedPayouts,
   bankVerified:v.snapshot.bankVerified,scheduleManual:v.snapshot.scheduleManual,
   ownerApproved:v.snapshot.ownerApproved,connectReady:v.snapshot.connectReady,
   pendingUnknownWithdrawals:Number(withdrawals.rows[0]?.unknown??'0')
  });
  const day=BigInt(daily.rows[0]?.amount_minor??'0');
  const reasons=treasuryCanRequest(balance,v.amountMinor,maximumMinor,
   day>=maximumDailyMinor?0n:maximumDailyMinor-day);
  if(reasons.length)throw Error('TREASURY_REQUEST_HOLD:'+reasons.join(','));
  // A provider timeout never releases this reservation. The webhook worker
  // must resolve unknown before any other withdrawal can be made.
  const result=await client.query<{id:string}>(
   "INSERT INTO tala_live_treasury_withdrawals (payee_kind,payee_id,requested_by_user_id,connected_account_id,bank_destination_id,amount_minor,currency,client_key,totp_step,state) VALUES ($1,$2,$3,$4,$5,$6,'mxn',$7,$8,'reserved') RETURNING id::text",
   [v.snapshot.kind,v.snapshot.payeeId,v.actorUserId,v.snapshot.accountId,
    v.snapshot.bankId,v.amountMinor.toString(),v.clientKey,otpStep.toString()]);
  if(result.rows.length!==1)throw Error('TREASURY_RESERVATION_NOT_DURABLE');
  await client.query('COMMIT');began=false;
  return {id:result.rows[0]!.id,status:'reserved',created:true};
 }catch(e){
  if(began){try{await client.query('ROLLBACK');}catch{/* fail closed */}}
  throw e;
 }finally{client.release();}
}
/** Source-derived idempotency for transfer reservations; never a client token. */
export const treasuryTransferReservationKey=(orderId:number,kind:TreasuryPayee,id:number)=>{
 if(!validId(orderId)||!validId(id))throw Error('TREASURY_TRANSFER_ID_INVALID');
 return 'tala-rc85:'+orderId+':'+kind+':'+id;
};
/** A random request UUID must originate at client UI and survive retries. */
export const newTreasuryRequestId=()=>randomUUID();
