/**
 * RC11.5: validate real production payee mapping, separate from legacy
 * isolated-stage merchant_connect_accounts. It NEVER authorizes withdrawals.
 * Caller separately fetches Stripe LIVE account and connected MXN balance.
 */
export function assessMappedLiveBeneficiary(row, account, balance, classify){
 const reasons=[];
 if(!row||!['restaurant','driver'].includes(row.payee_kind)||
    !/^[1-9][0-9]{0,10}$/.test(String(row.payee_id??''))||
    !/^acct_[A-Za-z0-9]+$/.test(String(row.stripe_account_id??'')))
  reasons.push('REAL_BENEFICIARY_IDENTITY_INVALID');
 if(row?.owner_approved!==true)reasons.push('OWNER_APPROVAL_MISSING');
 if(row?.payee_active!==true)reasons.push('BENEFICIARY_NOT_ACTIVE_OR_VERIFIED');
 if(typeof row?.identity_email!=='string'||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.identity_email)||
    typeof account?.email!=='string'||
    account.email.trim().toLowerCase()!==row.identity_email.toLowerCase())
  reasons.push('REMOTE_OWNER_EMAIL_MISMATCH');
 const mapped={
  merchantId:row?.payee_kind+':'+String(row?.payee_id??''),
  stripeAccountId:row?.stripe_account_id,
  chargesEnabled:row?.owner_approved===true,
  payoutsEnabled:row?.owner_approved===true,
 };
 const capabilities=classify(mapped,account,balance);
 if(capabilities.reasons?.length)reasons.push(...capabilities.reasons);
 return {
  canProceedToLedgerAudit:reasons.length===0,
  reasons:[...new Set(reasons)].sort(),
  withdrawable:false,transferPermitted:false,bankPayoutPermitted:false,
 };
}
