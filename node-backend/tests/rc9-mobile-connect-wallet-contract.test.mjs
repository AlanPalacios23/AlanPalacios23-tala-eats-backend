import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=(p)=>readFileSync(new URL('../src/live/'+p,import.meta.url),'utf8');
test('mobile restaurant/driver Connect status + bank onboarding mounted and authenticated',()=>{
 const s=get('treasury-connect-onboarding-router.ts');
 const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
 assert.match(app,/buildTreasuryConnectOnboardingRouter\(live\.pool,live\.stripe\)/);
 for(const item of ["'/withdrawals/:role/:id/connect/status'","'/withdrawals/:role/:id/connect/onboarding'",'current(req)','verifiedTotpCounter','recordTreasuryOtpAttempt','stripeState(provider,x)','accountLinks.create'])assert.ok(s.includes(item),item);
 for(const item of ['not_linked','pending_verification','CONNECT_MAPPING_OR_OWNER_APPROVAL_REQUIRED','DRIVER_UNVERIFIED','stripe_bank_payout_created:false','server_allows_requests:false'])assert.ok(s.includes(item),item);
 assert.doesNotMatch(s,/(?:transfers|payouts|charges)\.create\(/);
});
test('Wallet API delivers numeric cents, mobile history array and financial kill switch',()=>{
 const s=get('treasury-router.ts');
 for(const item of ['withdrawable_cents:Number(b.withdrawableMinor)','already_requested_cents:Number(b.reservedMinor)','res.json(r.rows.map','currency:\'mxn\'','server_allows_requests:false','payout_execution_enabled:false'])assert.ok(s.includes(item),item);
 assert.doesNotMatch(s,/\b(?:transfers|payouts)\.create\(/);
});
