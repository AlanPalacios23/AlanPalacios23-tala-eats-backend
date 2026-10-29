import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const source=readFileSync(
 new URL('../scripts/rc114-kali-live-cash-readiness.mjs',import.meta.url),'utf8');
test('RC11.2/3 cash readiness checks approved LIVE seller before driver',()=>{
 for(const marker of [
  "onboardingStatus:'approved'","verificationStatus:'verified'",
  'pickupEnabled:true',
  'owner_approved_at','tala_live_merchant_accounts',
  "stripe.accounts.retrieve(m.stripe_account_id)",
  'pickupCapability({',
  'seller.charges_enabled!==true',
  'hasReachableLiveDriver({lat:r.lat,lng:r.lng})',
  'RC114_STRIPE_LIVE_SELLERS_ELIGIBLE_SAMPLE=',
  'RC114_SELLERS_WITH_REACHABLE_IDLE_DRIVER_SAMPLE=',
  'HOLD_NO_APPROVED_STRIPE_SELLER_AND_DRIVER_PAIR',
 ])assert.ok(source.includes(marker),marker);
 assert.ok(source.indexOf('pickupCapability({')<
   source.indexOf('hasReachableLiveDriver({lat:r.lat,lng:r.lng})'));
});
test('RC11.2/3 capacity does not activate money or invent approval',()=>{
 assert.doesNotMatch(source,/\b(?:INSERT INTO|UPDATE orders|DELETE FROM)\b/i);
 assert.doesNotMatch(source,/(?:stripe\.transfers|stripe\.payouts|stripe\.refunds|stripe\.paymentIntents)\.create\(/);
 assert.ok(source.includes('RC114_STRIPE_OPERATIONS=GET_ONLY'));
 assert.ok(source.includes('RC114_DB_WRITES=NONE'));
 assert.ok(source.includes('RC114_E2E_ORDER_PAYMENT_PIN=NOT_VERIFIED'));
 const p=new URL('../scripts/rc114-kali-live-cash-readiness.mjs',import.meta.url);
 const check=spawnSync(process.execPath,['--check',p.pathname],{encoding:'utf8'});
 assert.equal(check.status,0,check.stderr);
});
