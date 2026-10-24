import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {settlementEligibility} from '../dist/live/settlement-eligibility.js';

const eligible={
 status:'delivered',paymentStatus:'paid',
 total:12500,payout:8500,refunded:0,
 captured:true,cases:0,approved:true,transfers:true,
 payouts:true,details:true,transferRecorded:false
};
test('restaurant settlement preview requires completed, fully collected order and unique seller',()=>{
 assert.deepEqual(settlementEligibility(eligible),{eligible:true,reasons:[]});
 const defects=[
  [{status:'preparing'},'DELIVERY_NOT_CONFIRMED'],
  [{paymentStatus:'pending'},'REFUND_OR_UNPAID'],
  [{refunded:100},'REFUND_OR_UNPAID'],
  [{payout:12501},'INVALID_PAYOUT_AMOUNT'],
  [{captured:false},'SIGNED_CAPTURE_NOT_POSTED'],
  [{cases:1},'OPEN_REFUND_OR_DISPUTE'],
  [{approved:false},'SELLER_CONNECT_INCOMPLETE'],
  [{transfers:false},'SELLER_CONNECT_INCOMPLETE'],
  [{payouts:false},'SELLER_CONNECT_INCOMPLETE'],
  [{details:false},'SELLER_CONNECT_INCOMPLETE'],
  [{transferRecorded:true},'SETTLEMENT_ALREADY_APPROVED'],
 ];
 for(const [patch,reason] of defects){
  const result=settlementEligibility({...eligible,...patch});
  assert.equal(result.eligible,false,JSON.stringify(patch));
  assert.ok(result.reasons.includes(reason),JSON.stringify(patch));
 }
});
test('finance router never creates transfers, payouts or charges and requires MFA',()=>{
 const source=readFileSync(new URL('../src/live/merchant-finance-router.ts',import.meta.url),'utf8');
 assert.match(source,/twoFactorEnabled/);
 assert.match(source,/mfaVerified/);
 assert.match(source,/reviewed_by_user_id<>/);
 assert.match(source,/owner_approved_at/);
 assert.match(source,/accountLinks\.create/);
 assert.match(source,/settlement_enabled:false|transfer_created:false|transfer_automation_enabled:false/);
 assert.doesNotMatch(source,/\.transfers\.create\(|\.payouts\.create\(|\.paymentIntents\.create\(/);
});
test('database has separate merchant identity, manual finance review and proposal constraints',()=>{
 const sql=readFileSync(new URL('../prisma/migrations/20261023_rc84_merchant_finance_controls/migration.sql',import.meta.url),'utf8');
 for(const part of ['tala_live_merchant_accounts','tala_live_financial_cases',
  'tala_live_settlement_proposals','reviewed_by_user_id<>resolved_by_user_id',
  "settlement_policy IN ('manual_hold','reviewed_release')",
  'live_proposal_no_implicit_transfer_chk'])
  assert.ok(sql.includes(part),part);
 assert.doesNotMatch(sql,/CREATE TRIGGER|CREATE FUNCTION|INSERT INTO orders|UPDATE orders/);
});

test('seller finance calculation imports without server secrets or production environment',()=>{
 const child=spawnSync(process.execPath,['--input-type=module','-e',
  "import('./dist/live/settlement-eligibility.js').then(m=>{if(typeof m.settlementEligibility!=='function')process.exit(2)}).catch(()=>process.exit(3))"
 ],{cwd:process.cwd(),encoding:'utf8',timeout:6000,
    env:{PATH:process.env.PATH??''}});
 assert.equal(child.status,0,child.stderr);
 assert.doesNotMatch(child.stderr,/ZodError|DATABASE_URL|REDIS_URL|NODE_ENV/);
});
