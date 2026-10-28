import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {treasuryBalance,treasuryCanRequest,displayMinor,
 NODE_TREASURY_LIVE_EXECUTION_ENABLED} from '../dist/live/treasury-policy.js';
const base={
 amountTransferredMinor:18000n,committedWithdrawalsMinor:2500n,
 stripeAvailableMinor:12000n,openFinancialCases:0,pendingTransferCount:0,
 unrecognizedProviderPayouts:0,bankVerified:true,scheduleManual:true,
 ownerApproved:true,connectReady:true,pendingUnknownWithdrawals:0
};
test('restaurant and driver treasury uses exact cents, Stripe balance and reservations',()=>{
 const r=treasuryBalance(base);
 assert.equal(r.eligible,true);
 assert.equal(r.withdrawableMinor,12000n);
 assert.equal(r.currency,'mxn');
 assert.equal(displayMinor(r.withdrawableMinor),'120.00');
 assert.equal(treasuryBalance({...base,stripeAvailableMinor:50000n}).withdrawableMinor,15500n);
 assert.equal(treasuryBalance({...base,committedWithdrawalsMinor:18000n}).withdrawableMinor,0n);
 assert.equal(NODE_TREASURY_LIVE_EXECUTION_ENABLED,false);
});
test('funds are zero if KYC, bank, cases, duplicate or unknown payout present',()=>{
 for(const [x,reason] of [
  [{bankVerified:false},'BANK_ACCOUNT_NOT_VERIFIED_MANUAL'],
  [{scheduleManual:false},'BANK_ACCOUNT_NOT_VERIFIED_MANUAL'],
  [{ownerApproved:false},'CONNECT_OWNER_OR_KYC_NOT_READY'],
  [{connectReady:false},'CONNECT_OWNER_OR_KYC_NOT_READY'],
  [{openFinancialCases:1},'OPEN_REFUND_OR_DISPUTE'],
  [{pendingTransferCount:1},'UNRECONCILED_STRIPE_TRANSFER'],
  [{unrecognizedProviderPayouts:1},'UNKNOWN_EXTERNAL_PAYOUT'],
  [{pendingUnknownWithdrawals:1},'PRIOR_WITHDRAWAL_RECONCILIATION_HOLD'],
  [{committedWithdrawalsMinor:18001n},'WITHDRAWALS_EXCEED_RECONCILED_TRANSFERS'],
 ]){
  const r=treasuryBalance({...base,...x});
  assert.equal(r.withdrawableMinor,0n,JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
  assert.ok(r.blockers.includes(reason),reason);
 }
});
test('invalid, over-allocated and negative snapshots are rejected (not converted to 0)',()=>{
 for(const x of [
  {amountTransferredMinor:-1n},
  {stripeAvailableMinor:-1n},
  {committedWithdrawalsMinor:-1n},
  {openFinancialCases:NaN},
  {pendingTransferCount:-1},
  {unrecognizedProviderPayouts:Infinity}
 ])assert.throws(()=>treasuryBalance({...base,...x}),/SNAPSHOT_INVALID/);
 assert.throws(()=>displayMinor(-1n));
});
test('request must fit spendable, daily and request limits in centavos',()=>{
 const b=treasuryBalance(base);
 assert.deepEqual(treasuryCanRequest(b,10000n,20000n,12000n),[]);
 assert.ok(treasuryCanRequest(b,12100n,20000n,20000n).includes('INSUFFICIENT_VERIFIED_BALANCE'));
 assert.ok(treasuryCanRequest(b,20001n,20000n,30000n).includes('AMOUNT_OUTSIDE_APPROVED_LIMIT'));
 assert.ok(treasuryCanRequest(b,10000n,20000n,9999n).includes('DAILY_LIMIT_EXCEEDED'));
 assert.ok(treasuryCanRequest(b,0n,20000n,20000n).includes('AMOUNT_OUTSIDE_APPROVED_LIMIT'));
});
test('both role endpoints are authenticated, payouts and LIVE transfers are not released',()=>{
 const route=readFileSync(new URL('../src/live/treasury-router.ts',import.meta.url),'utf8');
 const config=readFileSync(new URL('../src/config.ts',import.meta.url),'utf8');
 const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
 const merchant=readFileSync(new URL('../src/live/merchant-finance-router.ts',import.meta.url),'utf8');
 for(const name of ['/withdrawals/:role/:id/balance','/withdrawals/:role/:id/history',
  '/withdrawals/:role/:id/request'])
  assert.ok(route.includes(name));
 assert.match(route,/const s=await current\(req\)/);
 assert.match(route,/s\.user\.role!=='restaurant'/);
 assert.match(route,/s\.user\.role!=='driver'/);
 assert.match(route,/stripe\.transfers\.retrieve/);
 assert.match(route,/stripe\.balance\.retrieve/);
 assert.match(route,/status\(503\)\.json\(\{error:'TREASURY_WITHDRAWALS_NOT_RELEASED'/);
 assert.doesNotMatch(route,/\.transfers\.create\(|\.payouts\.create\(/);
 assert.match(app,/buildTreasuryRouter\(live\.pool,live\.stripe\)/);
 assert.match(config,/LIVE_CONNECT_PAYOUTS_REQUIRE_SEPARATE_AUDIT/);
 assert.match(merchant,/ready:ownerApproved&&transferActive&&payoutsEnabled&&submitted&&identityMatches&&requirementsClear/);
});
test('additive PostgreSQL treasury journal enforces idempotency, independent payees and no duplicate unknown payout',()=>{
 const sql=readFileSync(new URL('../prisma/migrations/20261028_treasury_v1_restaurant_driver/migration.sql',import.meta.url),'utf8');
 const schema=readFileSync(new URL('../prisma/schema.prisma',import.meta.url),'utf8');
 for(const name of ['tala_live_treasury_transfers','tala_live_treasury_withdrawals',
   'tala_live_treasury_events','treasury_transfer_unique_payee',
   'treasury_withdrawal_unique_request','treasury_withdrawal_unique_otp',
   'treasury_single_pending_withdrawal','stripe_payout_id','stripe_transfer_id'])
   assert.ok(sql.includes(name),name);
 assert.match(schema,/model TalaLiveTreasuryTransfer/);
 assert.match(schema,/model TalaLiveTreasuryWithdrawal/);
 assert.match(schema,/model TalaLiveTreasuryEvent/);
 assert.doesNotMatch(sql,/INSERT INTO orders|UPDATE orders|DELETE FROM orders|ALTER TABLE orders/);
});
