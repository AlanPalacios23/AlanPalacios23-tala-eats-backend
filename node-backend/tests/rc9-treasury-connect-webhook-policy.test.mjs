import test from 'node:test';
import assert from 'node:assert/strict';
import {decideConnectedPayoutEvent} from '../dist/live/treasury-webhook-policy.js';
const row={id:'501',state:'submitted',payeeKind:'driver',payeeId:9,
 accountId:'acct_DRIVER9',bankDestination:'ba_BANK9',amountMinor:3200,payoutId:'po_PAYOUT501'};
const event={eventId:'evt_event501',eventType:'payout.paid',livemode:true,
 accountId:'acct_DRIVER9',payoutId:'po_PAYOUT501',amountMinor:3200,currency:'mxn',
 metadata:{withdrawalId:'501',payeeKind:'driver',payeeId:'9'},
 remoteStatus:'paid',providerDestination:'ba_BANK9'};
test('signed payout paid requires exact Connect account, bank, cents and metadata',()=>{
 const x=decideConnectedPayoutEvent(event,row);
 assert.deepEqual(x,{target:'paid',requiresManualReview:false,ledgerEffect:'bank_payout_paid'});
 assert.deepEqual(decideConnectedPayoutEvent(event,{...row,state:'paid'}),{
  target:'paid',requiresManualReview:false,ledgerEffect:'none'});
});
test('out-of-order provider status, foreign account, wrong amount and TEST event fail closed',()=>{
 for(const change of [{livemode:false},{accountId:'acct_OTHER'},{amountMinor:3201},
  {providerDestination:'ba_FOREIGN'}, {metadata:{withdrawalId:'500',payeeKind:'driver',payeeId:'9'}},
  {eventType:'payout.paid',remoteStatus:'pending'},{eventId:'garbage'},
 ]){
  assert.throws(()=>decideConnectedPayoutEvent({...event,...change},row));
 }
});
test('terminal status reversals never silently mark paid or release funds',()=>{
 const reverse=decideConnectedPayoutEvent({...event,eventType:'payout.failed',remoteStatus:'failed'},
  {...row,state:'paid'});
 assert.deepEqual(reverse,{target:'review_required',requiresManualReview:true,ledgerEffect:'none'});
 const stale=decideConnectedPayoutEvent({...event,eventType:'payout.created',remoteStatus:'pending'},
  {...row,state:'paid'});
 assert.equal(stale.target,'review_required');
 assert.equal(stale.ledgerEffect,'none');
 const canceled=decideConnectedPayoutEvent({...event,eventType:'payout.canceled',remoteStatus:'canceled'},row);
 assert.equal(canceled.target,'canceled');
 assert.equal(canceled.ledgerEffect,'none');
});
