import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mockableTransferExecution,mockableBankPayoutExecution} from '../dist/live/treasury-execution.js';
const transferInput={
 orderId:81,kind:'restaurant',payeeId:12,amountMinor:8500,
 stripeAccountId:'acct_RESTAURANT12',approvedByOwner:true,connectReady:true,
 chargeId:'ch_ORDER81',capturedAmountMinor:11000,alreadyTransferred:false,
 delivered:true,proof:true,refundedMinor:0,openCases:0,sourceMode:'stripe'
};
const reservation={
 id:'149',state:'reserved',approved:{reviewedBy:7,approvedBy:9},
 input:transferInput,idempotencyKey:'tala-rc85:81:restaurant:12'
};
const payout={id:'501',state:'reserved',kind:'driver',payeeId:63,
 accountId:'acct_DRIVER63',bankId:'ba_VERIFIED63',amountMinor:3200,
 idempotencyKey:'tala:treasury:payout:v1:501',
 verifiedWithdrawableMinor:5500,approved:{reviewedBy:7,approvedBy:9}};
test('both Stripe financial primitives fail closed without explicit release',async()=>{
 let called=0;
 const provider={transfers:{create:()=>{called++}},charges:{retrieve:()=>{called++}},
  payouts:{create:()=>{called++}}};
 await assert.rejects(mockableTransferExecution(provider,reservation,false),/MONEY_RELEASE_NOT_APPROVED/);
 await assert.rejects(mockableBankPayoutExecution(provider,payout,false),/BANK_PAYOUT_NOT_RELEASED/);
 assert.equal(called,0,'money provider MUST NOT be called when release disabled');
});
test('dual approval and source charge prevent transfer even with isolated mock enabled',async()=>{
 let calls=0;
 const provider={charges:{retrieve:()=>{calls++;return {id:'ch_ORDER81',livemode:true,
  paid:true,captured:true,disputed:false,refunded:false,amount_refunded:0,
  currency:'mxn',amount_captured:11000}}},
  transfers:{create:()=>{calls++;return {id:'tr_mock',livemode:true,currency:'mxn',
   destination:'acct_RESTAURANT12',amount:8500,source_transaction:'ch_ORDER81'}}}};
 await assert.rejects(mockableTransferExecution(provider,{...reservation,
  approved:{reviewedBy:7,approvedBy:7}},true),/DUAL_APPROVAL_REQUIRED/);
 await assert.rejects(mockableTransferExecution(provider,{...reservation,
  input:{...transferInput,refundedMinor:50}},true),/TRANSFER_PREVIEW_BLOCKED/);
 await assert.rejects(mockableTransferExecution(provider,{...reservation,
  idempotencyKey:'wrong'},true),/IDEMPOTENCY_MISMATCH/);
 assert.equal(calls,0);
 const done=await mockableTransferExecution(provider,reservation,true);
 assert.equal(done.status,'submitted');
 assert.equal(done.transferId,'tr_mock');
 assert.equal(calls,2);
});
test('bank payout mock cannot exceed verified funds or bypass separate approvers',async()=>{
 let n=0;
 const provider={payouts:{create:(_args,opts)=>{
  n++;assert.equal(opts.stripeAccount,'acct_DRIVER63');
  return {id:'po_mock',livemode:true,amount:3200,currency:'mxn',
   destination:'ba_VERIFIED63',status:'pending',metadata:{tala_treasury_withdrawal:'501'}};
 }}};
 await assert.rejects(mockableBankPayoutExecution(provider,{...payout,
  verifiedWithdrawableMinor:0},true),/AMOUNT_EXCEEDS_VERIFIED_BALANCE/);
 await assert.rejects(mockableBankPayoutExecution(provider,{...payout,
  bankId:'ba_../../malicious'},true),/UNVERIFIED_BANK_DESTINATION/);
 await assert.rejects(mockableBankPayoutExecution(provider,{...payout,
  approved:{reviewedBy:3,approvedBy:3}},true),/DUAL_APPROVAL_REQUIRED/);
 assert.equal(n,0);
 const done=await mockableBankPayoutExecution(provider,payout,true);
 assert.equal(done.status,'submitted');
 assert.equal(n,1);
});

test('production process cannot call Stripe provider even if a caller supplies approval=true',()=>{
 const inline=`
  import {mockableBankPayoutExecution} from './dist/live/treasury-execution.js';
  let calls=0;
  const provider={payouts:{create(){calls++;throw Error('PROVIDER_CALLED');}}};
  const row={id:'33',state:'reserved',kind:'driver',payeeId:63,
    accountId:'acct_DRIVER63',bankId:'ba_BANK63',amountMinor:100,
    idempotencyKey:'tala:treasury:payout:v1:33',
    verifiedWithdrawableMinor:100,approved:{reviewedBy:4,approvedBy:5}};
  try{await mockableBankPayoutExecution(provider,row,true);process.exit(8);}
  catch(e){if(!String(e).includes('PRODUCTION_FINANCIAL_GATE_LOCKED')||calls!==0)process.exit(9);}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',inline],{
  cwd:process.cwd(),env:{PATH:process.env.PATH??'',NODE_ENV:'production'},
  encoding:'utf8',timeout:6000});
 assert.equal(child.status,0,child.stderr);
});
