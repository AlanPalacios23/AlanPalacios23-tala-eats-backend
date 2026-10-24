import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import express from 'express';
import {buildIsolatedCheckoutRouter} from '../dist/live/checkout-router.js';
import {signAccessToken,sha256Hex} from '../dist/auth/crypto.js';

const secret='z'.repeat(64);
async function appServer(enabled,sessionValid=true,rate=1,financeHold=false){
 const claimsToken=signAccessToken(51,'customer',secret);
 const queries=[];let providerCalls=0;
 const pool={
   query:async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes('FROM device_sessions')){
      assert.equal(params[0],sha256Hex(claimsToken));
      return {rows:sessionValid?[{id:51,role:'customer',active:true,is_active:true}]:[]};
    }
    if(sql.includes('AS pending_payment_receipts')) return {rows:[{
      pending_payment_receipts:'0',
      pending_refund_or_dispute_events:financeHold?'1':'0',
      suspect_captured_orders:'0',
      stuck_provider_reservations:'0',
    }]};
    throw Error('Unexpected SQL');
   },
   connect:async()=>{
    throw Error('Order lookup is intentionally unavailable in this test');
   }
 };
 const stripe={
   paymentIntents:{create:async()=>{providerCalls++;throw Error('no card calls');}},
   webhooks:{},events:{}
 };
 const gate={enabled,authSecret:secret,pool,
  stripe,redis:{eval:async()=>rate},
  settings:{maxOrderMinor:5000,publishableKey:'pk_dummy'}};
 const app=express();
 app.use('/api/v1',buildIsolatedCheckoutRouter(gate));
 const server=app.listen(0,'127.0.0.1');
 await once(server,'listening');
 const address=server.address();
 const origin='http://127.0.0.1:'+address.port;
 return {origin,server,claimsToken,queries,providerCalls:()=>providerCalls};
}
const close=x=>new Promise((resolve,reject)=>x.server.close(e=>e?reject(e):resolve()));
test('checkout router disabled by default even for signed customer session',async()=>{
 const x=await appServer(false);
 try{
  const r=await fetch(x.origin+'/api/v1/orders/77/stripe/payment-intent',{
   method:'POST',headers:{Authorization:'Bearer '+x.claimsToken}
  });
  assert.equal(r.status,503);
  assert.deepEqual(await r.json(),{error:'LIVE_PILOT_NOT_APPROVED'});
  assert.equal(x.providerCalls(),0);
  assert.equal(x.queries.length,0);
 }finally{await close(x);}
});
test('checkout router rejects unauthenticated, malformed and revoked users',async()=>{
 const x=await appServer(true,false);
 try{
  const endpoint=x.origin+'/api/v1/orders/77/stripe/payment-intent';
  const a=await fetch(endpoint,{method:'POST'});
  assert.equal(a.status,401);
  const b=await fetch(x.origin+'/api/v1/orders/xyz/stripe/payment-intent',{
   method:'POST',headers:{Authorization:'Bearer '+x.claimsToken}});
  assert.equal(b.status,422);
  const c=await fetch(endpoint,{method:'POST',
   headers:{Authorization:'Bearer '+x.claimsToken}});
  assert.equal(c.status,401);
  assert.equal(x.providerCalls(),0);
 }finally{await close(x);}
});
test('checkout router rate limit fails closed before Stripe API',async()=>{
 const x=await appServer(true,true,9);
 try{
  const r=await fetch(x.origin+'/api/v1/orders/77/stripe/payment-intent',{
   method:'POST',headers:{Authorization:'Bearer '+x.claimsToken}
  });
  assert.equal(r.status,429);
  assert.equal(x.providerCalls(),0);
 }finally{await close(x);}
});

test('checkout refuses a LIVE charge when DB financial audit is on HOLD',async()=>{
 const x=await appServer(true,true,1,true);
 try{
  const r=await fetch(x.origin+'/api/v1/orders/77/stripe/payment-intent',{
   method:'POST',headers:{Authorization:'Bearer '+x.claimsToken}
  });
  assert.equal(r.status,503);
  assert.deepEqual(await r.json(),{error:'LIVE_FINANCIAL_RECONCILIATION_HOLD'});
  assert.equal(x.providerCalls(),0);
  assert.ok(x.queries.some(q=>q.sql.includes('AS pending_payment_receipts')));
 }finally{await close(x);}
});
