/**
 * RC9 administrator dual-control transfer journal.
 * Only a server-loaded order, immutable receipt and payout allocation can be
 * reviewed. Approval persists an idempotent reservation but NEVER calls Stripe.
 * Identical flow for restaurant and driver. Not mounted in HTTP before release.
 */
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {buildTransferProposal,type TransferPrerequisites} from './transfer-planning.js';
import type {TreasuryPayee} from './treasury-policy.js';

type ReadStripe=Pick<Stripe,'paymentIntents'|'charges'|'accounts'>;
type ApprovalPhase='review'|'approve';
const validId=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<1_000_000_000;
const accountFormat=/^acct_[A-Za-z0-9]+$/;
export type TransferReview={orderId:number;kind:TreasuryPayee;payeeId:number;
 adminId:number;adminMfaVerified:boolean;phase:ApprovalPhase};
type Order={id:number;status:string;payment_method:string;payment_status:string;
 total_minor:string;refunded_minor:string;payment_provider_id:string;
 delivered_at:Date|null};
type Allocation={payee_kind:TreasuryPayee;payee_id:number;amount_minor:string;
 tender:string;state:string;stripe_account_id:string|null;
 owner_approved_at:Date|null;owner_email:string|null};
const cents=(x:string)=>{if(!/^\d{1,12}$/.test(x))throw Error('TREASURY_MONEY_INVALID');
 const n=BigInt(x);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('TREASURY_MONEY_OVERFLOW');
 return Number(n);};
