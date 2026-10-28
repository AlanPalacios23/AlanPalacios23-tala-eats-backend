/**
 * Conservative Stripe Connect bank + payout history audit.
 * Read-only provider operations, never creates or schedules a payout.
 * Unknown bank account, automatic payouts, pagination overflow or unrecognized
 * provider payout ID => reconciliation HOLD, never positive withdrawable cash.
 */
import type Stripe from 'stripe';
export type BankAudit={verified:boolean;bankId:string|null;
 unknownPayouts:number;reason:string|null};
export async function inspectConnectedBankAndPayouts(
 provider:Pick<Stripe,'accounts'|'payouts'>,account:string,
 local:readonly {id:string;withdrawalId:string;payeeKind:'restaurant'|'driver';
  payeeId:number;amountMinor:string;bankId:string;state:string}[]
):Promise<BankAudit>{
 if(!/^acct_[A-Za-z0-9]+$/.test(account))throw Error('CONNECT_ACCOUNT_INVALID');
 const external=await provider.accounts.listExternalAccounts(account,{object:'bank_account',limit:100});
 // Never trust incomplete pagination: the default destination might not be
 // the only active bank account, or the account could be cross-routed.
 if(external.has_more)throw Error('BANK_DESTINATION_PAGINATION_REQUIRED');
 const bank=external.data.filter(b=>b.object==='bank_account'&&
  b.default_for_currency===true&&b.currency==='mxn'&&b.country==='MX');
 if(bank.length!==1)return {verified:false,bankId:null,unknownPayouts:1,
  reason:'BANK_ACCOUNT_NOT_UNIQUELY_VERIFIED'};
 const chosen=bank[0]!;
 if(chosen.object!=='bank_account'||chosen.status!=='verified'||
    !/^ba_[A-Za-z0-9]+$/.test(chosen.id))
  return {verified:false,bankId:null,unknownPayouts:1,
   reason:'BANK_ACCOUNT_KYC_PENDING'};
 const known=new Map<string,{withdrawalId:string;payeeKind:string;payeeId:number;
 amountMinor:string;bankId:string;state:string}>();
 for(const r of local){
  if(!/^po_[A-Za-z0-9]+$/.test(r.id)||known.has(r.id)||
     !/^[1-9][0-9]{0,15}$/.test(r.withdrawalId)||
     !Number.isSafeInteger(r.payeeId)||r.payeeId<1||
     !/^\d{1,16}$/.test(r.amountMinor)||r.bankId!==chosen.id)
    throw Error('LOCAL_PAYOUT_AUDIT_INCONSISTENT');
  known.set(r.id,r);
 }
 let cursor:string|undefined;
 const seen=new Set<string>();
 let total=0,complete=false;
 for(let p=0;p<10;p++){
  const list=await provider.payouts.list(
   {limit:100,...(cursor?{starting_after:cursor}:{})},
   {stripeAccount:account});
  if(!Array.isArray(list.data)||list.data.length>100)throw Error('PAYOUT_PAGE_INVALID');
  for(const payout of list.data){
   const recorded=known.get(payout.id);
   if(!recorded||seen.has(payout.id)||payout.automatic!==false||
      payout.destination!==chosen.id||payout.currency!=='mxn'||
      !payout.livemode||!Number.isSafeInteger(payout.amount)||
      BigInt(payout.amount)!==BigInt(recorded.amountMinor)||
      payout.metadata?.tala_treasury_withdrawal!==recorded.withdrawalId||
      payout.metadata?.tala_payee_kind!==recorded.payeeKind||
      payout.metadata?.tala_payee_id!==String(recorded.payeeId)||
      (recorded.state==='paid'&&payout.status!=='paid')||
      (payout.status==='paid'&&recorded.state!=='paid')||
      (recorded.state==='failed'&&payout.status!=='failed')||
      (recorded.state==='canceled'&&payout.status!=='canceled'))
     throw Error('UNKNOWN_STRIPE_BANK_PAYOUT_REQUIRES_RECONCILIATION');
   seen.add(payout.id);total++;
  }
  if(!list.has_more){complete=true;break;}
  if(list.data.length===0||list.data.at(-1)?.id===cursor)
   throw Error('PAYOUT_PAGINATION_INCONSISTENT');
  cursor=list.data.at(-1)!.id;
 }
 if(!complete)throw Error('PAYOUT_HISTORY_OVER_1000_REQUIRES_REVIEW');
 if(seen.size!==known.size)throw Error('LOCAL_PAYOUT_NOT_PRESENT_AT_STRIPE');
 return {verified:true,bankId:chosen.id,unknownPayouts:0,reason:null};
}
