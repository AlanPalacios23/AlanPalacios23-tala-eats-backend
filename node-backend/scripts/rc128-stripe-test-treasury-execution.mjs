#!/usr/bin/env node
/** RC12.8 — SUPERVISED Stripe TEST disbursement of an already-approved,
 * server-owned treasury reservation. No fixtures, LIVE keys, or production DB.
 * PLAN reads Stripe TEST; EXECUTE moves only Stripe TEST balances.
 * Never retry UNKNOWN automatically: investigate Stripe with the original key.
 */
import {userInfo} from 'node:os';
import Stripe from 'stripe';
import {Pool} from 'pg';
import {config} from '../dist/config.js';
import {dispatchTreasuryTransfer,dispatchTreasuryWithdrawal}
 from '../dist/live/treasury-dispatch.js';
import {auditedSnapshot} from '../dist/live/treasury-router.js';

const fail=(s)=>{throw Error(s);};
const [mode,kind,id,approval]=process.argv.slice(2);
const testKeys=['STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_LIVE_ENABLED',
 'STRIPE_LIVE_RELEASE_APPROVED','STRIPE_CONNECT_TRANSFERS_ENABLED',
 'STRIPE_MANUAL_SETTLEMENT_APPROVED','STRIPE_REFUNDS_ENABLED'];
if(!['--plan','--execute-test'].includes(mode)||
 !['transfer','payout'].includes(kind)||!/^[1-9][0-9]{0,15}$/.test(id||'')){
 fail('USAGE: --plan|--execute-test transfer|payout <RESERVATION_ID> [APPROVAL]');
}
if(process.getuid?.()===0||userInfo().username!=='tala-node-stage'||
 config.NODE_ENV!=='staging'||
 !config.STRIPE_SECRET_KEY?.startsWith('sk_test_')||
 testKeys.some(k=>process.env[k]!=='false'))
 fail('RC128_TEST_OPERATOR_OR_KEY_ISOLATION_HOLD');
const db=new URL(config.DATABASE_URL);
const redis=new URL(config.REDIS_URL);
if(db.username!=='tala_node_stage'||db.hostname!=='127.0.0.1'||
 db.port!=='15435'||db.pathname!=='/tala_node_stage'||
 redis.hostname!=='127.0.0.1'||redis.port!=='16379')
 fail('RC128_TEST_DATABASE_ISOLATION_HOLD');
const actionToken=kind==='transfer'?'I_APPROVE_STRIPE_TEST_TRANSFER_ONLY':
 'I_APPROVE_STRIPE_TEST_PAYOUT_ONLY';
if(mode==='--execute-test'&&approval!==actionToken)
 fail('RC128_EXPLICIT_TEST_EXECUTION_APPROVAL_REQUIRED');
if(mode==='--plan'&&approval)fail('RC128_PLAN_REQUIRES_NO_APPROVAL_TOKEN');
const stripe=new Stripe(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:12000});
const pool=new Pool({connectionString:config.DATABASE_URL,max:2,
 connectionTimeoutMillis:7000,statement_timeout:15000});

