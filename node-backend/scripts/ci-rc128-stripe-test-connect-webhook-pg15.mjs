/** RC12.8 — actual Stripe SDK HMAC verification + PG15 reconciliation
 * for TEST-mode Connect payouts. Only local SDK cryptography and provider
 * reads mocked; no Stripe credentials/network or production database.
 */
import Stripe from 'stripe';
import {Pool} from 'pg';
import {randomUUID,createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {ingestTreasurySignedEvent,persistTreasurySignedEvent,
 reconcileOneTreasuryEvent} from '../dist/live/treasury-connect-webhook.js';
import {decideConnectedPayoutEvent} from '../dist/live/treasury-webhook-policy.js';
assert.equal(process.env.NODE_ENV,'staging','NO_PRODUCTION_ENV');
const db=new URL(process.env.DATABASE_URL);
assert.equal(db.hostname,'127.0.0.1');assert.equal(db.port,'15435');
assert.equal(db.pathname,'/tala_node_stage');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const stripe=new Stripe('sk_test_CIOnlyNotNetworkCredential0123456789',{maxNetworkRetries:0});
const secret='whsec_RC128NonProductionOnlySignatures01234567';
const now=Math.floor(Date.now()/1000);
const signature=raw=>'t='+now+',v1='+createHmac('sha256',secret)
 .update(now+'.'+raw).digest('hex');
const event=(eventId,payout,account,livemode=false)=>JSON.stringify({
 id:eventId,type:'payout.paid',created:now,livemode,account,
 api_version:'2026-09-30.clover',pending_webhooks:1,
 data:{object:{id:payout,object:'payout'}}});
const name=()=>randomUUID().replaceAll('-','').slice(0,13);
const user=async(role)=>Number((await pool.query(
 'INSERT INTO users(name,email,role) VALUES($1,$2,$3) RETURNING id',
 ['RC128 TEST',role+'-'+name()+'@example.test',role])).rows[0].id);
try{
 const review=await user('admin'),approve=await user('admin');
 const payees=[{kind:'restaurant',id:await user('restaurant')},
  {kind:'driver',id:await user('driver')}];
 for(const x of payees){
  const acct='acct_RC128'+name(),bank='ba_RC128'+name(),payout='po_RC128'+name();
  const amount=x.kind==='restaurant'?6500:3200;
  const rec=await pool.query(
   "INSERT INTO tala_live_treasury_withdrawals(payee_kind,payee_id,requested_by_user_id,connected_account_id,bank_destination_id,amount_minor,client_key,totp_step,state,stripe_payout_id,reviewed_by_user_id,approved_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,$10,$11) RETURNING id::text",
   [x.kind,x.id,x.id,acct,bank,amount,randomUUID(),String(now),payout,review,approve]);
  const withdrawId=rec.rows[0].id,eventId='evt_RC128'+name();
  const raw=event(eventId,payout,acct);
  const read=ingestTreasurySignedEvent(Buffer.from(raw),signature(raw),stripe,secret,false);
  assert.equal(read?.eventId,eventId);
  assert.deepEqual(await persistTreasurySignedEvent(pool,read),{queued:true});
  await assert.rejects(async()=>ingestTreasurySignedEvent(
   Buffer.from(raw),signature(raw),stripe,secret),/CONNECT_WEBHOOK_LIVE_IDENTITY_INVALID/);
  const fake={payouts:{retrieve:async(id,_params,opts)=>{
   assert.equal(id,payout);assert.equal(opts.stripeAccount,acct);
   return {id:payout,livemode:false,automatic:false,currency:'mxn',amount,
    destination:bank,status:'paid',metadata:{
     tala_treasury_withdrawal:withdrawId,tala_payee_kind:x.kind,
     tala_payee_id:String(x.id)}};
  }}};
  // The LIVE policy must reject a TEST payout unless TEST is explicitly chosen.
  assert.throws(()=>decideConnectedPayoutEvent({
   eventId,eventType:'payout.paid',livemode:false,accountId:acct,
   payoutId:payout,amountMinor:amount,currency:'mxn',
   providerDestination:bank,metadata:{withdrawalId:withdrawId,
    payeeKind:x.kind,payeeId:String(x.id)},remoteStatus:'paid'
  },{id:withdrawId,state:'submitted',payeeKind:x.kind,payeeId:x.id,
    accountId:acct,bankDestination:bank,amountMinor:amount,payoutId:payout}),
   /TREASURY_SIGNED_EVENT_MISMATCH/);
  await assert.rejects(reconcileOneTreasuryEvent(pool,fake,eventId),
   /TREASURY_FOREIGN_PAYOUT_HOLD/);
  assert.equal(await reconcileOneTreasuryEvent(pool,fake,eventId,false),'processed');
  assert.equal(await reconcileOneTreasuryEvent(pool,fake,eventId,false),'processed');
  assert.deepEqual(await persistTreasurySignedEvent(pool,read),{queued:false});
  const status=await pool.query(
   'SELECT state,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1',[withdrawId]);
  assert.equal(status.rows[0].state,'paid');assert.equal(status.rows[0].stripe_payout_id,payout);
  const journal=await pool.query(
   'SELECT amount_minor::text,kind FROM tala_live_treasury_ledger WHERE withdrawal_id=$1',
   [withdrawId]);
  assert.equal(journal.rows.length,1);assert.equal(journal.rows[0].amount_minor,String(amount));
  assert.equal(journal.rows[0].kind,'bank_payout_paid');
 }
 console.log('RC128_SIGNED_STRIPE_TEST_RECONCILIATION_PG15=PASS');
 console.log('RC128_PAYEES=RESTAURANT_AND_DRIVER');
 console.log('RC128_REAL_STRIPE_API_WRITES=ZERO');
}finally{await pool.end();}
