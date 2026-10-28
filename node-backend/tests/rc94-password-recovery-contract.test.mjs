import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=(path)=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');

test('RC94 LIVE recovery is explicitly opt-in with separate verified Resend credentials',()=>{
 const config=get('config.ts');
 for(const s of ['LIVE_AUTH_EMAIL_DELIVERY_MODE','LIVE_AUTH_EMAIL_SENDER_APPROVED',
  'LIVE_AUTH_EMAIL_RESEND_API_KEY','LIVE_AUTH_EMAIL_FROM',
  'LIVE_AUTH_EMAIL_REQUIRES_APPROVED_VERIFIED_RESEND_SENDER',
  'LIVE_AUTH_EMAIL_FORBIDDEN_IN_STAGING'])assert.ok(config.includes(s),s);
 const worker=get('live/production-worker.ts');
 assert.match(worker,/deliverAuthMailBatch/);
 assert.match(worker,/LIVE_AUTH_EMAIL_DELIVERY_MODE==='resend'/);
 assert.match(worker,/if\(mailTimer\)clearInterval\(mailTimer\)/);
});
test('RC94 email sender is not an anonymous open relay and never uses Stripe',()=>{
 const mail=get('email.ts');
 assert.match(mail,/LIVE_AUTH_EMAIL_RESEND_API_KEY/);
 assert.match(mail,/live&&mail\.subject!=='Restablece tu contraseña de Tala Eats'/);
 assert.match(mail,/FOR UPDATE SKIP LOCKED/);
 assert.match(mail,/Idempotency-Key/);
 assert.match(mail,/\[redacted: email delivered\]/);
 assert.doesNotMatch(mail,/stripe\.|payouts\.create|transfers\.create/);
});
test('RC94 same server-hosted reset works for all role accounts',()=>{
 const a=get('auth/routes.ts');
 for(const s of ["'/password/forgot'","'/password/reset'","'/password/reset-page'",
   'completePasswordReset','authDeviceSession.updateMany','authPasswordResetToken.updateMany',
   'allowRecoveryEmail','Cache-Control',"'no-referrer'","frame-ancestors 'none'"])
   assert.ok(a.includes(s),s);
 assert.match(a,/RESET_BROWSER_URL\+'\?token='\+encodeURIComponent\(raw\)/);
 assert.match(a,/authUser\.findUnique\(\{where:\{email\}\}\)/);
 assert.doesNotMatch(a,/user\.role\s*===\s*'customer'/);
});
