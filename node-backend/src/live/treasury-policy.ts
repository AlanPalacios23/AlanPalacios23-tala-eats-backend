/**
 * Tala Eats Treasury v1 — deterministic bank-withdrawal eligibility.
 * Both restaurant and driver beneficiaries use the same integer-cent policy.
 * IMPORTANT: an order payable, held allocation or Stripe account capability
 * is NOT an available bank balance. Only reconciled CONNECT transfers count.
 * Pure code: does not import server config, database, network or secrets.
 */
export type TreasuryPayee='restaurant'|'driver';
export type TreasuryInput={
  amountTransferredMinor:bigint;       // confirmed immutable transfers only
  committedWithdrawalsMinor:bigint;    // reserved, unknown, submitted AND paid
  stripeAvailableMinor:bigint;         // Stripe connected account, MXN card
  openFinancialCases:number;
  pendingTransferCount:number;
  unrecognizedProviderPayouts:number;
  bankVerified:boolean;
  scheduleManual:boolean;
  ownerApproved:boolean;
  connectReady:boolean;
  pendingUnknownWithdrawals:number;
};
export type TreasuryBalance={
  eligibleMinor:bigint;
  reservedMinor:bigint;
  providerAvailableMinor:bigint;
  withdrawableMinor:bigint;
  eligible:boolean;
  blockers:string[];
  currency:'mxn';source:'verified_connect_transfers_only';
};
const validMoney=(v:bigint)=>typeof v==='bigint'&&v>=0n&&v<=9_000_000_000_000n;
const validCount=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=1000000;
export function treasuryBalance(x:TreasuryInput):TreasuryBalance{
  const amounts=[x.amountTransferredMinor,x.committedWithdrawalsMinor,x.stripeAvailableMinor];
  if(!amounts.every(validMoney)||
     ![x.openFinancialCases,x.pendingTransferCount,x.unrecognizedProviderPayouts,
       x.pendingUnknownWithdrawals].every(validCount))
    throw Error('TREASURY_SNAPSHOT_INVALID');
  const blockers:string[]=[];
  if(!x.ownerApproved||!x.connectReady)blockers.push('CONNECT_OWNER_OR_KYC_NOT_READY');
  if(!x.bankVerified||!x.scheduleManual)blockers.push('BANK_ACCOUNT_NOT_VERIFIED_MANUAL');
  if(x.openFinancialCases!==0)blockers.push('OPEN_REFUND_OR_DISPUTE');
  if(x.pendingTransferCount!==0)blockers.push('UNRECONCILED_STRIPE_TRANSFER');
  if(x.unrecognizedProviderPayouts!==0)blockers.push('UNKNOWN_EXTERNAL_PAYOUT');
  if(x.pendingUnknownWithdrawals!==0)blockers.push('PRIOR_WITHDRAWAL_RECONCILIATION_HOLD');
  if(x.committedWithdrawalsMinor>x.amountTransferredMinor)
    blockers.push('WITHDRAWALS_EXCEED_RECONCILED_TRANSFERS');
  const remaining=x.amountTransferredMinor>x.committedWithdrawalsMinor?
    x.amountTransferredMinor-x.committedWithdrawalsMinor:0n;
  const available=remaining<x.stripeAvailableMinor?remaining:x.stripeAvailableMinor;
  // Fail closed: no money may be available if ANY identity or ledger gate failed.
  return {
    eligibleMinor:x.amountTransferredMinor,
    reservedMinor:x.committedWithdrawalsMinor,
    providerAvailableMinor:x.stripeAvailableMinor,
    withdrawableMinor:blockers.length===0?available:0n,
    eligible:blockers.length===0&&available>=100n,
    blockers,currency:'mxn',source:'verified_connect_transfers_only'
  };
}
export const displayMinor=(v:bigint):string=>{
 if(!validMoney(v))throw Error('TREASURY_MONEY_INVALID');
 return (v/100n).toString()+'.'+(v%100n).toString().padStart(2,'0');
};
export function treasuryCanRequest(b:TreasuryBalance,amountMinor:bigint,maxPerRequestMinor:bigint,
  dailyRemainingMinor:bigint):string[]{
 const problems=[...b.blockers];
 if(!validMoney(amountMinor)||amountMinor<100n||amountMinor>maxPerRequestMinor)
   problems.push('AMOUNT_OUTSIDE_APPROVED_LIMIT');
 if(amountMinor>b.withdrawableMinor)problems.push('INSUFFICIENT_VERIFIED_BALANCE');
 if(amountMinor>dailyRemainingMinor)problems.push('DAILY_LIMIT_EXCEEDED');
 return [...new Set(problems)];
}
/** Explicitly disabled until treasury executor/Connect payout reconciliation passes a separate live audit. */
export const NODE_TREASURY_LIVE_EXECUTION_ENABLED=false as const;
