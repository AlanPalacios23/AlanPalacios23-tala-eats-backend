import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditCompletedTreasuryTransfers}
 from '../dist/live/treasury-transfer-audit.js';
import {inspectConnectedBankAndPayouts}
 from '../dist/live/treasury-bank-verification.js';
import {decideConnectedPayoutEvent}
 from '../dist/live/treasury-webhook-policy.js';

const account='acct_RC128TEST42',bank='ba_RC128BANK42';
test('RC12.8 an external TEST-mode transfer is audited ONLY with explicit TEST-mode',async()=>{
 const pool={query:async(sql)=>{
  if(sql.includes('COUNT(*)'))return {rows:[{n:'1',amount_minor:'3200'}]};
  return {rows:[{id:'1',order_id:7,payee_kind:'driver',payee_id:14,
   connected_account_id:account,stripe_transfer_id:'tr_RC128TEST',
   source_charge_id:'ch_RC128TEST',amount_minor:'3200'}]};
 }};
 const provider={
  transfers:{retrieve:async()=>({id:'tr_RC128TEST',destination:account,
   source_transaction:'ch_RC128TEST',currency:'mxn',
   livemode:false,amount:3200,amount_reversed:0})},
  charges:{retrieve:async()=>({id:'ch_RC128TEST',livemode:false,
   paid:true,refunded:false,disputed:false,currency:'mxn'})}
 };
 assert.equal(await auditCompletedTreasuryTransfers(pool,provider,'driver',14,account,false),3200n);
 await assert.rejects(
  auditCompletedTreasuryTransfers(pool,provider,'driver',14,account),
  /PROVIDER_TRANSFER_INCONSISTENT/);
});

test('RC12.8 signed TEST payout audit never silently passes LIVE policy',async()=>{
 const record={id:'po_RC128T',withdrawalId:'991',payeeKind:'restaurant',
  payeeId:10,amountMinor:'6500',bankId:bank,state:'paid'};
 const provider={
  accounts:{
   retrieve:async()=>({id:account,country:'MX',payouts_enabled:true,
    details_submitted:true,requirements:{currently_due:[],past_due:[],disabled_reason:null}}),
   listExternalAccounts:async()=>({has_more:false,data:[
    {object:'bank_account',id:bank,status:'new',country:'MX',currency:'mxn',
     default_for_currency:true,bank_name:'RC128 BANK',last4:'4321'}]})
  },
  payouts:{list:async()=>({has_more:false,data:[{
   id:record.id,livemode:false,automatic:false,destination:bank,
   currency:'mxn',amount:6500,status:'paid',metadata:{
    tala_treasury_withdrawal:record.withdrawalId,
    tala_payee_kind:'restaurant',tala_payee_id:'10'}
  }]})}
 };
 const v=await inspectConnectedBankAndPayouts(provider,account,[record],false);
 assert.equal(v.verified,true);assert.equal(v.unknownPayouts,0);
 await assert.rejects(inspectConnectedBankAndPayouts(provider,account,[record]),
  /UNKNOWN_STRIPE_BANK_PAYOUT_REQUIRES_RECONCILIATION/);
});

test('RC12.8 production payout event policy still requires LIVE by default',()=>{
 const event={eventId:'evt_RC128TEST',eventType:'payout.paid',livemode:false,
  accountId:account,payoutId:'po_RC128TEST',amountMinor:3200,
  currency:'mxn',providerDestination:bank,
  metadata:{withdrawalId:'19',payeeKind:'driver',payeeId:'14'},
  remoteStatus:'paid'};
 const record={id:'19',state:'submitted',payeeKind:'driver',payeeId:14,
  accountId:account,bankDestination:bank,amountMinor:3200,
  payoutId:'po_RC128TEST'};
 assert.throws(()=>decideConnectedPayoutEvent(event,record),
  /TREASURY_SIGNED_EVENT_MISMATCH/);
 assert.deepEqual(decideConnectedPayoutEvent(event,record,false),
  {target:'paid',requiresManualReview:false,ledgerEffect:'bank_payout_paid'});
});
test('RC12.8 LIVE app has not opted into TEST mode or money movement',()=>{
 const src=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
 const policy=readFileSync(new URL('../src/live/treasury-policy.ts',import.meta.url),'utf8');
 const route=readFileSync(new URL('../src/live/treasury-router.ts',import.meta.url),'utf8');
 assert.match(policy,/NODE_TREASURY_LIVE_EXECUTION_ENABLED=false/);
 assert.match(src,/buildTreasuryConnectWebhookRouter\(/);
 assert.doesNotMatch(src,/buildTreasuryConnectWebhookRouter\([^;]+,false\)/);
 assert.match(route,/expectedLivemode=true,excludeWithdrawalId:string\|null=null/);
});
