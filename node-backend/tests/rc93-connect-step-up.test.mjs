import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requireTreasuryBankStepUp} from '../dist/live/treasury-connect-step-up.js';
import {totpForTestOnly} from '../dist/auth/crypto.js';

const read=(name)=>readFileSync(new URL('../src/live/'+name,import.meta.url),'utf8');
const validSession={
 userId:719,mfaVerified:true,
 user:{isActive:true,twoFactorEnabled:true,totpSecret:'JBSWY3DPEHPK3PXP'}
};
const fakePool=()=>{
 const state={attempts:0,inserts:0,commits:0,rollbacks:0};
 return {state,connect:async()=>({
  query:async(sql)=>{
   if(sql.includes('SELECT COUNT(*)::text AS attempts'))return {rows:[{attempts:String(state.attempts)}]};
   if(sql.includes('INSERT INTO tala_live_treasury_totp_attempts')){
    state.attempts++;state.inserts++;return {rowCount:1};
   }
   if(sql==='COMMIT')state.commits++;
   if(sql==='ROLLBACK')state.rollbacks++;
   return {rows:[],rowCount:1};
  },release:()=>{}
 })};
};
test('RC93 live bank step-up accepts actual fresh TOTP, persists an attempt before validation',async()=>{
 const p=fakePool();
 const now=Math.floor(Date.now()/1000);
 await requireTreasuryBankStepUp(p,validSession,totpForTestOnly(validSession.user.totpSecret,now));
 assert.equal(p.state.inserts,1);
 assert.equal(p.state.commits,1);
});
test('RC93 rejects invalid TOTP, preserving durable failed attempt',async()=>{
 const p=fakePool();
 const otp=totpForTestOnly(validSession.user.totpSecret,Math.floor(Date.now()/1000));
 const bad=otp==='999999'?'000000':'999999';
 await assert.rejects(requireTreasuryBankStepUp(p,validSession,bad),/CONNECT_FRESH_TOTP_INVALID/);
 assert.equal(p.state.inserts,1);
 assert.equal(p.state.commits,1);
});
test('RC93 requires live active user, recent MFA claim and six-digit OTP',async()=>{
 for(const session of [
  {...validSession,mfaVerified:false},
  {...validSession,user:{...validSession.user,isActive:false}},
  {...validSession,user:{...validSession.user,twoFactorEnabled:false}},
 ]){
  const p=fakePool();
  await assert.rejects(requireTreasuryBankStepUp(p,session,'123456'),/CONNECT_FRESH_TOTP_REQUIRED/);
  assert.equal(p.state.inserts,0);
 }
 const p=fakePool();
 await assert.rejects(requireTreasuryBankStepUp(p,validSession,'1234'),/CONNECT_FRESH_TOTP_REQUIRED/);
 assert.equal(p.state.inserts,0);
});
test('RC93 all bank-onboarding/confirmation routes require shared durable step-up',()=>{
 const merchant=read('merchant-finance-router.ts');
 const driver=read('payee-finance-router.ts');
 const mobile=read('treasury-connect-onboarding-router.ts');
 const part=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)+start.length));
 assert.ok(part(merchant,"r.post('/owner/finance/connect/:rid/confirm'","r.get('/admin/finance/connect/:rid/status'").includes('requireTreasuryBankStepUp'));
 assert.ok(part(merchant,"r.post('/owner/finance/connect/:rid/onboarding-link'","r.get('/connect/onboarding/:step'").includes('requireTreasuryBankStepUp'));
 assert.ok(part(driver,"r.post('/driver/finance/connect/confirm'","r.get('/driver/finance/connect/status'").includes('requireTreasuryBankStepUp'));
 assert.ok(part(driver,"r.post('/driver/finance/connect/onboarding-link'","r.get('/driver/finance/earnings'").includes('requireTreasuryBankStepUp'));
 assert.ok(mobile.includes('await requireTreasuryBankStepUp(pool,s,req.body?.totp)'));
 assert.doesNotMatch(merchant,/(?:payouts|transfers)\.create\(/);
 assert.doesNotMatch(driver,/(?:payouts|transfers)\.create\(/);
});
