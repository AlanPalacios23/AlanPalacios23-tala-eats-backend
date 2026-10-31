import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 buildReadOnlyProbes,parsePostdeployArgs,validateReadOnlyProbe,
 POSTDEPLOY_TARGETS,POSTDEPLOY_PWA_ROUTES,
} from '../scripts/rc156-postdeploy-readonly-lib.mjs';

test('RC156 refuses freeform hosts, URLs, invalid modes and live PWA checks in staging',()=>{
 assert.deepEqual(parsePostdeployArgs(['--mode=live','--with-pwas']),{mode:'live',pwas:true});
 assert.deepEqual(parsePostdeployArgs(['--mode=stage']),{mode:'stage',pwas:false});
 for(const args of [[],['--mode=dev'],['--mode=stage','--with-pwas'],['--mode=live','--url=https://evil.test'],
  ['--mode=live','--mode=stage'],['--mode=live','--with-pwas','--foo']]){
  assert.throws(()=>parsePostdeployArgs(args));
 }
 assert.throws(()=>buildReadOnlyProbes({mode:'http://attacker',pwas:false}));
 assert.throws(()=>buildReadOnlyProbes({mode:'stage',pwas:true}));
});
test('RC156 uses only audited API origins and exact three public PWA routes',()=>{
 assert.deepEqual(Object.keys(POSTDEPLOY_TARGETS).sort(),['live','stage']);
 assert.equal(POSTDEPLOY_TARGETS.live,'https://talaeats.alan-palacios-dev.com/api/v1');
 assert.equal(POSTDEPLOY_TARGETS.stage,'https://api-stage-talaeats.alan-palacios-dev.com/api/v1');
 assert.equal(POSTDEPLOY_PWA_ROUTES.length,3);
 const checks=buildReadOnlyProbes({mode:'live',pwas:true});
 assert.equal(checks.length,7);
 assert.deepEqual(checks.map(x=>x.kind),['health','ready','private','private','pwa','pwa','pwa']);
 const ids=new Set(checks.map(x=>x.id));
 assert.equal(ids.size,checks.length);
 for(const check of checks){
  const url=new URL(check.url);
  assert.equal(url.protocol,'https:');
  assert.equal(url.username,'');assert.equal(url.password,'');
  assert.equal(url.search,'');assert.equal(url.hash,'');
 }
});
test('RC156 rejects missing dependencies, wrong environments and unauthenticated support leaks',()=>{
 const probes=buildReadOnlyProbes({mode:'live',pwas:true});
 const health=probes[0],ready=probes[1],secure=probes[2],cap=probes[3],web=probes[4];
 const goodHealth={status:200,body:{status:'ok',version:'rc8.13',production:true,online_payment_writes:false}};
 assert.equal(validateReadOnlyProbe(health,goodHealth,'live'),'HEALTH_OK');
 assert.throws(()=>validateReadOnlyProbe(health,{...goodHealth,body:{...goodHealth.body,production:false}},'live'));
 assert.throws(()=>validateReadOnlyProbe(health,{status:503,body:{}},'live'));
 const goodReady={status:200,body:{ready:true,database:true,redis:true,workerOnline:true,environment:'production',financialWrites:false}};
 assert.equal(validateReadOnlyProbe(ready,goodReady,'live'),'READY_OK');
 for(const field of ['ready','database','redis','workerOnline']){
  assert.throws(()=>validateReadOnlyProbe(ready,{status:200,body:{...goodReady.body,[field]:false}},'live'));
 }
 assert.throws(()=>validateReadOnlyProbe(ready,{status:200,body:{...goodReady.body,environment:'staging'}},'live'));
 for(const protectedRoute of [secure,cap]){
  assert.equal(validateReadOnlyProbe(protectedRoute,{status:401},'live'),'AUTH_REQUIRED');
  for(const status of [200,302,403,404,500]){
   assert.throws(()=>validateReadOnlyProbe(protectedRoute,{status},'live'));
  }
 }
 assert.equal(validateReadOnlyProbe(web,{status:200,contentType:'text/html; charset=utf-8'},'live'),'HTML_OK');
 assert.throws(()=>validateReadOnlyProbe(web,{status:200,contentType:'application/json'},'live'));
});
test('RC156 CLI implementation is GET-only, no secrets, no redirects and no writes',()=>{
 const src=readFileSync(new URL('../scripts/rc156-postdeploy-readonly.mjs',import.meta.url),'utf8');
 assert.match(src,/method:'GET'/);
 assert.match(src,/redirect:'error'/);
 assert.match(src,/credentials:'omit'/);
 assert.match(src,/AbortSignal.timeout\(8000\)/);
 assert.doesNotMatch(src,/method:'POST'|method:'PUT'|method:'PATCH'|method:'DELETE'/);
 assert.doesNotMatch(src,/authorization|STRIPE_SECRET|COOKIE|DATABASE_URL|process\.env/i);
 assert.match(src,/ACTIVE_GIT_SHA=NOT_VERIFIED_REQUIRES_KALI_RELEASE_CHECK/);
});
