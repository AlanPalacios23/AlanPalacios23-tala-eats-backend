import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMappedLiveBeneficiary} from '../src/finance/rc115-live-beneficiary-policy.mjs';
import {classifyLiveConnectRecipient} from '../src/finance/rc115-connect-readiness.mjs';

const entry={
 payee_kind:'restaurant',payee_id:'11',
 stripe_account_id:'acct_Valid11',
 owner_approved:true,payee_active:true,
 identity_email:'owner@talaeats.example'
};
const account={
 id:'acct_Valid11',country:'MX',email:'owner@talaeats.example',
 charges_enabled:true,payouts_enabled:true,details_submitted:true,
 capabilities:{transfers:'active'},
 requirements:{currently_due:[],past_due:[]},
};
const balance={
 livemode:true,available:[{currency:'mxn',amount:1000}],
 pending:[{currency:'mxn',amount:0}],
};
const check=(r=entry,a=account,b=balance)=>
 assessMappedLiveBeneficiary(r,a,b,classifyLiveConnectRecipient);
test('RC115 both approved restaurants and drivers can proceed only to ledger audit',()=>{
 const rest=check();
 assert.equal(rest.canProceedToLedgerAudit,true);
 assert.equal(rest.withdrawable,false);
 assert.equal(rest.transferPermitted,false);
 assert.equal(rest.bankPayoutPermitted,false);
 const driver=check({...entry,payee_kind:'driver'});
 assert.equal(driver.canProceedToLedgerAudit,true);
 assert.equal(driver.withdrawable,false);
});
test('RC115 real owner and driver approval gates cannot be bypassed',()=>{
 for(const changed of [
  {owner_approved:false},{payee_active:false},
  {payee_kind:'admin'},{payee_id:'0'},
  {stripe_account_id:'acct_Another'},
  {identity_email:'other@talaeats.example'},
 ]){
  assert.equal(check({...entry,...changed}).canProceedToLedgerAudit,false);
 }
});
test('RC115 Stripe mismatches, unverified KYC and no funds never authorize payout',()=>{
 const badAccount={...account,email:'other@talaeats.example'};
 assert.ok(check(entry,badAccount).reasons.includes('REMOTE_OWNER_EMAIL_MISMATCH'));
 assert.equal(check(entry,{...account,payouts_enabled:false}).canProceedToLedgerAudit,false);
 assert.equal(check(entry,{...account,requirements:{currently_due:['id_number'],past_due:[]}}).canProceedToLedgerAudit,false);
 assert.equal(check(entry,account,{...balance,livemode:false}).canProceedToLedgerAudit,false);
 assert.equal(check(entry,account,{...balance,available:[{currency:'mxn',amount:0}]}).withdrawable,false);
});
