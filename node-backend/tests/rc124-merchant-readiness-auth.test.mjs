import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readinessAuthStatus} from '../dist/live/pickup-readiness.js';

test('RC12.4 no session on either merchant readiness route maps to 401, not Stripe 503',()=>{
 assert.equal(readinessAuthStatus({code:401,message:'Sesión requerida'}),401);
 assert.equal(readinessAuthStatus({code:403,message:'No autorizado'}),403);
 for(const error of [null,undefined,{},new Error('Redis down'),
  {code:'401'}, {code:500}, {code:503},{status:401},42]){
  assert.equal(readinessAuthStatus(error),null,'Unexpected HTTP status override');
 }
});
test('RC12.4 pickup and delivery endpoint share safe auth status handling',()=>{
 const source=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
 const begin=source.indexOf("app.get(['/api/v1/restaurants/:id/pickup-readiness'");
 const end=source.indexOf("// Check the payee again at PaymentIntent time",begin);
 assert.ok(begin>0&&end>begin);
 const route=source.slice(begin,end);
 assert.ok(route.includes("const session=await current(req)"));
 assert.ok(route.includes("res.status(status).json({error:status===401?'AUTH_REQUIRED':'BUYER_FORBIDDEN'})"));
 assert.ok(route.includes("res.status(503).json({error:'MERCHANT_READINESS_UNAVAILABLE'})"));
 assert.ok(route.includes("'/api/v1/restaurants/:id/delivery-readiness'"));
 assert.ok(route.includes("res.setHeader('Cache-Control','private, no-store')"));
 assert.doesNotMatch(route,/res\.json\(\s*seller\s*\)/);
});
