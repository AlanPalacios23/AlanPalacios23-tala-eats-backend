/**
 * RC11.5: READ-ONLY Stripe Connect readiness classifier. A provider balance
 * is never identical to merchant/driver withdrawable earnings.
 * No transfer, payout, or spend authorization is returned by this module.
 */
const mxnBalance = rows => {
 if(!Array.isArray(rows))return null;
 const items=rows.filter(x=>x?.currency==='mxn');
 if(items.length!==1||!Number.isSafeInteger(items[0].amount)||items[0].amount<0)
  return null;
 return items[0].amount;
};
export function classifyLiveConnectRecipient(row,account,balance) {
 const errors=[];
 if(!row||!/^acct_[A-Za-z0-9]+$/.test(row.stripeAccountId??'')||
    !row.merchantId)errors.push('MAPPING_MISSING_OR_INVALID');
 if(!account||account.id!==row?.stripeAccountId||account.country!=='MX')
  errors.push('REMOTE_ACCOUNT_MISMATCH_OR_COUNTRY');
 if(account?.charges_enabled!==true||account?.payouts_enabled!==true||
    account?.details_submitted!==true||account?.capabilities?.transfers!=='active')
  errors.push('CONNECT_CAPABILITIES_NOT_ACTIVE');
 const requirements=account?.requirements;
 if(!requirements||!Array.isArray(requirements.currently_due)||
    !Array.isArray(requirements.past_due)||
    requirements.currently_due.length!==0||requirements.past_due.length!==0)
  errors.push('CONNECT_KYC_REQUIREMENTS_DUE');
 if(row?.chargesEnabled!==true||row?.payoutsEnabled!==true)
  errors.push('LOCAL_CONNECT_MAPPING_NOT_APPROVED');
 const available=mxnBalance(balance?.available);
 const pending=mxnBalance(balance?.pending);
 if(available===null||pending===null)errors.push('CONNECT_BALANCE_UNVERIFIABLE');
 if(balance?.livemode!==true)errors.push('CONNECT_BALANCE_NOT_LIVE');
 return {
  readyForFurtherFinancialReconciliation:errors.length===0,
  reasons:[...new Set(errors)].sort(),
  providerAvailableMinor:available,
  providerPendingMinor:pending,
  // Strict separation: neither balance nor capability grants an entitlement.
  withdrawable:false,transferPermitted:false,bankPayoutPermitted:false,
  requiresBeneficiaryLedgerReconciliation:true,
 };
}