export async function recordTreasuryTransferReview(
 pool:Pool,provider:ReadStripe,action:TransferReview
):Promise<{reservationId:string;state:'manual_hold'|'reserved';idempotencyKey:string}>{
 if(!validId(action.orderId)||!validId(action.payeeId)||!validId(action.adminId)||
    !['restaurant','driver'].includes(action.kind)||
    !['review','approve'].includes(action.phase)||!action.adminMfaVerified)
  throw Error('TREASURY_ADMIN_MFA_REQUIRED');
 const client=await pool.connect();let begun=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');begun=true;
  const actor=await client.query<{role:string;two_factor_enabled:boolean;is_active:boolean}>(
   'SELECT role,two_factor_enabled,is_active FROM users WHERE id=$1 FOR UPDATE',
   [action.adminId]);
  if(actor.rows.length!==1||actor.rows[0]!.role!=='admin'||
     actor.rows[0]!.is_active!==true||actor.rows[0]!.two_factor_enabled!==true)
   throw Error('TREASURY_ADMIN_STRONG_AUTH_REQUIRED');
  // Every beneficiary for an order is serialized by the same lock to prevent
  // two legitimate payouts whose combined amount exceeds original capture.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
   ['treasury:order:'+action.orderId]);
  const result=await client.query<Order>(`
   SELECT id,status,payment_method,payment_status,
     (ROUND(total*100))::bigint::text AS total_minor,
     (ROUND(refunded_amount*100))::bigint::text AS refunded_minor,
     payment_provider_id,delivered_at
   FROM orders WHERE id=$1 FOR UPDATE`,[action.orderId]);
  const o=result.rows[0];
  if(!o||o.payment_method!=='stripe'||o.payment_status!=='paid'||
     o.status!=='delivered'||!o.delivered_at||cents(o.refunded_minor)!==0)
   throw Error('TREASURY_ORDER_NOT_SETTLEABLE');
  const allocs=await client.query<Allocation>(`
   SELECT a.payee_kind,a.payee_id,a.amount_minor::text,a.tender,a.state,
    CASE WHEN a.payee_kind='restaurant' THEN m.stripe_account_id ELSE d.stripe_account_id END AS stripe_account_id,
    CASE WHEN a.payee_kind='restaurant' THEN m.owner_approved_at ELSE d.owner_approved_at END AS owner_approved_at,
    CASE WHEN a.payee_kind='restaurant' THEN ur.email ELSE ud.email END AS owner_email
   FROM tala_live_payee_allocations a
   LEFT JOIN tala_live_merchant_accounts m ON a.payee_kind='restaurant' AND m.restaurant_id=a.payee_id
   LEFT JOIN restaurants r ON r.id=m.restaurant_id
   LEFT JOIN users ur ON ur.id=r.owner_id AND ur.is_active=true
   LEFT JOIN tala_live_driver_accounts d ON a.payee_kind='driver' AND d.user_id=a.payee_id
   LEFT JOIN users ud ON ud.id=d.user_id AND ud.is_active=true
   WHERE a.order_id=$1 ORDER BY a.payee_kind FOR UPDATE OF a
  `,[action.orderId]);
  if(allocs.rows.length<1||allocs.rows.length>2)throw Error('TREASURY_ALLOCATION_COUNT_INVALID');
  const item=allocs.rows.find(x=>x.payee_kind===action.kind&&x.payee_id===action.payeeId);
  if(!item||item.tender!=='stripe'||item.state!=='held'||!item.owner_approved_at||
    !item.owner_email||!item.stripe_account_id||
    !accountFormat.test(item.stripe_account_id))
   throw Error('TREASURY_PAYEE_ALLOCATION_OR_IDENTITY_HOLD');
  const amount=cents(item.amount_minor);
  const total=allocs.rows.reduce((n,x)=>n+cents(x.amount_minor),0);
  if(!Number.isSafeInteger(total)||total>cents(o.total_minor)||
     amount<=0||total<=0)
   throw Error('TREASURY_SPLIT_EXCEEDS_ORIGINAL_RECEIPT');
  const checks=await client.query<{proof:string;collected:string;cases:string;others:string}>(`
   SELECT (SELECT count(*) FROM delivery_proofs WHERE order_id=$1 AND pin_verified=true)::text AS proof,
    (SELECT count(*) FROM financial_ledger_entries WHERE order_id=$1
       AND kind='stripe_live_payment' AND account='stripe_live_collected'
       AND direction='credit' AND idempotency_key=('order:'||$1::text||':stripe-live:collected'))::text AS collected,
    (SELECT count(*) FROM tala_live_financial_cases WHERE order_id=$1 AND status<>'resolved')::text AS cases,
    (SELECT count(*) FROM tala_live_treasury_transfers WHERE order_id=$1
      AND payee_kind=$2 AND payee_id=$3 AND state IN ('submitted','unknown','completed','reversed'))::text AS others
  `,[action.orderId,action.kind,action.payeeId]);
  const check=checks.rows[0];
  if(!check||check.proof!=='1'||check.collected!=='1'||check.cases!=='0'||
     check.others!=='0')throw Error('TREASURY_CAPTURE_OR_DISPUTE_HOLD');
  if(!/^pi_[A-Za-z0-9]+$/.test(o.payment_provider_id))
   throw Error('TREASURY_ORIGINAL_PAYMENT_INTENT_MISSING');
  const pi=await provider.paymentIntents.retrieve(o.payment_provider_id);
  const expectedLive=process.env.NODE_ENV==='production';
  if(pi.livemode!==expectedLive||pi.status!=='succeeded'||pi.currency!=='mxn'||
    pi.metadata.order_id!==String(action.orderId)||pi.amount_received!==cents(o.total_minor))
   throw Error('TREASURY_PAYMENT_INTENT_MISMATCH');
  const chId=typeof pi.latest_charge==='string'?pi.latest_charge:pi.latest_charge?.id;
  if(!chId||!/^ch_[A-Za-z0-9]+$/.test(chId))throw Error('TREASURY_SOURCE_CHARGE_MISSING');
  const charge=await provider.charges.retrieve(chId);
  if(charge.livemode!==expectedLive||!charge.paid||!charge.captured||charge.refunded||charge.disputed||
    charge.amount_refunded!==0||charge.id!==chId||charge.currency!=='mxn'||
    charge.amount_captured!==pi.amount_received)
   throw Error('TREASURY_CAPTURE_NOT_VERIFIED');
  const account=await provider.accounts.retrieve(item.stripe_account_id);
  if(account.id!==item.stripe_account_id||account.country!=='MX'||
    account.email?.trim().toLowerCase()!==item.owner_email.trim().toLowerCase()||
    account.capabilities?.transfers!=='active'||!account.payouts_enabled||
    !account.details_submitted||account.requirements?.disabled_reason||
    (account.requirements?.currently_due?.length??0)>0||
    (account.requirements?.past_due?.length??0)>0)
   throw Error('TREASURY_CONNECT_CAPABILITIES_HOLD');
  const snapshot:TransferPrerequisites={
   orderId:action.orderId,kind:action.kind,payeeId:action.payeeId,
   amountMinor:amount,stripeAccountId:item.stripe_account_id,
   approvedByOwner:true,connectReady:true,chargeId:chId,
   capturedAmountMinor:charge.amount_captured,alreadyTransferred:false,
   delivered:true,proof:true,refundedMinor:0,openCases:0,sourceMode:'stripe'
  };
  const plan=buildTransferProposal(snapshot);
  if(!plan.eligible)throw Error('TREASURY_TRANSFER_PLAN_HOLD:'+plan.blockers.join(','));
  const current=await client.query<{id:string;state:string;reviewed_by_user_id:number|null;
    approved_by_user_id:number|null;idempotency_key:string;amount_minor:string;
    connected_account_id:string;source_charge_id:string}>(
   'SELECT id::text,state,reviewed_by_user_id,approved_by_user_id,idempotency_key,amount_minor::text,connected_account_id,source_charge_id FROM tala_live_treasury_transfers WHERE order_id=$1 AND payee_kind=$2 AND payee_id=$3 FOR UPDATE',
   [action.orderId,action.kind,action.payeeId]);
  const v=current.rows[0];
  let id:string,state:'manual_hold'|'reserved';
  if(action.phase==='review'){
   if(v)throw Error('TREASURY_TRANSFER_REVIEW_ALREADY_EXISTS');
   const inserted=await client.query<{id:string}>(
    "INSERT INTO tala_live_treasury_transfers(order_id,payee_kind,payee_id,connected_account_id,source_charge_id,amount_minor,currency,state,idempotency_key,reviewed_by_user_id) VALUES($1,$2,$3,$4,$5,$6,'mxn','manual_hold',$7,$8) RETURNING id::text",
    [action.orderId,action.kind,action.payeeId,item.stripe_account_id,chId,
     amount,plan.idempotency_key,action.adminId]);
   id=inserted.rows[0]!.id;state='manual_hold';
  }else{
   if(!v||v.state!=='manual_hold'||!validId(v.reviewed_by_user_id??0)||
      v.reviewed_by_user_id===action.adminId||v.approved_by_user_id!==null||
      v.idempotency_key!==plan.idempotency_key||
      v.amount_minor!==String(amount)||v.connected_account_id!==item.stripe_account_id||
      v.source_charge_id!==chId)
    throw Error('TREASURY_DUAL_CONTROL_OR_SNAPSHOT_CHANGED');
   const approved=await client.query<{id:string}>(
    "UPDATE tala_live_treasury_transfers SET state='reserved',approved_by_user_id=$2,updated_at=NOW() WHERE id=$1 AND state='manual_hold' AND reviewed_by_user_id<>$2 RETURNING id::text",
    [v.id,action.adminId]);
   if(approved.rowCount!==1)throw Error('TREASURY_TRANSFER_APPROVAL_RACE');
   id=approved.rows[0]!.id;state='reserved';
  }
  await client.query('COMMIT');begun=false;
  return {reservationId:id!,state:state!,idempotencyKey:plan.idempotency_key};
 }catch(err){if(begun)await client.query('ROLLBACK').catch(()=>{});throw err;}
 finally{client.release();}
}
