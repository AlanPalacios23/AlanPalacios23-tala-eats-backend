import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import express from 'express';
import {buildIsolatedWebhookRouter} from '../dist/live/webhook-router.js';

async function mount(provider,pool){
 const app=express();
 app.use('/api/v1/webhooks',buildIsolatedWebhookRouter(provider,pool,{
   webhookSecret:'whsec_dummy',maxOrderMinor:5000
 }));
 // JSON parser deliberately later, proving raw-body signature ordering.
 app.use(express.json());
 const server=app.listen(0,'127.0.0.1');
 await once(server,'listening');
 const a=server.address();
 const url='http://127.0.0.1:'+a.port+'/api/v1/webhooks/stripe';
 return {server,url};
}
const close=x=>new Promise((resolve,reject)=>x.server.close(e=>e?reject(e):resolve()));
const makeEvent=()=>({id:'evt_SIGNED77',livemode:true,
 type:'payment_intent.succeeded',account:undefined,
 data:{object:{object:'payment_intent',id:'pi_SIGNED77'}}});
test('webhook does not acknowledge absent signature',async()=>{
 const x=await mount({webhooks:{constructEvent:()=>{throw Error('must not be called');}}},{
   query:async()=>{throw Error('must not persist');}
 });
 try{
  const r=await fetch(x.url,{method:'POST',
   headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,400);
 }finally{await close(x);}
});
test('verified live event is ACKed only after PG insert',async()=>{
 let signed=0,persisted=0;
 const x=await mount({webhooks:{constructEvent:(raw,sig,secret)=>{
  signed++;assert.ok(Buffer.isBuffer(raw));
  assert.equal(sig,'t=abc,v1=xyz');
  assert.equal(secret,'whsec_dummy');
  return makeEvent();
 }}},{query:async(sql,params)=>{
  persisted++;assert.match(sql,/"stripeAccountId"/);
  assert.match(sql,/"objectId"/);
  assert.deepEqual(params,['evt_SIGNED77','payment_intent.succeeded','pi_SIGNED77']);
  return {rowCount:1,rows:[{status:'RECEIVED'}]};
 }});
 try{
  const r=await fetch(x.url,{method:'POST',
   headers:{'Content-Type':'application/json','Stripe-Signature':'t=abc,v1=xyz'},
   body:JSON.stringify({type:'not-trusted-unless-signed'})});
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{received:true,queued:true});
  assert.equal(signed,1);assert.equal(persisted,1);
 }finally{await close(x);}
});
test('if PG durable receipt fails, Stripe gets 503 and must retry',async()=>{
 const x=await mount({webhooks:{constructEvent:()=>makeEvent()}},{
  query:async()=>{throw Error('PG unavailable');}
 });
 try{
  const r=await fetch(x.url,{method:'POST',
   headers:{'Content-Type':'application/json','Stripe-Signature':'sig'},
   body:'{}'});
  assert.equal(r.status,503);
  assert.deepEqual(await r.json(),{error:'WEBHOOK_DURABLE_STORAGE_UNAVAILABLE'});
 }finally{await close(x);}
});
