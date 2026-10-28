/**
 * Controlled payout adapter for a FUTURE treasury release.
 * NOT mounted in HTTP router or worker. Production config explicitly forbids
 * Connect transfers; this module is used in offline/mock tests only.
 *
 * Durable DB reservation and verified balance MUST precede calling these.
 * Provider timeouts are UNKNOWN, never retried with a fresh key.
 */
import type Stripe from 'stripe';
import {buildTransferProposal,type TransferPrerequisites} from './transfer-planning.js';

export type DualApproval={reviewedBy:number;approvedBy:number};
export type TransferReservation={
  id:string; state:'reserved';approved:DualApproval;input:TransferPrerequisites;
  idempotencyKey:string;
};
export type PayoutReservation={
  id:string;state:'reserved';kind:'restaurant'|'driver';payeeId:number;
  accountId:string;bankId:string;amountMinor:number;idempotencyKey:string;
  verifiedWithdrawableMinor:number;approved:DualApproval;
};
const assert=(ok:unknown,reason:string):asserts ok=>{
 if(!ok)throw Error('TREASURY_DENIED:'+reason);
};
function approved(a:DualApproval){
 assert(Number.isSafeInteger(a.reviewedBy)&&a.reviewedBy>0&&
  Number.isSafeInteger(a.approvedBy)&&a.approvedBy>0&&
  a.reviewedBy!==a.approvedBy,'DUAL_APPROVAL_REQUIRED');
}
/**
 * Verify the original Stripe charge, approved payee, amount and reference,
 * then issue exactly ONE Stripe Transfer using reservation-derived idempotency.
 */
export async function mockableTransferExecution(
  provider:Pick<Stripe,'transfers'|'charges'>,reservation:TransferReservation,
  releaseApproved:boolean
){
 assert(releaseApproved,'MONEY_RELEASE_NOT_APPROVED');
 assert(reservation.state==='reserved','NOT_ATOMICALLY_RESERVED');
 approved(reservation.approved);
 const plan=buildTransferProposal(reservation.input);
 assert(plan.eligible,'TRANSFER_PREVIEW_BLOCKED:'+plan.blockers.join(','));
 assert(reservation.idempotencyKey===plan.idempotency_key,'IDEMPOTENCY_MISMATCH');
 const charge=await provider.charges.retrieve(plan.source_transaction!);
 assert(charge.livemode===true&&charge.paid===true&&
  charge.captured===true&&charge.disputed===false&&
  charge.refunded===false&&charge.amount_refunded===0&&
  charge.currency==='mxn'&&charge.id===plan.source_transaction&&
  charge.amount_captured>=reservation.input.capturedAmountMinor,
  'UNVERIFIED_OR_REVERSED_SOURCE_CHARGE');
 const created=await provider.transfers.create({
  amount:plan.amount_minor,currency:'mxn',destination:plan.destination!,
  source_transaction:plan.source_transaction!,transfer_group:plan.transfer_group,
  metadata:{tala_order_id:String(reservation.input.orderId),
   tala_payee_kind:reservation.input.kind,tala_payee_id:String(reservation.input.payeeId),
   tala_treasury_reservation:reservation.id},
 },{idempotencyKey:reservation.idempotencyKey});
 assert(created.livemode===true&&created.id.startsWith('tr_')&&
  created.destination===plan.destination&&created.amount===plan.amount_minor&&
  created.currency==='mxn'&&created.source_transaction===plan.source_transaction,
  'STRIPE_TRANSFER_RESPONSE_INCONSISTENT');
 return {transferId:created.id,amountMinor:created.amount,status:'submitted' as const};
}
/**
 * Bank payout is different from Transfer! Do NOT invoke until Stripe manual
 * payout schedule, bank destination, ledger and current Balance were checked.
 * The caller must reserve idempotently in PostgreSQL BEFORE invoking Stripe.
 */
export async function mockableBankPayoutExecution(
 provider:Pick<Stripe,'payouts'>,reservation:PayoutReservation,
 releaseApproved:boolean
){
 assert(releaseApproved,'BANK_PAYOUT_NOT_RELEASED');
 assert(reservation.state==='reserved','NOT_ATOMICALLY_RESERVED');
 approved(reservation.approved);
 assert(Number.isSafeInteger(reservation.payeeId)&&reservation.payeeId>0&&
  Number.isSafeInteger(reservation.amountMinor)&&reservation.amountMinor>=100&&
  Number.isSafeInteger(reservation.verifiedWithdrawableMinor)&&
  reservation.verifiedWithdrawableMinor>=reservation.amountMinor,
  'AMOUNT_EXCEEDS_VERIFIED_BALANCE');
 assert(/^acct_[A-Za-z0-9]+$/.test(reservation.accountId)&&
  /^ba_[A-Za-z0-9]+$/.test(reservation.bankId),'UNVERIFIED_BANK_DESTINATION');
 assert(reservation.idempotencyKey==='tala:treasury:payout:v1:'+reservation.id,
  'PAYOUT_IDEMPOTENCY_MISMATCH');
 const created=await provider.payouts.create({
  amount:reservation.amountMinor,currency:'mxn',method:'standard',source_type:'card',
  destination:reservation.bankId,
  metadata:{tala_treasury_withdrawal:reservation.id,
   tala_payee_kind:reservation.kind,tala_payee_id:String(reservation.payeeId)},
 },{stripeAccount:reservation.accountId,idempotencyKey:reservation.idempotencyKey});
 assert(created.livemode===true&&created.id.startsWith('po_')&&
  created.amount===reservation.amountMinor&&created.currency==='mxn'&&
  created.destination===reservation.bankId&&
  ['pending','in_transit','paid'].includes(created.status)&&
  created.metadata.tala_treasury_withdrawal===reservation.id,
  'STRIPE_PAYOUT_RESPONSE_INCONSISTENT');
 // Status must stay submitted/unknown until a VERIFIED connected-account webhook
 // + server retrieval confirms terminal status. Never return 'paid' here.
 return {payoutId:created.id,status:'submitted' as const};
}
