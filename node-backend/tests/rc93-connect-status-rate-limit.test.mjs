import test from 'node:test';
import assert from 'node:assert/strict';
import {checkConnectStatusRateLimit} from '../dist/live/treasury-connect-onboarding-router.js';

const payee={ownerId:41,role:'restaurant',id:77};
const shared=new Map();
const fakeRedis=()=>({
 multi(){
  let key,ttl;
  return {
   incr(k){key=k;return this;},
   expire(k,seconds){assert.equal(k,key);ttl=seconds;return this;},
   async exec(){
    assert.equal(ttl,300);
    assert.match(key,/tala:node:live:connect-status:41:restaurant:77/);
    const count=(shared.get(key)??0)+1;
    shared.set(key,count);
    return [[null,count],[null,1]];
   }
  };
 }
});
test('RC93 Connect status allows 30 per owner/payee and throttles further Stripe reads',async()=>{
 shared.clear();
 for(let i=0;i<30;i++)assert.equal(await checkConnectStatusRateLimit(fakeRedis(),payee),true);
 assert.equal(await checkConnectStatusRateLimit(fakeRedis(),payee),false);
 assert.equal(shared.get('tala:node:live:connect-status:41:restaurant:77'),31);
});
test('RC93 cannot mistake Redis outage for an allowed Stripe read',async()=>{
 const disconnected={multi:()=>({incr(){return this},expire(){return this},
  exec:async()=>null})};
 await assert.rejects(checkConnectStatusRateLimit(disconnected,payee),
  /CONNECT_RATE_LIMIT_UNAVAILABLE/);
});
