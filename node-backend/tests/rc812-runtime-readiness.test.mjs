import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeRuntimeReadiness} from '../dist/runtime-readiness.js';

const base={
  nodeEnv:'staging',workerOnline:false,financialAuditPass:false,
  stagePickupCashEnabled:false,stageDeliveryCashEnabled:false,
  stageStripeTestEnabled:false,stageDeliveryStripeTestEnabled:false,
  stageDriverEnabled:false,
};
const check=flags=>computeRuntimeReadiness({...base,...flags});

test('RC8.12 API-only staging may serve read-only requests with no worker',()=>{
  assert.deepEqual(check({}),{workerRequired:false,ready:true});
});

test('RC8.12 every customer checkout or courier dispatch flag requires worker',()=>{
  for(const name of ['stagePickupCashEnabled','stageDeliveryCashEnabled',
    'stageStripeTestEnabled','stageDeliveryStripeTestEnabled','stageDriverEnabled']){
    const unavailable=check({[name]:true});
    assert.deepEqual(unavailable,{workerRequired:true,ready:false},name);
    const online=check({[name]:true,workerOnline:true});
    assert.deepEqual(online,{workerRequired:true,ready:true},name);
  }
});

test('RC8.12 missing worker refuses readiness when multiple P0 paths are on',()=>{
  assert.deepEqual(check({stagePickupCashEnabled:true,stageDeliveryCashEnabled:true,
    stageDriverEnabled:true,stageStripeTestEnabled:true}),
    {workerRequired:true,ready:false});
});

test('RC8.12 worker heartbeat alone cannot promote production without finance PASS',()=>{
  assert.deepEqual(check({nodeEnv:'production'}),
    {workerRequired:true,ready:false});
  assert.deepEqual(check({nodeEnv:'production',workerOnline:true}),
    {workerRequired:true,ready:false});
  assert.deepEqual(check({nodeEnv:'production',financialAuditPass:true}),
    {workerRequired:true,ready:false});
  assert.deepEqual(check({nodeEnv:'production',workerOnline:true,financialAuditPass:true}),
    {workerRequired:true,ready:true});
});

test('RC8.12 503 behavior is wired to live Express ready handler, not only helper',()=>{
  const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
  assert.match(app,/computeRuntimeReadiness\(\{/);
  assert.match(app,/res\.status\(ready\?200:503\)/);
  assert.match(app,/workerOnline,workerRequired/);
  assert.match(app,/stageDeliveryCashEnabled:config\.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'/);
});
