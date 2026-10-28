import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectConnectedBankAndPayouts} from '../dist/live/treasury-bank-verification.js';
const bank={id:'ba_MX123',object:'bank_account',country:'MX',currency:'mxn',
 default_for_currency:true,status:'verified'};
const payout={id:'po_ABC123',amount:5000,currency:'mxn',destination:bank.id,
 automatic:false,livemode:true,metadata:{tala_treasury_withdrawal:'10',tala_payee_kind:'restaurant',tala_payee_id:'8'},status:'paid'};
const api=({bankData=[bank],bankMore=false,payoutData=[payout],payoutMore=false}={})=>({
 accounts:{listExternalAccounts:async()=>({data:bankData,has_more:bankMore})},
 payouts:{list:async()=>({data:payoutData,has_more:payoutMore})}
});
const local=[{id:payout.id,withdrawalId:'10',payeeKind:'restaurant',payeeId:8,bankId:bank.id,amountMinor:'5000',state:'paid'}];
test('bank and payout reconciliation permits only one verified MXN destination and fully known Stripe payout IDs',async()=>{
 const a=await inspectConnectedBankAndPayouts(api(),'acct_TESTMERCHANT',local);
 assert.deepEqual(a,{verified:true,bankId:bank.id,unknownPayouts:0,reason:null});
});
test('unverified or multiple bank destinations always block withdrawability',async()=>{
 for(const args of [
  {bankData:[{...bank,status:'new'}]}, {bankData:[]},
  {bankData:[bank,{...bank,id:'ba_TWO'}]},
  {bankData:[{...bank,currency:'usd'}]}
 ]){
  const x=await inspectConnectedBankAndPayouts(api(args),'acct_TESTMERCHANT',local);
  assert.equal(x.verified,false);
  assert.equal(x.unknownPayouts,1);
 }
 await assert.rejects(inspectConnectedBankAndPayouts(api({bankMore:true}),'acct_TESTMERCHANT',local),/PAGINATION/);
});
test('unknown Stripe payout, automatic payout, wrong amount or destination block ALL funds',async()=>{
 for(const bad of [
  {...payout,id:'po_FOREIGN'}, {...payout,automatic:true},
  {...payout,amount:5001},{...payout,destination:'ba_OTHER'},
  {...payout,livemode:false},{...payout,metadata:{}}
 ]){
  await assert.rejects(inspectConnectedBankAndPayouts(
   api({payoutData:[bad]}),'acct_TESTMERCHANT',local),/UNKNOWN_STRIPE_BANK_PAYOUT/);
 }
 await assert.rejects(inspectConnectedBankAndPayouts(
  api({payoutData:[]}),'acct_TESTMERCHANT',local),/LOCAL_PAYOUT_NOT_PRESENT/);
});
test('unknown state never silently produces bank credit',async()=>{
 const x=await inspectConnectedBankAndPayouts(api({payoutData:[]}),
   'acct_TESTMERCHANT',[]);
 assert.equal(x.verified,true);
 await assert.rejects(inspectConnectedBankAndPayouts(api(),'acct_TESTMERCHANT',
  [{...local,amountMinor:'nonsense'}]),/LOCAL_PAYOUT_AUDIT/);
});
