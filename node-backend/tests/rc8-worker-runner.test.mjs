import test from 'node:test';
import assert from 'node:assert/strict';
import {rc8WorkerIteration} from '../dist/live/worker-runner.js';

test('RC8 finance worker never declares readiness even when inbox is empty',async()=>{
 const pool={query:async(sql)=>{
  if(sql.includes('FROM stripe_webhook_events')&&sql.includes('ORDER BY'))
   return {rows:[]};
  if(sql.includes('pending_payment_receipts')&&sql.includes('AS pending_payment_receipts'))
   return {rows:[{
    pending_payment_receipts:'0',
    pending_refund_or_dispute_events:'0',
    suspect_captured_orders:'0',
    stuck_provider_reservations:'0',
   }]};
  throw Error('unexpected worker query');
 }};
 const r=await rc8WorkerIteration({},pool,{},20);
 assert.deepEqual(r,{
  checked:0,reconciled:0,held:0,pendingPaymentEvents:0,
  pendingRefundOrDisputeEvents:0,orphanedProviderReservations:0,
  suspectPaidOrders:0,releaseHold:true,
 });
});
test('RC8 finance worker reports PG refund/dispute HOLD and unreachable provider',async()=>{
 const pool={query:async(sql)=>{
  if(sql.includes('FROM stripe_webhook_events')&&sql.includes('ORDER BY')){
   if(sql.includes('refund.created'))return {rows:[]};
   assert.doesNotMatch(sql,/charge\.dispute\.created/);
   assert.doesNotMatch(sql,/refund\.updated/);
   return {rows:[{id:'evt_QUEUED_PAY'}]};
  }
  if(sql.includes('SELECT type,"objectId","stripeAccountId"'))
    return {rows:[{type:'payment_intent.succeeded',
      objectId:'pi_TEST',stripeAccountId:null}]};
  if(sql.includes('pending_payment_receipts'))return {rows:[{
   pending_payment_receipts:'1',pending_refund_or_dispute_events:'2',
   suspect_captured_orders:'0',stuck_provider_reservations:'1',
  }]};
  throw Error('unexpected worker query');
 }};
 const provider={events:{retrieve:async()=>{
  throw Error('provider unavailable');
 }}};
 const result=await rc8WorkerIteration(provider,pool,{},20);
 assert.equal(result.checked,1);
 assert.equal(result.held,1);
 assert.equal(result.pendingRefundOrDisputeEvents,2);
 assert.equal(result.pendingPaymentEvents,1);
 assert.equal(result.orphanedProviderReservations,1);
 assert.equal(result.releaseHold,true);
});
