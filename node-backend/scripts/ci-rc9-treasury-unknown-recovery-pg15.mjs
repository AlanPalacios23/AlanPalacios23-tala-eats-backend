/** Unknown Stripe payout timeout recovery: isolated PostgreSQL + fake
 * read-only provider. No Stripe credentials, payouts.create or external calls.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {recoverUnknownTreasuryPayout} from '../dist/live/treasury-unknown-recovery.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const account='acct_RECOVERY'+randomUUID().replaceAll('-','').slice(0,9);
const bank='ba_RECOVERY'+randomUUID().replaceAll('-','').slice(0,9);
const newUser=async()=>{
 const email='recovery-'+randomUUID().slice(0,10)+'@example.test';
 return (await pool.query(
  "INSERT INTO users(name,email,role) VALUES('Treasury Recovery QA',$1,'driver') RETURNING id",
  [email])).rows[0].id;
};
const insert=async(user,accountId=account)=>{
 const row=await pool.query(
  "INSERT INTO tala_live_treasury_withdrawals(payee_kind,payee_id,requested_by_user_id,connected_account_id,bank_destination_id,amount_minor,client_key,totp_step,state) VALUES('driver',$1,$1,$2,$3,1900,$4,$5,'unknown') RETURNING id::text",
  [user,accountId,bank,randomUUID(),String(Date.now())]);
 return row.rows[0].id;
};
const payout=(id,user,withdrawalId,status='pending')=>({
 id,livemode:false,automatic:false,currency:'mxn',amount:1900,
 destination:bank,status,metadata:{
  tala_treasury_withdrawal:withdrawalId,tala_payee_kind:'driver',
  tala_payee_id:String(user)}
});
const provider=(pages)=>{
 let calls=0;
 return {payouts:{list:async(_params,opts)=>{
  calls++;
  assert.equal(opts.stripeAccount,account);
  return pages[Math.min(calls-1,pages.length-1)];
 }},get count(){return calls}};
};
try{
 const user=await newUser();
 const id=await insert(user);
 const po='po_RECOVERY'+randomUUID().replaceAll('-','').slice(0,7);
 const miss=provider([{data:[],has_more:false}]);
 assert.equal(await recoverUnknownTreasuryPayout(pool,miss,id),'unknown');
 assert.equal((await pool.query('SELECT state FROM tala_live_treasury_withdrawals WHERE id=$1',[id])).rows[0].state,'unknown');
 const hit=provider([{data:[payout(po,user,id)],has_more:false}]);
 assert.equal(await recoverUnknownTreasuryPayout(pool,hit,id),'submitted');
 assert.equal(await recoverUnknownTreasuryPayout(pool,hit,id),'already_resolved');
 const saved=(await pool.query('SELECT state,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1',[id])).rows[0];
 assert.deepEqual(saved,{state:'submitted',stripe_payout_id:po});
 const secondUser=await newUser(),secondId=await insert(secondUser);
 const paidPo='po_RECOVERY'+randomUUID().replaceAll('-','').slice(0,7);
 const terminal=provider([{data:[payout(paidPo,secondUser,secondId,'paid')],has_more:false}]);
 assert.equal(await recoverUnknownTreasuryPayout(pool,terminal,secondId),'terminal_event_pending');
 const paidState=(await pool.query('SELECT state,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1',[secondId])).rows[0];
 assert.deepEqual(paidState,{state:'unknown',stripe_payout_id:paidPo});
 // Even a remotely paid payout is NEVER settled by unsigned polling.
 assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM tala_live_treasury_ledger WHERE withdrawal_id=$1',[secondId])).rows[0].n,0);
 const thirdUser=await newUser(),thirdId=await insert(thirdUser);
 const foreign=provider([{data:[{...payout('po_WRONG01',thirdUser,thirdId),destination:'ba_OTHER'}],has_more:false}]);
 await assert.rejects(recoverUnknownTreasuryPayout(pool,foreign,thirdId),/FOREIGN_OR_ALTERED/);
 const duplicated=provider([{data:[payout('po_DOUBLE01',thirdUser,thirdId),payout('po_DOUBLE02',thirdUser,thirdId)],has_more:false}]);
 await assert.rejects(recoverUnknownTreasuryPayout(pool,duplicated,thirdId),/MULTIPLE_PAYOUTS/);
 const pages=provider([{data:[payout('po_UNRELATED01',thirdUser,'999999')],has_more:true},
  {data:[],has_more:false}]);
 assert.equal(await recoverUnknownTreasuryPayout(pool,pages,thirdId),'unknown');
 const stillUnknown=(await pool.query('SELECT state,stripe_payout_id FROM tala_live_treasury_withdrawals WHERE id=$1',[thirdId])).rows[0];
 assert.deepEqual(stillUnknown,{state:'unknown',stripe_payout_id:null});
 console.log('TREASURY_UNKNOWN_PAYOUT_READONLY_RECOVERY_PG15_PASS');
 console.log('PAYOUT_CREATE_CALLS=0 BANK_SETTLEMENT_BY_POLLING=0');
}finally{await pool.end();}
