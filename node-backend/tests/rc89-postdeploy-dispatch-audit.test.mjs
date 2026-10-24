import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validateStageHttp,reviewReadyBacklog,main}
  from '../scripts/rc89-postdeploy-dispatch-audit.mjs';

const h={status:'ok',production:false,digital_payment_provider:'stripe',
 online_payment_writes:false,version:'rc89-stage-candidate'};
const r={ready:true,database:true,redis:true,workerOnline:true,
 productionReady:false,environment:'staging',
 financialWrites:false,onlinePaymentsEnabled:false};
const p={provider:'stripe',environment:'staging',financial_writes_enabled:false,
 enabled:false,checkout_ready:false,publishable_key:null};
const s={...p};
const now=Date.parse('2026-10-24T19:00:00Z');
const good={id:11,readyAt:new Date(now-10_000)};
const marker={orderId:11,metadataJson:JSON.stringify({
 stage_delivery_customer_v1:true,checkout_intent_hmac:'a'.repeat(64)})};

test('RC89 readonly HTTP validates staging without claiming LIVE writes',()=>{
 assert.equal(validateStageHttp(h,r,p,s,true),true);
 for(const [hh,rr,pp,ss] of [
  [{...h,production:true},r,p,s],
  [{...h,online_payment_writes:true},r,p,s],
  [h,{...r,workerOnline:false},p,s],
  [h,{...r,financialWrites:true},p,s],
  [h,{...r,productionReady:true},p,s],
  [h,r,{...p,financial_writes_enabled:true},s],
  [h,r,p,{...s,environment:'production'}],
  [h,r,{...p,publishable_key:'pk_live_injected'},s],
  [h,r,{...p,enabled:true},s],
 ])assert.equal(validateStageHttp(hh,rr,pp,ss,true),false);
 assert.equal(validateStageHttp(h,r,{...p,enabled:true,
  checkout_ready:true,publishable_key:'pk_test_local'},{
  ...s,enabled:true,checkout_ready:true,publishable_key:'pk_test_local'},true),true);
});
test('RC89 scan allows no outstanding READY and fresh signed READY',()=>{
 assert.deepEqual(reviewReadyBacklog([],[],now),{
  pass:true,reason:'OK',eligible:0,overdue:0});
 assert.deepEqual(reviewReadyBacklog([good],[marker],now),{
  pass:true,reason:'OK',eligible:1,overdue:0});
});
test('RC89 backlog never claims green on stale, saturated or malformed data',()=>{
 const overdue=reviewReadyBacklog([{...good,readyAt:new Date(now-121000)}],
  [marker],now);
 assert.deepEqual(overdue,{pass:false,reason:'READY_BACKLOG_OVERDUE',
  eligible:1,overdue:1});
 assert.equal(reviewReadyBacklog(new Array(200).fill(good),[marker],now).pass,false);
 assert.equal(reviewReadyBacklog([{...good,readyAt:null}],[marker],now).pass,false);
 assert.equal(reviewReadyBacklog([{...good,readyAt:new Date(now+10_000)}],
  [marker],now).pass,false);
 assert.equal(reviewReadyBacklog([good],[],now).pass,true);
 const foreign={...marker,metadataJson:JSON.stringify({
  stage_delivery_customer_v1:false,checkout_intent_hmac:'a'.repeat(64)})};
 assert.equal(reviewReadyBacklog([good],[foreign],now).eligible,0);
});
test('RC89 script rejects every write-like command, malformed SHA and unprivileged env',async()=>{
 assert.equal(await main(['--apply','a'.repeat(40)]),2);
 assert.equal(await main(['--stage-sha','short']),2);
 assert.equal(await main([]),2);
 assert.equal(await main(['--stage-sha','a'.repeat(40)]),1);
 const file=new URL('../scripts/rc89-postdeploy-dispatch-audit.mjs',import.meta.url);
 const run=spawnSync(process.execPath,['--check',file.pathname],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const src=readFileSync(file,'utf8');
 assert.match(src,/POSTDEPLOY_READ_ONLY=PASS/);
 assert.match(src,/STAGE_DELIVERY_CASH_CHECKOUT_ENABLED/);
 assert.match(src,/rc8-postdeploy-audit\.mjs/);
 assert.match(src,/stage:dispatch:sweep:ok/);
 assert.match(src,/orders\/payment-methods/);
 assert.doesNotMatch(src,/pm2\s+(?:start|stop|reload|restart)|paymentIntents\.create|\.create\(\{data:|execFileSync\('stripe'/);
});
