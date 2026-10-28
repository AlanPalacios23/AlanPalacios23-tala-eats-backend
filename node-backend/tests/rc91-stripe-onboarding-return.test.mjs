import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {buildLiveMerchantFinanceRouter} from '../dist/live/merchant-finance-router.js';

test('Stripe Connect return never marks a bank verified or processes money',async()=>{
 const app=express();
 app.use('/api/v1',buildLiveMerchantFinanceRouter({},{}));
 const server=app.listen(0,'127.0.0.1');
 await new Promise((resolve,reject)=>{
  server.once('listening',resolve);
  server.once('error',reject);
 });
 try{
  const addr=server.address();
  assert.equal(typeof addr,'object');
  const base='http://127.0.0.1:'+addr.port;
  const r=await fetch(base+'/api/v1/connect/onboarding/return');
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-type')||'',/text\/html/);
  assert.match(r.headers.get('cache-control')||'',/no-store/);
  assert.match(r.headers.get('content-security-policy')||'',/frame-ancestors 'none'/);
  const html=await r.text();
  assert.match(html,/Volviste desde Stripe/);
  assert.match(html,/no significa que tu banco ya esté aprobado/);
  assert.match(html,/consulta[r]? el estado|estado actualizado/i);
  assert.doesNotMatch(html,/bank_payout_created|payouts_enabled=true|Cuenta verificada correctamente/);
  const expired=await fetch(base+'/api/v1/connect/onboarding/refresh');
  assert.equal(expired.status,200);
  assert.match(await expired.text(),/enlace de Stripe venció/);
  const wrong=await fetch(base+'/api/v1/connect/onboarding/wrong');
  assert.equal(wrong.status,404);
 }finally{if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
