import test from 'node:test';
import assert from 'node:assert/strict';
import {holdRecordedLiveDispute} from '../dist/live/dispute-reconciliation.js';
import {LiveGateError} from '../dist/live/guard.js';

function fixture({chargeLive=true,wrongEvent=false,wrongOrder=false,refundOnly=false,eventType='charge.dispute.created'}={}){
 const eventId='evt_DISPUTE11',disputeId='dp_DISPUTE11';
 const event={id:wrongEvent?'evt_OTHER':eventId,type:eventType,
  livemode:true,account:undefined,
  data:{object:{object:'dispute',id:disputeId}}};
 const dispute={id:disputeId,charge:'ch_DISPUTE11',amount:800,
  currency:'mxn',status:'needs_response'};
 const charge={id:'ch_DISPUTE11',livemode:chargeLive,paid:true,
  amount:1250,currency:'mxn',payment_intent:'pi_DISPUTE11'};
 const pi={id:'pi_DISPUTE11',livemode:true,currency:'mxn',
  amount:1250,amount_received:1250,status:'succeeded',
  metadata:{tala_mode:'rc8_live_pickup',order_id:'31',buyer_id:'42'}};
 let commits=0,rollbacks=0,outbox=0,orderEvents=0,receipts=0;
 let receipt='RECEIVED';
 const pool={
  query:async sql=>{
   if(sql.includes('FROM stripe_webhook_events'))
    return {rows:[{type:event.type,objectId:disputeId,stripeAccountId:null}]};
   throw Error('unexpected outside transaction');
  },
  connect:async()=>({
   release:()=>{},
   query:async(sql,params=[])=>{
    if(sql==='BEGIN')return {};
    if(sql==='ROLLBACK'){rollbacks++;return {};}
    if(sql==='COMMIT'){commits++;return {};}
    if(sql.includes('FROM stripe_webhook_events')&&sql.includes('FOR UPDATE'))
      return {rows:[{type:event.type,objectId:disputeId,status:receipt}]};
    if(sql.includes('FROM orders WHERE id=$1 FOR UPDATE'))return {rows:[{
     id:31,user_id:wrongOrder?99:42,restaurant_id:51,total:'12.50',
     payment_method:'stripe',payment_provider:'stripe',
     payment_provider_id:'pi_DISPUTE11',
     payment_status:refundOnly?'pending':'paid'}]};
    if(sql.includes("kind='stripe_live_payment'"))
      return {rows:[{amount:'12.50'}]};
    if(sql.includes('INSERT INTO event_outbox')){
      outbox++;
      assert.match(sql,/order\.dispute_review_required/);
      assert.match(JSON.stringify(params),/manual_review_required/);
      return {rowCount:1};
    }
    if(sql.includes('INSERT INTO order_events')){
      orderEvents++;
      return {rowCount:1};
    }
    if(sql.includes('UPDATE stripe_webhook_events')){
      receipts++;
      receipt='PROCESSED';
      return {rowCount:1};
    }
    throw Error('unmocked query: '+sql.slice(0,100));
   }
  })
 };
 const provider={
  events:{retrieve:async()=>event},
  disputes:{retrieve:async()=>dispute},
  charges:{retrieve:async()=>charge},
  paymentIntents:{retrieve:async()=>pi},
 };
 return {provider,pool,counts:()=>({commits,rollbacks,outbox,orderEvents,receipts})};
}
test('verified Stripe LIVE dispute creates durable manual review hold once',async()=>{
 const f=fixture();
 const first=await holdRecordedLiveDispute('evt_DISPUTE11',f.provider,f.pool);
 assert.deepEqual(first,{received:true,alreadyProcessed:false,manualReviewRequired:true});
 assert.deepEqual(f.counts(),{commits:1,rollbacks:0,outbox:1,orderEvents:1,receipts:1});
 const replay=await holdRecordedLiveDispute('evt_DISPUTE11',f.provider,f.pool);
 assert.equal(replay.alreadyProcessed,true);
 assert.equal(f.counts().outbox,1);
});
test('invalid event, test charge and unmatched order never register review',async()=>{
 for(const patch of [{wrongEvent:true},{chargeLive:false},
    {wrongOrder:true},{refundOnly:true}]){
  const f=fixture(patch);
  await assert.rejects(
   ()=>holdRecordedLiveDispute('evt_DISPUTE11',f.provider,f.pool),
   LiveGateError);
  assert.equal(f.counts().outbox,0);
  assert.equal(f.counts().receipts,0);
 }
});


test('Stripe signed dispute closure remains on explicit manual payout HOLD',async()=>{
 const f=fixture({eventType:'charge.dispute.closed'});
 const r=await holdRecordedLiveDispute('evt_DISPUTE11',f.provider,f.pool);
 assert.equal(r.manualReviewRequired,true);
 assert.equal(f.counts().outbox,1);
 assert.equal(f.counts().commits,1);
});
