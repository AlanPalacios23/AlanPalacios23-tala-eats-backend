import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRecordedLiveRefundFailure} from '../dist/live/refund-failure-reconciliation.js';
import {LiveGateError} from '../dist/live/guard.js';
const eventId='evt_RF11';
function fixture({refundStatus='failed',remoteEvent=eventId,hadDebit=true,refundAmount=500}={}){
 const refund={id:'re_RF11',status:refundStatus,amount:refundAmount,currency:'mxn',
  payment_intent:'pi_RF11'};
 const evt={id:remoteEvent,type:'refund.failed',livemode:true,
  data:{object:{object:'refund',id:'re_RF11'}}};
 const pi={id:'pi_RF11',livemode:true,amount:1200,amount_received:1200,
  currency:'mxn',status:'succeeded',metadata:{
   tala_mode:'rc8_live_pickup',order_id:'17',buyer_id:'27'}};
 let total='5.00',status='partially_refunded',receiptStatus='RECEIVED';
 let credited=0,commits=0,rollbacks=0,outbox=0,orderEvents=0;
 let reversal=null;
 const client={query:async(sql,params=[])=>{
  if(sql==='BEGIN')return {};
  if(sql==='ROLLBACK'){rollbacks++;return {};}
  if(sql==='COMMIT'){commits++;return {};}
  if(sql.includes('FROM stripe_webhook_events')&&sql.includes('FOR UPDATE'))
   return {rows:[{type:'refund.failed',objectId:'re_RF11',status:receiptStatus}]};
  if(sql.includes('FROM orders WHERE id=$1 FOR UPDATE'))return {rows:[{
   id:17,user_id:27,restaurant_id:37,total:'12.00',refunded_amount:total,
   payment_provider_id:'pi_RF11',payment_method:'stripe',
   payment_provider:'stripe',payment_status:status}]};
  if(sql.includes("kind='stripe_live_refund'")&&sql.includes('FOR UPDATE'))
   return {rows:hadDebit?[{order_id:17,amount:'5.00'}]:[]};
  if(sql.includes('WHERE idempotency_key=$1 FOR UPDATE'))
   return {rows:reversal?[reversal]:[]};
  if(sql.includes('INSERT INTO financial_ledger_entries')){
   credited++;reversal={order_id:17,amount:'5.00'};
   return {rowCount:1};
  }
  if(sql.includes('UPDATE orders SET refunded_amount=')){
   total=params[0];status=params[1];return {rowCount:1};
  }
  if(sql.includes('INSERT INTO event_outbox')){outbox++;return {rowCount:1};}
  if(sql.includes('INSERT INTO order_events')){orderEvents++;return {rowCount:1};}
  if(sql.includes('UPDATE stripe_webhook_events')){
   receiptStatus='PROCESSED';return {rowCount:1};
  }
  throw Error('unexpected SQL: '+sql.slice(0,100));
 },release:()=>{}};
 const pool={query:async sql=>{
  if(sql.includes('FROM stripe_webhook_events'))
   return {rows:[{type:'refund.failed',objectId:'re_RF11',stripeAccountId:null}]};
  throw Error('unexpected outer SQL');
 },connect:async()=>client};
 const provider={events:{retrieve:async()=>evt},refunds:{retrieve:async()=>refund},
   paymentIntents:{retrieve:async()=>pi}};
 return {provider,pool,counts:()=>({credited,commits,rollbacks,
  outbox,orderEvents,total,status,receiptStatus})};
}
test('Stripe confirmed refund failure reverses previously refunded balance exactly once',async()=>{
 const f=fixture();
 const r=await reconcileRecordedLiveRefundFailure(eventId,f.provider,f.pool);
 assert.deepEqual(r,{received:true,alreadyProcessed:false,manualReviewRequired:true});
 assert.deepEqual(f.counts(),{credited:1,commits:1,rollbacks:0,outbox:1,
  orderEvents:1,total:'0.00',status:'paid',receiptStatus:'PROCESSED'});
 const repeated=await reconcileRecordedLiveRefundFailure(eventId,f.provider,f.pool);
 assert.equal(repeated.alreadyProcessed,true);
 assert.equal(f.counts().credited,1);
 assert.equal(f.counts().outbox,1);
});
test('unconfirmed refund failure or invalid Stripe event never changes ledger',async()=>{
 for(const props of [
  {refundStatus:'succeeded'},
  {refundStatus:'pending'},
  {remoteEvent:'evt_IMPERSONATOR'},
  {refundAmount:1300},
 ]){
  const f=fixture(props);
  await assert.rejects(()=>reconcileRecordedLiveRefundFailure(eventId,f.provider,f.pool),
   LiveGateError);
  assert.equal(f.counts().credited,0);
  assert.equal(f.counts().commits,0);
 }
});
test('missing original refund debit holds failed Stripe refund rather than inventing money',async()=>{
 const f=fixture({hadDebit:false});
 await assert.rejects(()=>reconcileRecordedLiveRefundFailure(eventId,f.provider,f.pool),
  LiveGateError);
 assert.equal(f.counts().rollbacks,1);
 assert.equal(f.counts().credited,0);
});
