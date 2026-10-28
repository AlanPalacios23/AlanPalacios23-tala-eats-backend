/** Signed Stripe Connect payout event decision, pure and NON-MOUNTED.
 * Controller must verify a dedicated Connect webhook HMAC, event.account,
 * livemode and remote payouts.retrieve BEFORE using this function.
 * Duplicate receipts are handled by event_id PK and an ACID row lock.
 */
export type TreasuryPayoutState=
 'reserved'|'submitted'|'unknown'|'paid'|'failed'|'canceled'|'review_required';
export type StripePayoutUpdate={
 eventId:string;eventType:string;livemode:boolean;accountId:string;
 payoutId:string;amountMinor:number;currency:string;
 metadata:{withdrawalId:string;payeeKind:string;payeeId:string};
 remoteStatus:string;providerDestination:string;
};
export type TreasuryPayoutRecord={
 id:string;state:TreasuryPayoutState;payeeKind:'restaurant'|'driver';
 payeeId:number;accountId:string;bankDestination:string;
 amountMinor:number;payoutId:string|null;
};
export type TreasuryPayoutDecision={
 target:TreasuryPayoutState;requiresManualReview:boolean;
 ledgerEffect:'none'|'bank_payout_paid'|'bank_payout_reversed';
};
export function decideConnectedPayoutEvent(
 e:StripePayoutUpdate,w:TreasuryPayoutRecord
):TreasuryPayoutDecision{
 if(!/^evt_[A-Za-z0-9]+$/.test(e.eventId)||
   !/^po_[A-Za-z0-9]+$/.test(e.payoutId)||
   !/^acct_[A-Za-z0-9]+$/.test(e.accountId)||e.accountId!==w.accountId||
   !e.livemode||e.currency!=='mxn'||e.providerDestination!==w.bankDestination||
   !Number.isSafeInteger(e.amountMinor)||e.amountMinor!==w.amountMinor||
   !Number.isSafeInteger(w.payeeId)||w.payeeId<1||
   e.metadata.withdrawalId!==w.id||e.metadata.payeeKind!==w.payeeKind||
   e.metadata.payeeId!==String(w.payeeId)||
   (w.payoutId!==null&&w.payoutId!==e.payoutId))
   throw Error('TREASURY_SIGNED_EVENT_MISMATCH');
 const expected={
  'payout.created':['pending','in_transit'],
  'payout.updated':['pending','in_transit','paid','failed','canceled'],
  'payout.paid':['paid'],'payout.failed':['failed'],'payout.canceled':['canceled']
 } as const;
 const accepted=expected[e.eventType as keyof typeof expected];
 if(!accepted||!(accepted as readonly string[]).includes(e.remoteStatus))
   throw Error('TREASURY_EVENT_PROVIDER_STATUS_CONFLICT');
 if(w.state==='review_required')return {
  target:w.state,requiresManualReview:true,ledgerEffect:'none'
 };
 const terminal=e.remoteStatus==='paid'||e.remoteStatus==='failed'||e.remoteStatus==='canceled';
 if(!terminal)return {
  target:w.state==='paid'||w.state==='failed'||w.state==='canceled'
   ?'review_required': 'submitted',
  requiresManualReview:w.state==='paid'||w.state==='failed'||w.state==='canceled',
  ledgerEffect:'none'
 };
 const target=e.remoteStatus as 'paid'|'failed'|'canceled';
 if(w.state===target)return {target,requiresManualReview:false,ledgerEffect:'none'};
 if(['paid','failed','canceled'].includes(w.state))
  return {target:'review_required',requiresManualReview:true,ledgerEffect:'none'};
 return {target,requiresManualReview:false,
  ledgerEffect:target==='paid'?'bank_payout_paid':'none'};
}
