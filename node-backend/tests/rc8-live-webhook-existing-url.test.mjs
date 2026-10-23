import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {buildIsolatedLiveApp} from '../dist/live/isolated-app.js';

test('existing Stripe LIVE webhook destination and canonical path use signed raw body',async()=>{
 let verified=0,persisted=0;
 const deps={
  authSecret:'s'.repeat(64),checkoutApproved:false,
  settings:{webhookSecret:'whsec_dummy',maxOrderMinor:5000,refundsEnabled:false},
  stripe:{webhooks:{constructEvent:(body,signature,secret)=>{
    verified++;
    assert.ok(Buffer.isBuffer(body));
    assert.equal(signature,'t=123,v1=signed');
    assert.equal(secret,'whsec_dummy');
    return {id:'evt_LiveAlias123',type:'payment_intent.succeeded',
      livemode:true,data:{object:{id:'pi_LiveAlias123',object:'payment_intent'}}};
  }},paymentIntents:{},events:{}},
  pool:{query:async(_sql,params)=>{
    persisted++;
    assert.deepEqual(params,['evt_LiveAlias123','payment_intent.succeeded','pi_LiveAlias123']);
    return {rowCount:1,rows:[{status:'RECEIVED'}]};
  }},
  redis:{eval:async()=>{throw Error('unexpected Redis');}}
 };
 const app=buildIsolatedLiveApp(deps);
 const server=app.listen(0,'127.0.0.1');
 await once(server,'listening');
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const endpoints=['/api/v1/webhooks/stripe','/api/v1/payments/stripe/webhook'];
  for(const endpoint of endpoints){
   const denied=await fetch(base+endpoint,{method:'POST',
     headers:{'Content-Type':'application/json'},body:'{}'});
   assert.equal(denied.status,400);
   const accepted=await fetch(base+endpoint,{method:'POST',
     headers:{'Content-Type':'application/json','Stripe-Signature':'t=123,v1=signed'},
     body:'{}'});
   assert.equal(accepted.status,200);
   assert.deepEqual(await accepted.json(),{received:true,queued:true});
  }
  assert.equal(verified,2);
  assert.equal(persisted,2);
 }finally{
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 }
});
