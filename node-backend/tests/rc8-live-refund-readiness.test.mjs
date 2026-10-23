import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {inspectLiveFinancialData} from '../dist/live/financial-readiness.js';

const src=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('LIVE account probe checks real webhook URL, refunds and disputes without Stripe writes',()=>{
 const script=src('scripts/stripe-live-account-check.mjs');
 const syntax=spawnSync(process.execPath,['--check',new URL('../scripts/stripe-live-account-check.mjs',import.meta.url).pathname]);
 assert.equal(syntax.status,0,syntax.stderr?.toString());
 assert.match(script,/https:\/\/talaeats\.alan-palacios-dev\.com\/api\/v1\/payments\/stripe\/webhook/);
 for(const event of [
  'payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled',
  'refund.created','refund.updated','refund.failed',
  'charge.dispute.created','charge.dispute.closed',
 ])assert.ok(script.includes("'"+event+"'"),event);
 assert.match(script,/x\.status==='enabled'&&x\.livemode===true/);
 assert.match(script,/GET-only/);
 assert.match(script,/LIVE_WEBHOOK_SIGNATURE_DELIVERY=UNVERIFIED_UNTIL_SIGNED_EVENT/);
 assert.doesNotMatch(script,/method:\s*'POST'|method:\s*"POST"|\.create\(|\.update\(/);
});
test('financial audit covers refund state, cumulative refunded amount and immutable receipt',async()=>{
 let statement='';
 const pool={query:async sql=>{
  statement=sql;
  return {rows:[{
   pending_payment_receipts:'0',pending_refund_or_dispute_events:'0',
   suspect_captured_orders:'1',stuck_provider_reservations:'0',
  }]};
 }};
 const audit=await inspectLiveFinancialData(pool);
 assert.equal(audit.classification,'LIVE_FINANCIAL_DATA_HOLD');
 assert.equal(audit.counters.suspectCapturedOrders,1);
 for(const value of [
  "o.payment_status IN ('paid','partially_refunded','refunded')",
  'o.refunded_amount > o.total',
  "o.payment_status='paid' AND o.refunded_amount > 0",
  "o.payment_status='refunded' AND o.refunded_amount <> o.total",
  "o.payment_status='partially_refunded'",
  "l.kind='stripe_live_refund'",
  "l.kind='stripe_live_payment'",
  "l.account='stripe_live_collected'",
 ])assert.ok(statement.includes(value),value);
 assert.doesNotMatch(statement,/\bUPDATE\b|\bDELETE\b|\bINSERT\b/);
});
