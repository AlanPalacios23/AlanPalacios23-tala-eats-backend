import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {buildIsolatedLiveApp} from '../dist/live/isolated-app.js';

test('isolated RC8 HTTP composition refuses checkout with release off',async()=>{
  let externalPaymentCalls=0;
  const deps={
    authSecret:'s'.repeat(64),checkoutApproved:false,
    settings:{webhookSecret:'whsec_dummy',maxOrderMinor:5000},
    stripe:{webhooks:{constructEvent:()=>{throw Error('signed event required');}},
      paymentIntents:{create:async()=>{externalPaymentCalls++;}},
      events:{}},
    pool:{query:async(sql)=>{
      if(sql==='SELECT 1')return {rows:[{one:1}]};
      if(sql.includes('pending_payment_receipts'))return {rows:[{
        pending_payment_receipts:'0',pending_refund_or_dispute_events:'0',
        suspect_captured_orders:'0',stuck_provider_reservations:'0'
      }]};
      throw Error('unexpected SQL');
    }},
    redis:{eval:async()=>{throw Error('should not access Redis');}}
  };
  const app=buildIsolatedLiveApp(deps);
  const server=app.listen(0,'127.0.0.1');
  try{
    await once(server,'listening');
    const url='http://127.0.0.1:'+server.address().port;
    const health=await fetch(url+'/api/v1/health');
    assert.equal(health.status,200);
    const state=await health.json();
    assert.equal(state.checkoutEnabled,false);
    assert.equal(state.transfersEnabled,false);
    const ready=await fetch(url+'/api/v1/ready');
    assert.equal(ready.status,503);
    const check=await ready.json();
    assert.equal(check.ready,false);
    const pay=await fetch(url+'/api/v1/orders/72/stripe/payment-intent',
      {method:'POST'});
    assert.equal(pay.status,503);
    assert.equal(externalPaymentCalls,0);
  }finally{
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});
