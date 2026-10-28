/** Local HMAC-signed Connect payout E2E against disposable PostgreSQL.
 * Does NOT use Stripe API credentials, does NOT contact Stripe or Kali.
 */
import Stripe from 'stripe';
import {Pool} from 'pg';
import {randomUUID,createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {ingestTreasurySignedEvent,persistTreasurySignedEvent,
 reconcileOneTreasuryEvent} from '../dist/live/treasury-connect-webhook.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const provider=new Stripe('sk_test_CIOnlyValidFormatNotReal123456',{maxNetworkRetries:0});
const secret='whsec_CIOnlyDisposableSigningSecret123456';
const now=Math.floor(Date.now()/1000);
const stamp=(raw)=>`t=${now},v1=${createHmac('sha256',secret).update(String(now)+'.'+raw).digest('hex')}`;
const event=(id,payout,account)=>JSON.stringify({
 id,type:'payout.paid',created:now,livemode:true,account,
 api_version:'2026-09-30.clover',pending_webhooks:1,
 data:{object:{id:payout,object:'payout'}}});
const user=async(label,role)=>{
 const e=label+'-'+randomUUID().slice(0,10)+'@example.test';
 return (await pool.query('INSERT INTO users(name,email,role) VALUES($1,$2,$3) RETURNING id',
  [label,e,role])).rows[0].id;
};
try{
 const payee=await user('connected-driver','driver');
 const reviewer=await user('treasury-reviewer','admin');
 const approver=await user('treasury-approver','admin');
 const account='acct_SYNTHETIC'+randomUUID().replaceAll('-','').slice(0,8);
 const payout='po_SYNTHETIC'+randomUUID().replaceAll('-','').slice(0,8);
 const bank='ba_SYNTHETIC'+randomUUID().replaceAll('-','').slice(0,8);
 const created=await pool.query(
  "INSERT INTO tala_live_treasury_withdrawals(payee_kind,payee_id,requested_by_user_id,connected_account_id,bank_destination_id,amount_minor,client_key,totp_step,state,stripe_payout_id,reviewed_by_user_id,approved_by_user_id) VALUES('driver',$1,$2,$3,$4,1200,$5,$6,'submitted',$7,$8,$9) RETURNING id::text",
  [payee,payee,account,bank,randomUUID(),String(now),payout,reviewer,approver]);
 const id=created.rows[0].id;
 const evtId='evt_SYNTHETIC'+randomUUID().replaceAll('-','').slice(0,9);
 const raw=event(evtId,payout,account);
 const parsed=ingestTreasurySignedEvent(Buffer.from(raw),stamp(raw),provider,secret);
 assert.ok(parsed);
 assert.deepEqual(await persistTreasurySignedEvent(pool,parsed),{queued:true});
 await assert.rejects(async()=>ingestTreasurySignedEvent(
  Buffer.from(raw),'t='+now+',v1='+('0'.repeat(64)),provider,secret));
 const fake={
  payouts:{retrieve:async(idArg,_params,options)=>{
   assert.equal(idArg,payout);
   assert.equal(options.stripeAccount,account);
   return {id:payout,livemode:true,automatic:false,currency:'mxn',amount:1200,
    destination:bank,status:'paid',metadata:{
     tala_treasury_withdrawal:id,tala_payee_kind:'driver',tala_payee_id:String(payee)
    }};
  }}
 };
 assert.equal(await reconcileOneTreasuryEvent(pool,fake,evtId),'processed');
 assert.equal(await reconcileOneTreasuryEvent(pool,fake,evtId),'processed');
 assert.deepEqual(await persistTreasurySignedEvent(pool,parsed),{queued:false});
 const result=await pool.query(
  'SELECT state,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1',[id]);
 assert.equal(result.rows[0].state,'paid');
 assert.equal(result.rows[0].stripe_payout_id,payout);
 const ledger=await pool.query(
  'SELECT kind,amount_minor::text FROM tala_live_treasury_ledger WHERE withdrawal_id=$1',[id]);
 assert.equal(ledger.rows.length,1);
 assert.equal(ledger.rows[0].kind,'bank_payout_paid');
 assert.equal(ledger.rows[0].amount_minor,'1200');
 const unknownEvt='evt_SYNTHETIC'+randomUUID().replaceAll('-','').slice(0,9);
 const rawOther=event(unknownEvt,'po_UNKNOWN12345',account);
 const recordOther=ingestTreasurySignedEvent(Buffer.from(rawOther),stamp(rawOther),provider,secret);
 await persistTreasurySignedEvent(pool,recordOther);
 const wrong={payouts:{retrieve:async()=>({
  id:'po_UNKNOWN12345',livemode:true,automatic:false,currency:'mxn',amount:1200,
  destination:bank,status:'paid',metadata:{
   tala_treasury_withdrawal:'999999999',tala_payee_kind:'driver',tala_payee_id:String(payee)}
 })}};
 await assert.rejects(reconcileOneTreasuryEvent(pool,wrong,unknownEvt),/UNKNOWN_BANK_PAYOUT/);
 const hold=await pool.query('SELECT state FROM tala_live_treasury_events WHERE event_id=$1',[unknownEvt]);
 assert.equal(hold.rows[0].state,'received');
 console.log('STRIPE_CONNECT_HMAC_PG15_RECONCILIATION_PASS');
 console.log('MOCK_STRIPE_CALLS_ONLY=TRUE LIVE_PAYOUTS_CREATED=0');
}finally{await pool.end();}
