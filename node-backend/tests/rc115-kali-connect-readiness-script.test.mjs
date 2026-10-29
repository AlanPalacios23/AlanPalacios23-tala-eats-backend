import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(
 new URL('../scripts/rc115-kali-live-connect-readiness.mjs',import.meta.url),'utf8');
test('RC11.5 remote readiness is read-only and cannot move money',()=>{
 assert.ok(src.includes('stripe.accounts.retrieve('));
 assert.ok(src.includes('stripe.balance.retrieve('));
 assert.doesNotMatch(src,/stripe\.(?:transfers|payouts|refunds|paymentIntents)\.create\(/);
 assert.doesNotMatch(src,/\.update\(|\.create\(|\.delete\(/);
 assert.ok(src.includes('RC115_TRANSFER_AND_PAYOUT_EXECUTION=DISABLED_BY_THIS_AUDIT'));
});
test('RC11.5 preflight requires pinned release and segregated LIVE postgres',()=>{
 for(const part of ['SERVICE_OR_SHA','RELEASE_IDENTITY','LIVE_ENV_PERMISSIONS',
  "pg.port!=='15445'","pg.pathname!=='/tala_node_live'",
  'NO_DURABLE_CONNECT_MAPPINGS','CONNECT_MAPS_REQUIRE_PAGINATION',
  'RC115_DRIVER_PAYEE_COVERAGE=NOT_VERIFIED',
  'RC115_LEDGER_WITHDRAWABLE_BALANCES=NOT_VERIFIED'])
  assert.ok(src.includes(part),part);
});
