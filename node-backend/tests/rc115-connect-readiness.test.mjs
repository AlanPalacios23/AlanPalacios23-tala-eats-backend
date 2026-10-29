import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyLiveConnectRecipient as classify}
 from '../src/finance/rc115-connect-readiness.mjs';
const mapping=()=>({
 merchantId:'restaurant:7',stripeAccountId:'acct_Valid123',
 chargesEnabled:true,payoutsEnabled:true,
});
const account=()=>({
 id:'acct_Valid123',country:'MX',charges_enabled:true,payouts_enabled:true,
 details_submitted:true,capabilities:{transfers:'active'},
 requirements:{currently_due:[],past_due:[]},
});
const balance=()=>({
 livemode:true,available:[{currency:'mxn',amount:15000}],
 pending:[{currency:'mxn',amount:2000}],
});
const check=(m=mapping(),a=account(),b=balance())=>classify(m,a,b);
test('RC11.5 LIVE Connect readiness never declares available funds withdrawable',()=>{
 const out=check();assert.equal(out.readyForFurtherFinancialReconciliation,true);
 assert.equal(out.providerAvailableMinor,15000);
 assert.equal(out.providerPendingMinor,2000);
 assert.equal(out.withdrawable,false);
 assert.equal(out.transferPermitted,false);
 assert.equal(out.bankPayoutPermitted,false);
 assert.equal(out.requiresBeneficiaryLedgerReconciliation,true);
});
test('RC11.5 fails with stale/foreign account or mapping that is not approved',()=>{
 assert.ok(check(mapping(),{...account(),id:'acct_Foreign'})
  .reasons.includes('REMOTE_ACCOUNT_MISMATCH_OR_COUNTRY'));
 assert.ok(check({...mapping(),payoutsEnabled:false})
  .reasons.includes('LOCAL_CONNECT_MAPPING_NOT_APPROVED'));
 assert.ok(check(mapping(),{...account(),country:'US'})
  .reasons.includes('REMOTE_ACCOUNT_MISMATCH_OR_COUNTRY'));
});
test('RC11.5 blocks KYC deficiency and inactive transfers/payouts',()=>{
 assert.ok(check(mapping(),{...account(),requirements:{
   currently_due:['some_required_field'],past_due:[]}})
  .reasons.includes('CONNECT_KYC_REQUIREMENTS_DUE'));
 assert.ok(check(mapping(),{...account(),capabilities:{transfers:'inactive'}})
  .reasons.includes('CONNECT_CAPABILITIES_NOT_ACTIVE'));
 assert.ok(check(mapping(),{...account(),payouts_enabled:false})
  .reasons.includes('CONNECT_CAPABILITIES_NOT_ACTIVE'));
});
test('RC11.5 cannot infer money availability without exact LIVE MXN balance',()=>{
 assert.ok(check(mapping(),account(),{...balance(),livemode:false})
  .reasons.includes('CONNECT_BALANCE_NOT_LIVE'));
 assert.ok(check(mapping(),account(),{...balance(),
    available:[{currency:'usd',amount:1000}]})
  .reasons.includes('CONNECT_BALANCE_UNVERIFIABLE'));
 assert.ok(check(mapping(),account(),{...balance(),
    available:[{currency:'mxn',amount:1000},{currency:'mxn',amount:2000}]})
  .reasons.includes('CONNECT_BALANCE_UNVERIFIABLE'));
 assert.ok(check(mapping(),account(),{...balance(),
    available:[{currency:'mxn',amount:-1}]})
  .reasons.includes('CONNECT_BALANCE_UNVERIFIABLE'));
});
test('RC11.5 must not identify a payout route from no connected recipient',()=>{
 const out=check(null,null,null);
 assert.equal(out.readyForFurtherFinancialReconciliation,false);
 assert.equal(out.withdrawable,false);
 assert.ok(out.reasons.includes('MAPPING_MISSING_OR_INVALID'));
});
