import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRecordedLiveStripeEvent} from '../dist/live/reconcile.js';
import {validateLiveSettings,LiveGateError} from '../dist/live/guard.js';

const settings=validateLiveSettings({
  nodeEnv:'production',explicitlyEnabled:'true',readinessApproved:'true',
  key:'rk_live_'+'A'.repeat(20),publishableKey:'pk_live_'+'B'.repeat(20),
  webhookSecret:'whsec_'+'C'.repeat(20),
  databaseUrl:'postgresql://app:secret@127.0.0.1:15445/tala_live',
  redisUrl:'redis://:secret@127.0.0.1:16389/1',
  refundsEnabled:'false',transfersEnabled:'false',maxOrderMinor:'5000',
});
const eid='evt_PAID31',piid='pi_PAID31';
function fixture({
  mode='rc8_live_pickup',piPointer='pi_reserving_rc8_live',
  stripeSucceeded=true,receiptExists=true
}={}){
  const event={id:eid,type:'payment_intent.succeeded',livemode:true,
    data:{object:{object:'payment_intent',id:piid}}};
  const pi={id:piid,livemode:true,currency:'mxn',amount:1250,
    amount_received:stripeSucceeded?1250:0,
    status:stripeSucceeded?'succeeded':'processing',
    metadata:{tala_mode:mode,order_id:'31',buyer_id:'42'}};
  const order={
    id:31,user_id:42,restaurant_id:51,total:'12.50',
    status:'awaiting_payment',payment_status:'pending',payment_method:'stripe',
    payment_provider:'stripe',payment_provider_id:piPointer,
    order_type:'pickup',refunded_amount:'0.00',
    restaurant_payout:'10.00',platform_revenue:'2.50',
    payment_processing_fee:'0.25',contribution_margin:'2.25',
  };
  const receipt={type:event.type,objectId:piid,
    stripeAccountId:null,status:'RECEIVED'};
  const entries=[],events=[],orderEvents=[],queries=[];
  let committed=0,rolledBack=0;
  const query=async(sql,params=[])=>{
    queries.push({sql,params});
    if(sql==='BEGIN')return {rows:[],rowCount:null};
    if(sql==='COMMIT'){committed++;return {rows:[],rowCount:null};}
    if(sql==='ROLLBACK'){rolledBack++;return {rows:[],rowCount:null};}
    if(sql.includes('INSERT INTO stripe_webhook_events'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT type,"objectId",status FROM stripe_webhook_events'))
      return {rows:[receipt],rowCount:1};
    if(sql.includes('SELECT id,user_id,restaurant_id,total::text,status'))
      return {rows:[order],rowCount:1};
    if(sql.includes('UPDATE orders SET payment_provider_id=')){
      if(order.payment_provider_id!=='pi_reserving_rc8_live')
        return {rows:[],rowCount:0};
      order.payment_provider_id=params[0];
      return {rows:[{id:31}],rowCount:1};
    }
    if(sql.includes('SELECT id FROM financial_ledger_entries')&&
       sql.includes("kind='order_settlement'"))
      return {rows:entries.filter(e=>e.kind==='order_settlement'),rowCount:0};
    if(sql.includes('UPDATE orders SET payment_status=')){
      order.payment_status='paid';order.status='received';
      return {rows:[{id:31}],rowCount:1};
    }
    if(sql.includes('INSERT INTO financial_ledger_entries')){
      const live=sql.includes("'stripe_live_payment'");
      entries.push({kind:live?'stripe_live_payment':'order_settlement',
        amount:live?params[3]:params[5],key:params.at(-1)});
      return {rows:[],rowCount:1};
    }
    if(sql.includes('INSERT INTO event_outbox')){
      events.push(params[2]);return {rows:[],rowCount:1};
    }
    if(sql.includes('INSERT INTO order_events')){
      orderEvents.push(params[2]);return {rows:[],rowCount:1};
    }
    if(sql.includes('INSERT INTO notifications'))return {rows:[],rowCount:1};
    if(sql.includes('UPDATE stripe_webhook_events')){
      receipt.status='PROCESSED';return {rows:[],rowCount:1};
    }
    if(sql.includes('SELECT id,amount::text AS amount FROM financial_ledger_entries'))
      return {rows:[{id:5,amount:'12.50'}],rowCount:1};
    throw Error('unmocked SQL statement: '+sql.slice(0,90));
  };
  const pool={
    query:async(sql)=>{
      if(sql.includes('SELECT type,"objectId","stripeAccountId"')){
        return {rows:receiptExists?[receipt]:[],rowCount:receiptExists?1:0};
      }
      throw Error('unexpected outside-transaction SQL');
    },
    connect:async()=>({query,release:()=>{}})
  };
  const stripe={events:{retrieve:async()=>event},
    paymentIntents:{retrieve:async()=>pi}};
  return {pool,stripe,order,receipt,entries,events,orderEvents,queries,
    counts:()=>({committed,rolledBack})};
}
test('signed stored charge recovers lost PI pointer and commits ledger/outbox only once',async()=>{
  const x=fixture();
  const r=await reconcileRecordedLiveStripeEvent(eid,x.stripe,x.pool,settings);
  assert.deepEqual(r,{received:true,alreadyProcessed:false});
  assert.equal(x.order.payment_provider_id,piid);
  assert.equal(x.order.payment_status,'paid');
  assert.equal(x.order.status,'received');
  assert.equal(x.receipt.status,'PROCESSED');
  assert.equal(x.entries.length,6);
  assert.ok(x.entries.some(l=>l.kind==='stripe_live_payment'&&l.amount==='12.50'));
  assert.deepEqual(x.events,['order.created','order.paid']);
  assert.equal(x.orderEvents.length,1);
  assert.deepEqual(x.counts(),{committed:1,rolledBack:0});
  const again=await reconcileRecordedLiveStripeEvent(eid,x.stripe,x.pool,settings);
  assert.deepEqual(again,{received:true,alreadyProcessed:true});
  assert.equal(x.entries.length,6);
  assert.equal(x.events.length,2);
  assert.deepEqual(x.counts(),{committed:2,rolledBack:0});
});
test('unconfirmed charge cannot mark order paid and transaction rolls back',async()=>{
  const x=fixture({stripeSucceeded:false});
  await assert.rejects(
    ()=>reconcileRecordedLiveStripeEvent(eid,x.stripe,x.pool,settings),
    LiveGateError);
  assert.equal(x.order.payment_status,'pending');
  assert.equal(x.entries.length,0);
  assert.equal(x.events.length,0);
  assert.equal(x.counts().committed,0);
  assert.equal(x.counts().rolledBack,1);
});
test('wrong payment mode and missing signed receipt cannot confirm money',async()=>{
  const x=fixture({mode:'rc7_test_pickup'});
  await assert.rejects(
    ()=>reconcileRecordedLiveStripeEvent(eid,x.stripe,x.pool,settings),
    LiveGateError);
  assert.equal(x.entries.length,0);
  const y=fixture({receiptExists:false});
  await assert.rejects(
    ()=>reconcileRecordedLiveStripeEvent(eid,y.stripe,y.pool,settings),
    LiveGateError);
  assert.equal(y.queries.length,0);
});
