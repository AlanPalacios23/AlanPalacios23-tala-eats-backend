import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRecordedLiveCanceledIntent} from '../dist/live/cancel-reconciliation.js';
import {LiveGateError} from '../dist/live/guard.js';

const id='evt_CANCEL11',piId='pi_CANCEL11';
function fixture({piStatus='canceled',received=0,ledger=false,menuRestore=true}={}){
 const event={id,livemode:true,type:'payment_intent.canceled',
   data:{object:{object:'payment_intent',id:piId}}};
 const pi={id:piId,livemode:true,status:piStatus,amount_received:received,
   amount:1800,currency:'mxn',metadata:{
     tala_mode:'rc8_live_pickup',order_id:'17',buyer_id:'27'}};
 const order={id:17,user_id:27,restaurant_id:37,status:'awaiting_payment',
   payment_status:'pending',payment_provider_id:piId,payment_method:'stripe',
   payment_provider:'stripe',order_type:'pickup',total:'18.00',
   refunded_amount:'0.00',inventory_restored_at:null,
   inventory_reserved_json:'{"53":"0.500"}'};
 let commits=0,rollbacks=0,menu=0,ingredients=0,orders=0,events=0,outbox=0;
 let receipt='RECEIVED';
 const client={query:async(sql,params=[])=>{
  if(sql==='BEGIN')return {rowCount:null};
  if(sql==='ROLLBACK'){rollbacks++;return {rowCount:null};}
  if(sql==='COMMIT'){commits++;return {rowCount:null};}
  if(sql.includes('FROM stripe_webhook_events')&&sql.includes('FOR UPDATE'))
   return {rows:[{type:'payment_intent.canceled',objectId:piId,status:receipt}]};
  if(sql.includes('FROM orders WHERE id=$1 FOR UPDATE'))return {rows:[order]};
  if(sql.includes('FROM financial_ledger_entries'))
   return {rowCount:ledger?1:0,rows:ledger?[{id:1}]:[]};
  if(sql.includes('FROM order_items'))
   return {rows:[{menu_item_id:42,quantity:2},{menu_item_id:42,quantity:1}]};
  if(sql.includes('UPDATE menu_items')){
   menu++;assert.deepEqual(params,[3,42,37]);
   return {rowCount:menuRestore?1:0};
  }
  if(sql.includes('UPDATE ingredient_stocks')){
   ingredients++;assert.deepEqual(params,['0.500',53,37]);
   return {rowCount:1};
  }
  if(sql.includes("UPDATE orders SET status='cancelled'")){
   orders++;order.status='cancelled';order.payment_status='canceled';
   order.inventory_restored_at=new Date();
   return {rowCount:1};
  }
  if(sql.includes('INSERT INTO order_events')){events++;return {rowCount:1};}
  if(sql.includes('INSERT INTO event_outbox')){outbox++;return {rowCount:1};}
  if(sql.includes('UPDATE stripe_webhook_events')){
   receipt='PROCESSED';return {rowCount:1};
  }
  throw Error('unexpected SQL: '+sql.slice(0,100));
 },release:()=>{}};
 const pool={
  query:async(sql)=>{
   if(sql.includes('FROM stripe_webhook_events'))
    return {rows:[{type:'payment_intent.canceled',
      objectId:piId,stripeAccountId:null}]};
   throw Error('unexpected pool query');
  },connect:async()=>client};
 const provider={events:{retrieve:async()=>event},
   paymentIntents:{retrieve:async()=>pi}};
 return {pool,provider,order,counts:()=>({commits,rollbacks,menu,
  ingredients,orders,events,outbox,receipt})};
}
test('Stripe-confirmed uncaptured cancellation restores pickup stock and commits once',async()=>{
 const f=fixture();
 const first=await reconcileRecordedLiveCanceledIntent(id,f.provider,f.pool);
 assert.deepEqual(first,{received:true,alreadyProcessed:false,stockRestored:true});
 assert.deepEqual(f.counts(),{commits:1,rollbacks:0,menu:1,
  ingredients:1,orders:1,events:1,outbox:1,receipt:'PROCESSED'});
 const second=await reconcileRecordedLiveCanceledIntent(id,f.provider,f.pool);
 assert.deepEqual(second,{received:true,alreadyProcessed:true,stockRestored:false});
 assert.equal(f.counts().menu,1);
 assert.equal(f.counts().orders,1);
});
test('processing, succeeded and any captured LIVE payment never release inventory',async()=>{
 for(const params of [
  {piStatus:'processing',received:0},
  {piStatus:'succeeded',received:1800},
  {piStatus:'canceled',received:1},
 ]){
  const f=fixture(params);
  await assert.rejects(()=>reconcileRecordedLiveCanceledIntent(id,f.provider,f.pool),LiveGateError);
  assert.equal(f.counts().menu,0);
  assert.equal(f.counts().commits,0);
 }
});
test('financial ledger blocks inventory restoration for canceled PI',async()=>{
 const f=fixture({ledger:true});
 await assert.rejects(()=>reconcileRecordedLiveCanceledIntent(id,f.provider,f.pool),LiveGateError);
 assert.equal(f.counts().menu,0);
 assert.equal(f.counts().orders,0);
 assert.equal(f.counts().rollbacks,1);
});
test('failed ingredient or item restoration aborts atomic DB transaction',async()=>{
 const f=fixture({menuRestore:false});
 await assert.rejects(()=>reconcileRecordedLiveCanceledIntent(id,f.provider,f.pool),LiveGateError);
 assert.equal(f.counts().commits,0);
 assert.equal(f.counts().rollbacks,1);
 assert.equal(f.counts().orders,0);
});
