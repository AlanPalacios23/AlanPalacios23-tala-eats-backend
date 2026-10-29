import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildMoneyPlan} from '../dist/live/payee-allocation.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');

test('RC13.5 cash collected by courier is full custody, NOT courier wage',()=>{
 const x=buildMoneyPlan({
  orderId:18,restaurantId:5,driverUserId:9,
  orderType:'delivery',merchantManagedDelivery:false,tender:'cash',
  totalMinor:25300,cashCollectedMinor:25300,restaurantPayableMinor:17000,driverBaseMinor:3200,
  tipMinor:0,status:'delivered',paymentStatus:'paid',
  deliveryProven:true,captured:false,openCases:0
 });
 assert.equal(x.cash?.collectorKind,'driver');
 assert.equal(x.cash?.collectedMinor,25300);
 assert.equal(x.cash?.retainedMinor,0);
 assert.equal(x.cash?.duePlatformMinor,25300);
 assert.equal(x.obligations.find(z=>z.party==='driver')?.amountMinor,3200);
 assert.equal(x.grossPlatformMinor,5100);
});
test('RC13.5 migration separates physical handoff, forbids history edits and bank claims',()=>{
 const s=read('../prisma/migrations/20261029_rc135_cash_handoff_v2/migration.sql');
 for(const term of [
  'CREATE TABLE finance_cash_handoffs_v2',
  'CREATE TABLE finance_cash_handoff_events_v2',
  'CASH_HANDOFF_HISTORY_IMMUTABLE',
  'CASH_HANDOFF_EVENT_IMMUTABLE',
  'CASH_HANDOFF_STATE_IMMUTABLE',
  "status IN ('initiated','confirmed')",
  'UNIQUE(order_id,action)'
 ])assert.ok(s.includes(term),'Missing '+term);
 assert.doesNotMatch(s,/DROP TABLE|DELETE FROM orders|UPDATE orders|INSERT INTO.*treasury/i);
});
test('RC13.5 router uses real authenticated roles and full-amount ack, no payout',()=>{
 const s=read('../src/live/cash-handoff-router-v2.ts');
 for(const term of [
  "actor.user.role!=='driver'",
  "actor.user.role!=='restaurant'",
  "o.driver_id!==actor.userId",
  "o.total_minor!==o.custody_minor",
  "o.total_minor!==o.collected_minor",
  "h.owner_id!==actor.userId",
  "h.driver_user_id===actor.userId",
  "h.expected_minor!==cents",
  "timingSafeEqual",
  "h.status!=='initiated'",
  "bank_settlement_verified:false",
  "driver_pay_executed:false"
 ])assert.ok(s.includes(term),'Missing '+term);
 assert.doesNotMatch(s,/\.payouts\.create|\.transfers\.create|UPDATE .*financial_ledger_entries/i);
});
test('RC13.5 cash LIVE admission requires separate handoff approval',()=>{
 const config=read('../src/config.ts');
 const live=read('../src/marketplace/live-cash-delivery.ts');
 assert.match(config,/RC135_CASH_DELIVERY_REQUIRES_MERCHANT_HANDOFF/);
 assert.match(live,/LIVE_CASH_HANDOFF_V2_ENABLED/);
 const app=read('../src/app.ts');
 assert.match(app,/buildCashHandoffV2Router/);
 assert.match(app,/LIVE_CASH_HANDOFF_V2_ENABLED==='true'/);
});
