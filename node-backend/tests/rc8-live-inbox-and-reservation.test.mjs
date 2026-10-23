import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateLiveSettings,LiveGateError} from '../dist/live/guard.js';
import {PostgresLivePaymentStore} from '../dist/live/postgres-store.js';
import {ingestSignedLiveStripeWebhook,drainLiveSignedReceipts}
 from '../dist/live/webhook-inbox.js';
import {reconcileRecordedLiveStripeEvent}
 from '../dist/live/reconcile.js';

const settings=()=>validateLiveSettings({
  nodeEnv:'production',explicitlyEnabled:'true',readinessApproved:'true',
  key:'rk_live_'+'A'.repeat(20),publishableKey:'pk_live_'+'B'.repeat(20),
  webhookSecret:'whsec_'+'C'.repeat(20),
  databaseUrl:'postgresql://app:secret@127.0.0.1:15445/tala_live',
  redisUrl:'redis://:secret@127.0.0.1:16389/1',
  refundsEnabled:'false',transfersEnabled:'false',maxOrderMinor:'5000',
});
const baseOrder=()=>({
  id:11,user_id:22,status:'awaiting_payment',payment_status:'pending',
  payment_method:'stripe',payment_provider:'stripe',payment_provider_id:'',
  order_type:'pickup',total:'20.00',created_at:new Date(),refunded_amount:'0.00',
});
const fakePool=(row)=> {
  const queries=[];
  const client={
    query:async(sql,params)=>{
      queries.push({sql,params});
      if(sql.includes('FROM orders WHERE id=$1 AND user_id=$2'))
        return {rows:[row],rowCount:1};
      if(sql.includes('UPDATE orders'))return {rows:[{id:11}],rowCount:1};
      return {rows:[],rowCount:0};
    },
    release:()=>{}
  };
  return {pool:{connect:async()=>client},queries};
};
test('expired and oversized live orders never write a PI reservation',async()=>{
  for(const patch of [
    {total:'51.00'},
    {created_at:new Date(Date.now()-31*60_000)},
    {total:'999999999.99'},
    {payment_provider_id:'invalid'},
    {created_at:new Date(Date.now()+5*60_000)},
  ]){
    const {pool,queries}=fakePool({...baseOrder(),...patch});
    await assert.rejects(
      ()=>new PostgresLivePaymentStore(pool).reserveForPayment(11,22,5000),
      LiveGateError);
    assert.equal(queries.some(q=>q.sql.includes('UPDATE orders')),false,
      JSON.stringify(patch));
  }
});
test('valid live order reserves marker atomically before external API',async()=>{
  const {pool,queries}=fakePool(baseOrder());
  const order=await new PostgresLivePaymentStore(pool).reserveForPayment(11,22,5000);
  assert.equal(order.intentId,'pi_reserving_rc8_live');
  assert.equal(order.amountMinor,2000);
  assert.ok(queries.find(q=>q.sql.includes('UPDATE orders')&&
    q.params[0]==='pi_reserving_rc8_live'));
  assert.equal(queries.at(-1).sql,'COMMIT');
});
test('LIVE webhook persists signed identity before acknowledging and catches conflicts',async()=>{
  let event={id:'evt_ABC123',livemode:true,type:'payment_intent.succeeded',
    account:undefined,data:{object:{object:'payment_intent',id:'pi_ABC123'}}};
  const provider={webhooks:{constructEvent:()=>event}};
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rowCount:1,rows:[{status:'RECEIVED'}]};
  }};
  const result=await ingestSignedLiveStripeWebhook(
    Buffer.from('payload'),'sig',provider,pool,settings());
  assert.deepEqual(result,{received:true,queued:true});
  assert.match(calls[0].sql,/ON CONFLICT \(id\)/);
  assert.match(calls[0].sql,/stripe_webhook_events\.object_id=EXCLUDED\.object_id/);
  assert.deepEqual(calls[0].params,['evt_ABC123','payment_intent.succeeded','pi_ABC123']);

  pool.query=async()=>({rowCount:0,rows:[]});
  await assert.rejects(()=>ingestSignedLiveStripeWebhook(
    Buffer.from('payload'),'sig',provider,pool,settings()),LiveGateError);

  event={...event,livemode:false};
  await assert.rejects(()=>ingestSignedLiveStripeWebhook(
    Buffer.from('payload'),'sig',provider,pool,settings()),LiveGateError);
});
test('already PROCESSED webhook needs no new worker job',async()=>{
  const event={id:'evt_X123',livemode:true,
    type:'payment_intent.succeeded',data:{object:{object:'payment_intent',id:'pi_AAAA'}}};
  const provider={webhooks:{constructEvent:()=>event}};
  const pool={query:async()=>({rowCount:1,rows:[{status:'PROCESSED'}]})};
  const r=await ingestSignedLiveStripeWebhook(
    Buffer.from('payload'),'sig',provider,pool,settings());
  assert.equal(r.queued,false);
});
test('worker sweep leaves failed receipt queued for retry and limits batch',async()=>{
  const pool={query:async()=>({rows:[{id:'evt_A1'}]})};
  const provider={events:{retrieve:async()=>{throw Error('stripe temporarily unavailable');}}};
  const result=await drainLiveSignedReceipts(provider,pool,settings());
  assert.deepEqual(result,{checked:1,reconciled:0,held:1});
  await assert.rejects(()=>drainLiveSignedReceipts(provider,pool,settings(),51),LiveGateError);
});
test('worker cannot reconcile event absent from signed durable inbox',async()=>{
  const pool={query:async()=>({rows:[]})};
  const provider={events:{retrieve:async()=>{throw Error('must never fetch');}}};
  await assert.rejects(
    ()=>reconcileRecordedLiveStripeEvent('evt_MISSING',provider,pool,settings()),
    LiveGateError);
});
