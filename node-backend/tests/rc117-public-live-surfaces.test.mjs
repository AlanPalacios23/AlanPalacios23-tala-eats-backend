import test from 'node:test';
import assert from 'node:assert/strict';
import {LIVE_PUBLIC_SURFACES,probeLivePublicSurfaces as probe}
 from '../src/operational/rc117-public-live-surfaces.mjs';
const html='<html><head><script src="/assets/index.js"></script></head><body><div id="root"></div></body></html>';
function fakeFetch(overrides={}){
 return async url=>{
  const kind=url.includes('/ready')?'api':'portal';
  if(overrides[url])return overrides[url];
  return {ok:true,status:200,url,headers:{get:()=>kind==='api'?'application/json':'text/html'},
   json:async()=>({ready:true,workerOnline:true,environment:'production'}),
   text:async()=>html};
 };
}
test('RC11.7 public health returns four GET successes, never commercial approval',async()=>{
 const r=await probe(fakeFetch());
 assert.equal(LIVE_PUBLIC_SURFACES.length,4);
 assert.equal(r.publicHttpReachable,true);
 assert.deepEqual(r.checks.map(x=>x.kind),['api','client','restaurant','driver']);
 for(const key of ['realCheckoutProven','driverPinE2EProven','stripeDeliveryProven',
  'payoutsProven','backupRestoreProven','alertsProven','launchApproved'])
  assert.equal(r[key],false,key);
});
test('RC11.7 api 200 without healthy worker is NO-GO',async()=>{
 const api=LIVE_PUBLIC_SURFACES[0].url;
 const base=await fakeFetch()(api);
 const r=await probe(fakeFetch({[api]:{...base,
  json:async()=>({ready:true,workerOnline:false,environment:'production'})}}));
 assert.equal(r.publicHttpReachable,false);
 assert.equal(r.checks[0].reason,'API_OR_WORKER_NOT_PRODUCTION_READY');
});
test('RC11.7 rejects cross-origin login redirects and fake SPA output',async()=>{
 const driver=LIVE_PUBLIC_SURFACES[3].url;
 let r=await probe(fakeFetch({[driver]:{
  ...await fakeFetch()(driver),url:'https://example.com/login'}}));
 assert.equal(r.publicHttpReachable,false);
 assert.equal(r.checks[3].reason,'CROSS_ORIGIN_REDIRECT');
 r=await probe(fakeFetch({[driver]:{
  ...await fakeFetch()(driver),text:async()=>'<html>error</html>'}}));
 assert.equal(r.checks[3].reason,'PWA_SHELL_INVALID');
});
test('RC11.7 rejects HTTP failures and network outage for any portal',async()=>{
 const client=LIVE_PUBLIC_SURFACES[1].url;
 const broken={ok:false,status:503,url:client,
  headers:{get:()=>''},text:async()=>''};
 const r=await probe(fakeFetch({[client]:broken}));
 assert.equal(r.publicHttpReachable,false);
 assert.equal(r.checks[1].reason,'HTTP_503');
 const offline=await probe(async()=>{throw new TypeError('offline')});
 assert.equal(offline.publicHttpReachable,false);
 assert.equal(offline.checks.length,4);
});
