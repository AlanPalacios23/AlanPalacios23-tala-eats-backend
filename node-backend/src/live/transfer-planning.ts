/** RC8.5 transfer *preview* only, no Stripe create APIs.
 * A Stripe transfer and the bank payout are different operations.
 * This function cannot move money.
 */
import type {Party} from './payee-allocation.js';
export type TransferPrerequisites={
 orderId:number;kind:Party;payeeId:number;amountMinor:number;
 stripeAccountId:string|null;approvedByOwner:boolean;
 connectReady:boolean;chargeId:string|null;
 capturedAmountMinor:number;alreadyTransferred:boolean;
 delivered:boolean;proof:boolean;refundedMinor:number;openCases:number;
 sourceMode:'stripe'|'cash';
};
export function buildTransferProposal(x:TransferPrerequisites){
 const blockers:string[]=[];
 if(!Number.isSafeInteger(x.orderId)||x.orderId<1||
    !Number.isSafeInteger(x.payeeId)||x.payeeId<1||
    !Number.isSafeInteger(x.amountMinor)||x.amountMinor<1)
   blockers.push('INVALID_BENEFICIARY_OR_AMOUNT');
 if(x.sourceMode!=='stripe')blockers.push('NO_STRIPE_CHARGE_FOR_CASH');
 if(!x.chargeId||!/^ch_[A-Za-z0-9]+$/.test(x.chargeId))
   blockers.push('SIGNED_SOURCE_CHARGE_MISSING');
 if(!x.stripeAccountId||!/^acct_[A-Za-z0-9]+$/.test(x.stripeAccountId)||
    !x.approvedByOwner||!x.connectReady)
   blockers.push('CONNECT_NOT_READY');
 if(!x.delivered||!x.proof)blockers.push('FULFILLMENT_NOT_VERIFIED');
 if(!Number.isSafeInteger(x.refundedMinor)||x.refundedMinor!==0||
    x.openCases!==0)blockers.push('REFUND_DISPUTE_HOLD');
 if(!Number.isSafeInteger(x.capturedAmountMinor)||
    x.capturedAmountMinor<x.amountMinor)
   blockers.push('SOURCE_CHARGE_TOO_SMALL');
 if(x.alreadyTransferred)blockers.push('TRANSFER_ALREADY_RECORDED');
 return {
  beneficiary:{kind:x.kind,id:x.payeeId},
  order_id:x.orderId,
  amount_minor:x.amountMinor,
  currency:'mxn',
  destination:x.stripeAccountId,
  source_transaction:x.chargeId,
  transfer_group:'TALA-ORDER-'+x.orderId,
  idempotency_key:'tala-rc85:'+x.orderId+':'+x.kind+':'+x.payeeId,
  eligible:blockers.length===0,
  blockers,
  transfer_executed:false,
  bank_payout_confirmed:false
 };
}
