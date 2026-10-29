/**
 * RC11.6 financial recovery decision: telemetry only.
 * A zero backlog is necessary but not sufficient to prove refund automation.
 * No auto-acknowledge, refund, cash movement, payout or case closure.
 */
const keys = [
 'staleSignedEvents',
 'unresolvedFinancialCases',
 'suspectStripeCaptures',
 'unreconciledRefunds',
 'invalidCancelledInventory',
 'cashDeliveryWithoutProof',
 'cashDeliveryCollectionMismatch',
 'stuckProviderReservations',
 'staleOutbox',
 'readyDeliveryWithoutDriver',
 'unknownTreasuryWithdrawals',
];
export function assessLiveRecoveryCounters(c, opts={}) {
 const errors=[];
 if(!c || typeof c!=='object' || Array.isArray(c))
  return {pass:false,launchApproved:false,refundsFullyAutomatic:false,
   reasons:['INVALID_COUNTERS']};
 for(const key of keys){
  if(!Number.isSafeInteger(c[key])||c[key]<0||c[key]>1_000_000_000)
   errors.push('INVALID_'+key.toUpperCase());
  else if(c[key]>0)errors.push('PENDING_'+key.toUpperCase());
 }
 if(opts.hasObservedRealOrders!==true)
  errors.push('NO_REAL_OPERATIONS_EVIDENCE');
 if(opts.backupRestoreProven!==true)
  errors.push('RESTORE_PROOF_MISSING');
 if(opts.alertDeliveryProven!==true)
  errors.push('ALERT_RECEIPT_PROOF_MISSING');
 return {
  pass:errors.length===0, // READ-ONLY data gate, not launch or refund approval
  launchApproved:false,
  refundsFullyAutomatic:false,
  reasons:[...new Set(errors)].sort(),
 };
}
export const recoveryCounterKeys = Object.freeze(keys);
