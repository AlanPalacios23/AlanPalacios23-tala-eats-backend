import test from 'node:test';
import assert from 'node:assert/strict';
import {mondayWeek,currentMexicoWeek,summarizeWalletRows} from '../dist/live/finance-wallet-read-router.js';

test('RC13.4 week uses Mexico City calendar and only Monday periods',()=>{
 assert.equal(currentMexicoWeek(new Date('2026-10-29T18:00:00Z')),'2026-10-26');
 assert.equal(currentMexicoWeek(new Date('2026-11-02T02:00:00Z')),'2026-10-26');
 assert.equal(mondayWeek('2026-10-26'),'2026-10-26');
 assert.throws(()=>mondayWeek('2026-10-27'),/WALLET_WEEK_MUST_BE_MONDAY/);
 assert.throws(()=>mondayWeek('2026-02-30'),/WALLET_WEEK_MUST_BE_MONDAY|WALLET_WEEK_FORMAT_INVALID/);
 assert.throws(()=>mondayWeek('2026-10-26T00:00Z'),/WALLET_WEEK_FORMAT_INVALID/);
});
const row=(id,kind,holder)=>({
 order_id:id,amount_minor:'3200',state:'held',
 tender:'cash',fulfillment:'platform_delivery',
 delivered_at:new Date('2026-10-29T18:30:00Z'),
 custody_collector_kind:kind,custody_collector_id:holder,
 custody_collected_minor:'25300',custody_status:'awaiting_evidence',
 open_financial_cases:'0'
});
test('RC13.4 driver wallet does NOT count physical cash as their earnings',()=>{
 const statement=summarizeWalletRows('driver',15,'2026-10-26',[row(121,'driver',15)]);
 assert.equal(statement.recorded_earnings_cents,'3200');
 assert.equal(statement.pending_allocation_cents,'3200');
 assert.equal(statement.cash_in_driver_custody_cents,'25300');
 assert.equal(statement.cash_in_merchant_custody_unverified_cents,'0');
 assert.equal(statement.withdrawable_cents,'0');
 assert.equal(statement.bank_payout_confirmed,false);
 assert.equal(statement.items[0].financial_hold_reasons.includes('CASH_CUSTODY_NOT_BANK_SETTLED'),true);
});
test('RC13.4 restaurant cash only appears when merchant actually holds it',()=>{
 const w=summarizeWalletRows('restaurant',7,'2026-10-26',[
  {...row(122,'driver',15),amount_minor:'17000'},
  {...row(123,'restaurant',7),amount_minor:'17000'}
 ]);
 assert.equal(w.cash_in_merchant_custody_unverified_cents,'25300');
 assert.equal(w.cash_in_driver_custody_cents,'0');
 assert.equal(w.recorded_earnings_cents,'34000');
 assert.equal(w.withdrawable_cents,'0');
});
test('RC13.4 Stripe is never an available bank balance from allocations alone',()=>{
 const w=summarizeWalletRows('restaurant',7,'2026-10-26',[{
  ...row(123,'restaurant',7),amount_minor:'17000',tender:'stripe',
  custody_collector_kind:null,custody_collector_id:null,
  custody_collected_minor:null,custody_status:null,
  state:'settled',open_financial_cases:'1',
 }]);
 assert.equal(w.pending_allocation_cents,'0');
 assert.equal(w.withdrawable_cents,'0');
 assert.equal(w.items[0].financial_hold_reasons.includes('STRIPE_AVAILABLE_NOT_PROVEN'),true);
 assert.equal(w.items[0].financial_hold_reasons.includes('OPEN_FINANCIAL_CASE'),true);
 assert.equal(w.payment_to_bank_status,'NOT_RECONCILED');
});
test('RC13.4 rejects invalid funds rather than inventing a Wallet sum',()=>{
 assert.throws(()=>summarizeWalletRows('driver',15,'2026-10-26',[
  {...row(1,'driver',15),amount_minor:'NaN'}
 ]),/WALLET_CENTS_INVALID/);
});