const number=(raw)=>{
 const str=String(raw??'');
 if(!/^[0-9]{1,14}$/.test(str))fail('RC128_MONEY_INVALID');
 const n=Number(str);
 if(!Number.isSafeInteger(n))fail('RC128_MONEY_OVERFLOW');
 return n;
};
const roleOwner=async(kind,payeeId)=>{
 const table=kind==='restaurant'?
  `SELECT r.owner_id AS user_id,u.email,u.role,u.is_active,
   m.stripe_account_id,m.owner_approved_at
   FROM restaurants r JOIN users u ON u.id=r.owner_id
   JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id
   WHERE r.id=$1`:
  `SELECT u.id AS user_id,u.email,u.role,u.is_active,p.is_verified,
   d.stripe_account_id,d.owner_approved_at
   FROM users u JOIN driver_profiles p ON p.user_id=u.id
   JOIN tala_live_driver_accounts d ON d.user_id=u.id
   WHERE u.id=$1`;
 const r=await pool.query(table,[payeeId]),o=r.rows[0];
 if(!o||!o.is_active||o.role!==kind||
  (kind==='driver'&&!o.is_verified)||!o.owner_approved_at)
  fail('RC128_BENEFICIARY_NOT_APPROVED');
 return o;
};
const connectedAccount=async(account,owner)=>{
 if(!/^acct_[A-Za-z0-9]+$/.test(account)||
  account===config.STRIPE_PLATFORM_ACCOUNT_ID||
  account!==owner.stripe_account_id)
  fail('RC128_CONNECT_MAPPING_INVALID');
 const acct=await stripe.accounts.retrieve(account);
 if(acct.id!==account||acct.country!=='MX'||
  acct.email?.trim().toLowerCase()!==owner.email.trim().toLowerCase()||
  acct.capabilities?.transfers!=='active'||acct.payouts_enabled!==true||
  acct.details_submitted!==true||acct.requirements?.disabled_reason||
  (acct.requirements?.currently_due?.length??0)>0||
  (acct.requirements?.past_due?.length??0)>0)
  fail('RC128_STRIPE_TEST_CONNECTED_ACCOUNT_NOT_READY');
 return acct;
};
const approved=(row)=>{
 if(row.state!=='reserved'||!Number.isSafeInteger(row.reviewed_by_user_id)||
  !Number.isSafeInteger(row.approved_by_user_id)||
  row.reviewed_by_user_id===row.approved_by_user_id)
  fail('RC128_DUAL_APPROVAL_OR_STATE_HOLD');
};
async function transferInput(){
 const result=await pool.query(`SELECT t.id::text,t.order_id,t.payee_kind,
  t.payee_id,t.state,t.connected_account_id,t.source_charge_id,
  t.amount_minor::text,t.reviewed_by_user_id,t.approved_by_user_id,
  t.stripe_transfer_id,o.status AS order_status,o.payment_method,
  o.payment_status,o.payment_provider_id,o.delivered_at,
  (ROUND(o.total*100))::bigint::text AS order_amount_minor,
  (ROUND(o.refunded_amount*100))::bigint::text AS refunded_minor
  FROM tala_live_treasury_transfers t JOIN orders o ON o.id=t.order_id
  WHERE t.id=$1`,[id]);
 const row=result.rows[0];
 if(!row||!['restaurant','driver'].includes(row.payee_kind))
  fail('RC128_TRANSFER_NOT_FOUND');
 approved(row);
 if(row.stripe_transfer_id||row.order_status!=='delivered'||!row.delivered_at||
  row.payment_method!=='stripe'||row.payment_status!=='paid'||
  number(row.refunded_minor)!==0)
  fail('RC128_TRANSFER_ORDER_NOT_SETTLEABLE');
 const beneficiary=await roleOwner(row.payee_kind,row.payee_id);
 await connectedAccount(row.connected_account_id,beneficiary);
 const checks=await pool.query(`SELECT
  (SELECT count(*)::int FROM delivery_proofs
   WHERE order_id=$1 AND pin_verified=true) AS pin,
  (SELECT count(*)::int FROM financial_ledger_entries WHERE order_id=$1
   AND kind='stripe_live_payment' AND account='stripe_live_collected'
   AND direction='credit' AND idempotency_key=('order:'||$1::text||':stripe-live:collected')) AS payment,
  (SELECT count(*)::int FROM tala_live_financial_cases WHERE order_id=$1
   AND status<>'resolved') AS cases,
  (SELECT count(*)::int FROM tala_live_payee_allocations WHERE order_id=$1
   AND payee_kind=$2 AND payee_id=$3 AND tender='stripe' AND state='held'
   AND amount_minor=$4) AS alloc`,
  [row.order_id,row.payee_kind,row.payee_id,row.amount_minor]);
 const c=checks.rows[0];
 if(c?.pin!==1||c?.payment!==1||c?.cases!==0||c?.alloc!==1)
  fail('RC128_ORDER_LEDGER_OR_PIN_HOLD');
 const pi=await stripe.paymentIntents.retrieve(row.payment_provider_id);
 const ch=await stripe.charges.retrieve(row.source_charge_id);
 const expectedCharge=typeof pi.latest_charge==='string'?pi.latest_charge:
  pi.latest_charge?.id;
 if(pi.livemode!==false||pi.status!=='succeeded'||pi.currency!=='mxn'||
  pi.metadata.order_id!==String(row.order_id)||
  pi.amount_received!==number(row.order_amount_minor)||
  expectedCharge!==ch.id||ch.id!==row.source_charge_id||
  ch.livemode!==false||!ch.paid||!ch.captured||ch.refunded||
  ch.disputed||ch.amount_refunded!==0||ch.currency!=='mxn'||
  ch.amount_captured!==pi.amount_received)
  fail('RC128_TEST_CHARGE_MISMATCH');
 return {orderId:row.order_id,kind:row.payee_kind,payeeId:row.payee_id,
  amountMinor:number(row.amount_minor),stripeAccountId:row.connected_account_id,
  approvedByOwner:true,connectReady:true,chargeId:ch.id,
  capturedAmountMinor:ch.amount_captured,alreadyTransferred:false,
  delivered:true,proof:true,refundedMinor:0,openCases:0,sourceMode:'stripe'};
}
async function payoutAvailable(){
 const r=await pool.query(`SELECT id::text,payee_kind,payee_id,
  requested_by_user_id,connected_account_id,bank_destination_id,
  amount_minor::text,state,stripe_payout_id,
  reviewed_by_user_id,approved_by_user_id
  FROM tala_live_treasury_withdrawals WHERE id=$1`,[id]);
 const w=r.rows[0];
 if(!w||!['restaurant','driver'].includes(w.payee_kind))fail('RC128_PAYOUT_NOT_FOUND');
 approved(w);
 if(w.stripe_payout_id!==null||!Number.isSafeInteger(w.requested_by_user_id)||
  w.requested_by_user_id===w.reviewed_by_user_id||
  w.requested_by_user_id===w.approved_by_user_id)
  fail('RC128_PAYOUT_ALREADY_SENT_OR_SELF_APPROVED');
 const owner=await roleOwner(w.payee_kind,w.payee_id);
 if(owner.user_id!==w.requested_by_user_id)fail('RC128_PAYEE_OWNER_CHANGED');
 await connectedAccount(w.connected_account_id,owner);
 const snapshot=await auditedSnapshot(pool,stripe,{
  kind:w.payee_kind,id:w.payee_id,ownerId:owner.user_id,
  account:w.connected_account_id,approved:true,ownerEmail:owner.email
 },false,id);
 const amount=number(w.amount_minor);
 if(!snapshot.eligible||snapshot.withdrawableMinor<BigInt(amount)||
  snapshot.serverOnly.bankId!==w.bank_destination_id)
  fail('RC128_VERIFIED_TEST_PAYOUT_BALANCE_HOLD');
 return Number(snapshot.withdrawableMinor);
}
try{
 if(kind==='transfer'){
  const input=await transferInput();
  if(mode==='--plan')console.log('RC128_REAL_STRIPE_TEST_TRANSFER_READINESS=PASS_READ_ONLY');
  else{
   const r=await dispatchTreasuryTransfer(pool,stripe,id,input,true);
   console.log('RC128_STRIPE_TEST_TRANSFER_STATE='+r.state.toUpperCase());
   if(r.state==='unknown')process.exitCode=2;
  }
 }else{
  const verified=await payoutAvailable();
  if(mode==='--plan')console.log('RC128_REAL_STRIPE_TEST_PAYOUT_READINESS=PASS_READ_ONLY');
  else{
   const r=await dispatchTreasuryWithdrawal(pool,stripe,id,verified,true);
   console.log('RC128_STRIPE_TEST_PAYOUT_STATE='+r.state.toUpperCase());
   if(r.state==='unknown')process.exitCode=2;
  }
 }
 console.log('RC128_ENV=ISOLATED_STAGING_STRIPE_TEST_ONLY');
}finally{await pool.end();}
