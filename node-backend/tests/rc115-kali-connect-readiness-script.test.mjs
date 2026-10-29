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
  'RC115_DRIVER_PAYEE_COVERAGE=CHECKED_FOR_MAPPED_PAYEES_ONLY',
  'RC115_LEDGER_WITHDRAWABLE_BALANCES=NOT_VERIFIED'])
  assert.ok(src.includes(part),part);
});

test('RC11.5 uses actual LIVE merchant and driver tables, never legacy mirror',()=>{
 const sql=readFileSync(new URL('../scripts/sql/rc115-live-actual-beneficiaries.sql',import.meta.url),'utf8');
 for(const table of ['tala_live_merchant_accounts','tala_live_driver_accounts','restaurants','users','driver_profiles'])
  assert.ok(sql.includes(table),table);
 assert.ok(sql.includes('owner_approved_at IS NOT NULL'));
 assert.ok(sql.includes('LIMIT 51'));
 assert.doesNotMatch(sql,/merchant_connect_accounts/i);
 assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
 assert.ok(src.includes('assessMappedLiveBeneficiary('));
 assert.ok(src.includes('db.$queryRawUnsafe(sql)'));
 assert.ok(src.includes('RC115_RESTAURANT_PAYEES='));
 assert.ok(src.includes('RC115_DRIVER_PAYEES='));
 assert.ok(!src.includes('db.merchantConnectAccount.'));
});
