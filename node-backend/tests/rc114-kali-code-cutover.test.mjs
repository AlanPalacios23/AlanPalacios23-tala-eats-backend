import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const path=new URL('../scripts/rc114-kali-live-code-cutover.sh',import.meta.url);
const src=readFileSync(path,'utf8');
test('RC11.4 has a dedicated release and rollback receipt (RC11.3 receipt untouched)',()=>{
 assert.match(src,/rc114-cash-delivery-previous\.json/);
 assert.doesNotMatch(src,/rc113-cash-delivery-previous\.json/);
 assert.match(src,/--\(plan\|apply\|verify\|rollback\)/);
 assert.match(src,/I_APPROVE_RC114_LIVE_TWO_PM2_CASH_DELIVERY_CODE_ONLY/);
 assert.match(src,/I_APPROVE_RC114_ROLLBACK_PREVIOUS_TWO_PM2/);
});
test('RC11.4 deploy requires exact SHA and two PM2 process identity',()=>{
 assert.match(src,/PINNED_RELEASE_OR_LIVE_ENV/);
 assert.match(src,/PM2_IDENTITY_MISMATCH/);
 assert.match(src,/BASELINE_SHA_CHANGED/);
 assert.match(src,/tala-node-stage-api/);
 assert.match(src,/tala-node-stage-worker/);
 assert.match(src,/AUTOMATIC_ROLLBACK/);
});
test('RC11.4 code-only deploy cannot turn on cash, card delivery or transfers',()=>{
 for(const flag of [
  'LIVE_DELIVERY_CASH_CHECKOUT_ENABLED',
  'LIVE_DELIVERY_CASH_DISPATCH_ENABLED',
  'LIVE_DELIVERY_CASH_RELEASE_APPROVED',
  'LIVE_DELIVERY_CARD_CHECKOUT_ENABLED',
  'STRIPE_CONNECT_TRANSFERS_ENABLED',
  'LIVE_DELIVERY_RELEASE_APPROVED',
  'STRIPE_LIVE_ENABLED',
 ])assert.ok(src.includes(flag),flag);
 assert.ok(src.includes('RC114_LIVE_FINANCIAL_AND_DELIVERY_GUARDS=PASS'));
 assert.ok(src.includes('RC114_PM2_DATABASE_STRIPE=UNCHANGED'));
 assert.ok(src.includes('RC114_STRIPE_DB_PWA=UNCHANGED'));
});
