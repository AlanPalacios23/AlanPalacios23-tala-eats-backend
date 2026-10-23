import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRecordedLiveRefund} from '../dist/live/refund-reconciliation.js';
import {LiveGateError} from '../dist/live/guard.js';

function fixture({status='succeeded',amount=500,livemode=true,remoteId='evt_REFUND123'}={}){
 const event={id:remoteId,type:'refund.updated',livemode,
  data:{object:{object:'refund',id:'re_REFUND123'}}};
 const refund={id:'re_REFUND123',livemode,status,amount,currency:'mxn',
  payment_intent:'pi_PAID123'};
 const pi={id:'pi_PAID123',livemode:true,currency:'mxn',amount:1200,
  amount_received:1200,status:'succeeded',
  metadata:{tala_mode:'rc8_live_pickup',order_id:'12',buyer_id:'21'}};
 let balance='0.00',paymentStatus='paid',receiptStatus='RECEIVED',ledger=null;
 let debits=0,commits=0,rollbacks=0,outbox=0,orderEvents=0;
 const q=async(sql,params=[])=>{
  if(sql==='BEGIN')return {};
  if(sql==='COMMIT'){commits++;return {};}
  if(sql==='ROLLBACK'){rollbacks++;return {};}
  if(sql.includes('FROM stripe_webhook_events')&&sql.includes('FOR UPDATE'))
   return {rows:[{type:event.type,objectId:'re_REFUND123',status:receiptStatus}]};
  if(sql.includes('FROM orders WHERE id=$1 FOR UPDATE'))
   return {rows:[{id:12,user_id:21,restaurant_id:31,total:'12.00',
    refunded_amount:balance,payment_provider_id:'pi_PAID123',
    payment_status:paymentStatus,payment_method:'stripe',payment_provider:'stripe'}]};
  if(sql.includes("kind='stripe_live_payment'"))
   return {rows:[{amount:'12.00'}]};
  if(sql.includes('WHERE idempotency_key=$1 FOR UPDATE'))
   return {rows:ledger?[ledger]:[]};
  if(sql.includes('INSERT INTO financial_ledger_entries')){
   debits++;
   ledger={order_id:12,amount:'5.00'};
   return {rowCount:1};
  }
  if(sql.includes('UPDATE orders SET refunded_amount=')){
   balance=params[0];paymentStatus=params[1];
   return {rowCount:1};
  }
  if(sql.includes('INSERT INTO event_outbox')){outbox++;return {rowCount:1};}
  if(sql.includes('INSERT INTO order_events')){orderEvents++;return {rowCount:1};}
  if(sql.includes('UPDATE stripe_webhook_events')){
   receiptStatus='PROCESSED';return {rowCount:1};
  }
  throw Error('unexpected refund SQL: '+sql.slice(0,80));
 };
 const pool={
  query:async(sql)=> {
   if(sql.includes('FROM stripe_webhook_events'))
    return {rows:[{type:'refund.updated',objectId:'re_REFUND123',stripeAccountId:null}]};
   throw Error('unexpected read');
  },
  connect:async()=>({query:q,release:()=>{}})
 };
 const provider={events:{retrieve:async()=>event},
  refunds:{retrieve:async()=>refund},paymentIntents:{retrieve:async()=>pi}};
 return {pool,provider,counts:()=>({debits,commits,rollbacks,outbox,
  orderEvents,balance,paymentStatus,receiptStatus})};
}

test('confirmed LIVE refund posts exactly once and holds payouts and inventory',async()=>{
 const x=fixture();
 const first=await reconcileRecordedLiveRefund('evt_REFUND123',x.provider,x.pool);
 assert.deepEqual(first,{received:true,alreadyProcessed:false,manualReviewRequired:true});
 assert.deepEqual(x.counts(),{debits:1,commits:1,rollbacks:0,outbox:1,
  orderEvents:1,balance:'5.00',paymentStatus:'partially_refunded',
  receiptStatus:'PROCESSED'});
 const second=await reconcileRecordedLiveRefund('evt_REFUND123',x.provider,x.pool);
 assert.equal(second.alreadyProcessed,true);
 assert.equal(x.counts().debits,1);
 assert.equal(x.counts().outbox,1);
});
test('pending/failed refunds cannot debit customer order ledger',async()=>{
 for(const status of ['pending','failed','requires_action','canceled']){
  const x=fixture({status});
  await assert.rejects(
   ()=>reconcileRecordedLiveRefund('evt_REFUND123',x.provider,x.pool),
   LiveGateError);
  assert.equal(x.counts().debits,0);
  assert.equal(x.counts().commits,0);
 }
});
test('wrong remote Stripe event identity fails before PostgreSQL mutations',async()=>{
 const x=fixture({remoteId:'evt_SPOOFED'});
 await assert.rejects(
  ()=>reconcileRecordedLiveRefund('evt_REFUND123',x.provider,x.pool),
  LiveGateError);
 assert.equal(x.counts().debits,0);
});
test('refund larger than captured charge is not recorded',async()=>{
 const x=fixture({amount:1300});
 await assert.rejects(
  ()=>reconcileRecordedLiveRefund('evt_REFUND123',x.provider,x.pool),
  LiveGateError);
 assert.equal(x.counts().debits,0);
});
