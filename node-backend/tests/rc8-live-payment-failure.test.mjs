import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRecordedLivePaymentFailure} from '../dist/live/payment-failure-reconciliation.js';
import {LiveGateError} from '../dist/live/guard.js';

function setup({eventId='evt_FAIL19',state='requires_payment_method',
  amount=1400,pointer='pi_FAIL19',buyer=23,paymentStatus='pending'}={}){
 const event={id:eventId,type:'payment_intent.payment_failed',
  livemode:true,account:undefined,data:{object:{id:'pi_FAIL19'}}};
 const intent={id:'pi_FAIL19',livemode:true,status:state,
  amount,currency:'mxn',metadata:{tala_mode:'rc8_live_pickup',
   order_id:'13',buyer_id:'23'}};
 let commits=0,rollbacks=0,mutations=0;
 let receipt='RECEIVED';
 const pool={
  query:async sql=>{
   if(sql.includes('FROM stripe_webhook_events'))
    return {rows:[{type:event.type,objectId:'pi_FAIL19',stripeAccountId:null}]};
   throw Error('unexpected outer SQL');
  },
  connect:async()=>({
   release:()=>{},
   query:async(sql,params=[])=>{
    if(sql==='BEGIN')return {};
    if(sql==='COMMIT'){commits++;return {};}
    if(sql==='ROLLBACK'){rollbacks++;return {};}
    if(sql.includes('FROM stripe_webhook_events')&&sql.includes('FOR UPDATE'))
     return {rows:[{type:event.type,objectId:'pi_FAIL19',status:receipt}]};
    if(sql.includes('FROM orders WHERE id=$1 FOR UPDATE'))
     return {rows:[{id:13,user_id:buyer,payment_method:'stripe',
      payment_provider:'stripe',payment_provider_id:pointer,
      total:'14.00',payment_status:paymentStatus}]};
    if(sql.includes('UPDATE stripe_webhook_events')){
     receipt='PROCESSED';mutations++;return {rowCount:1};
    }
    throw Error('unexpected money / inventory mutation: '+sql.slice(0,80));
   }
  })
 };
 const provider={events:{retrieve:async()=>event},
  paymentIntents:{retrieve:async()=>intent}};
 return {pool,provider,counts:()=>({commits,rollbacks,mutations})};
}
test('card decline receipt clears without changes to money or inventory',async()=>{
 const x=setup();
 const first=await reconcileRecordedLivePaymentFailure('evt_FAIL19',x.provider,x.pool);
 assert.deepEqual(first,{received:true,alreadyProcessed:false,charged:false});
 assert.deepEqual(x.counts(),{commits:1,rollbacks:0,mutations:1});
 const replay=await reconcileRecordedLivePaymentFailure('evt_FAIL19',x.provider,x.pool);
 assert.deepEqual(replay,{received:true,alreadyProcessed:true,charged:false});
 assert.equal(x.counts().mutations,1);
});
test('late declined-card event never rolls back an already paid order',async()=>{
 const x=setup({state:'succeeded',paymentStatus:'paid'});
 const r=await reconcileRecordedLivePaymentFailure('evt_FAIL19',x.provider,x.pool);
 assert.equal(r.charged,false);
 assert.equal(x.counts().commits,1);
});
test('unrelated signed event, wrong buyer and changed charge amount fail closed',async()=>{
 for(const opts of [{eventId:'evt_NOTMATCH'},{buyer:99},{amount:1401},{pointer:'pi_UNRELATED'}]){
  const x=setup(opts);
  await assert.rejects(
   ()=>reconcileRecordedLivePaymentFailure('evt_FAIL19',x.provider,x.pool),LiveGateError);
  assert.equal(x.counts().mutations,0);
 }
});
