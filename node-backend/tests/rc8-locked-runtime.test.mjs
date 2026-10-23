import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createLockedRc8Server,startLockedRc8Probe}
 from '../dist/live/server.js';

test('RC8 isolated preproduction probe does not permit live money writes',async()=>{
 const server=createLockedRc8Server();
 server.listen(0,'127.0.0.1');
 try{
  await once(server,'listening');
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const base='http://127.0.0.1:'+address.port;
  const health=await fetch(base+'/api/v1/health');
  assert.equal(health.status,200);
  const state=await health.json();
  assert.equal(state.checkoutEnabled,false);
  assert.equal(state.transfersEnabled,false);
  assert.equal(state.productionReady,false);
  const ready=await fetch(base+'/api/v1/ready');
  assert.equal(ready.status,503);
  assert.equal((await ready.json()).ready,false);
  for(const path of ['/api/v1/orders/12/stripe/payment-intent',
    '/api/v1/payments/refund','/api/v1/transfers',
    '/api/v1/webhooks/stripe']){
   const result=await fetch(base+path,{method:'POST'});
   assert.equal(result.status,503,path);
   assert.equal((await result.json()).error,'RC8_FINANCIAL_OPERATIONS_DISABLED');
  }
 }finally{
  await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
 }
});
test('locked runtime refuses stage and money-moving environment flags',()=>{
 const base={NODE_ENV:'production',RC8_LIVE_CHARGES_ENABLED:'false',
  RC8_LIVE_TRANSFERS_ENABLED:'false',RC8_LIVE_REFUNDS_ENABLED:'false'};
 for(const patch of [
  {NODE_ENV:'staging'},{RC8_LIVE_CHARGES_ENABLED:'true'},
  {RC8_LIVE_TRANSFERS_ENABLED:'true'},
  {RC8_LIVE_REFUNDS_ENABLED:'true'},
  {RC8_LIVE_CHARGES_ENABLED:undefined}
 ]){
  assert.throws(()=>startLockedRc8Probe({...base,...patch}),
    /MONEY_WRITES_DISABLED/);
 }
});
