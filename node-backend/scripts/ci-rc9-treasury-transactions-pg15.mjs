/**
 * Ephemeral PostgreSQL 15 integration of two-beneficiary reservations.
 * Uses only disposable CI database. NO STRIPE HTTP, NO bank movements.
 */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {totpForTestOnly} from '../dist/auth/crypto.js';
import {reserveTreasuryWithdrawal} from '../dist/live/treasury-reservations.js';
import {approveTreasuryWithdrawal} from '../dist/live/treasury-dual-approval.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5});
const secret='JBSWY3DPEHPK3PXP';
const nowMs=Date.now();
const owner=async(name,role,totp=true)=>{
 const x=await pool.query(
  "INSERT INTO users(name,email,role,two_factor_enabled,totp_secret) VALUES($1,$2,$3,$4,$5) RETURNING id",
  [name,name.toLowerCase().replaceAll(' ','')+randomUUID().slice(0,8)+'@example.test',role,totp,secret]);
 return x.rows[0].id;
};
try{
 await pool.query('SET statement_timeout=12000');
 const restaurantOwner=await owner('Seller QA','restaurant');
 const driver=await owner('Driver QA','driver');
 const reviewer=await owner('Reviewer QA','admin');
 const approver=await owner('Approver QA','admin');
 const buyer=await owner('Buyer QA','customer',false);
 const rid=(await pool.query("INSERT INTO restaurants(name,owner_id) VALUES('Treasury Fixture',$1) RETURNING id",[restaurantOwner])).rows[0].id;
 await pool.query("INSERT INTO driver_profiles(user_id,is_verified) VALUES($1,true)",[driver]);
 await pool.query("INSERT INTO tala_live_merchant_accounts(restaurant_id,stripe_account_id,registered_by_user_id,owner_approved_at) VALUES($1,$2,$3,NOW())",[rid,'acct_QARESTAURANT1',reviewer]);
 await pool.query("INSERT INTO tala_live_driver_accounts(user_id,stripe_account_id,registered_by_user_id,owner_approved_at) VALUES($1,$2,$3,NOW())",[driver,'acct_QADRIVER1',reviewer]);
 const order=(await pool.query("INSERT INTO orders(user_id,restaurant_id,address,status,payment_method,payment_status,total) VALUES($1,$2,'TEST','delivered','stripe','paid',100.00) RETURNING id",[buyer,rid])).rows[0].id;
 await pool.query("INSERT INTO tala_live_treasury_transfers(order_id,payee_kind,payee_id,connected_account_id,source_charge_id,amount_minor,state,idempotency_key,stripe_transfer_id) VALUES($1,'restaurant',$2,'acct_QARESTAURANT1','ch_QAR1',7000,'completed',$3,'tr_QARESTAURANT1')",[order,rid,'qa-restaurant-'+order]);
 await pool.query("INSERT INTO tala_live_treasury_transfers(order_id,payee_kind,payee_id,connected_account_id,source_charge_id,amount_minor,state,idempotency_key,stripe_transfer_id) VALUES($1,'driver',$2,'acct_QADRIVER1','ch_QAD1',2000,'completed',$3,'tr_QADRIVER1')",[order,driver,'qa-driver-'+order]);
 const make=(kind,id,uid,account,amount)=>({
  snapshot:{kind,payeeId:id,ownerId:uid,accountId:account,bankId:'ba_QABANK1',
   transferredMinor:BigInt(amount),stripeAvailableMinor:BigInt(amount),
   ownerApproved:true,connectReady:true,bankVerified:true,scheduleManual:true,
   openCases:0,unrecognizedPayouts:0,pendingTransfers:0},
  actorUserId:uid,totp:totpForTestOnly(secret,Math.floor(nowMs/1000)),
  clientKey:randomUUID(),amountMinor:500n,nowMs
 });
 const seller=make('restaurant',rid,restaurantOwner,'acct_QARESTAURANT1',7000);
 const driverRequest=make('driver',driver,driver,'acct_QADRIVER1',2000);
 const first=await reserveTreasuryWithdrawal(pool,seller);
 assert.equal(first.created,true);
 const repeat=await reserveTreasuryWithdrawal(pool,seller);
 assert.equal(repeat.created,false);
 assert.equal(repeat.id,first.id);
 await assert.rejects(reserveTreasuryWithdrawal(pool,{...seller,clientKey:randomUUID()}),
  /unique|duplicate|TREASURY_REQUEST_HOLD/);
 const courier=await reserveTreasuryWithdrawal(pool,driverRequest);
 assert.equal(courier.created,true);
 assert.notEqual(courier.id,first.id);
 for(const id of [first.id,courier.id]){
  await assert.rejects(approveTreasuryWithdrawal(pool,id,reviewer,false,'review'),
   /APPROVER_MFA_REQUIRED/);
  await assert.rejects(approveTreasuryWithdrawal(pool,id,reviewer,true,'approve'),
   /DUAL_APPROVAL_REQUIRED/);
  assert.equal((await approveTreasuryWithdrawal(pool,id,reviewer,true,'review')).state,'reviewed');
  await assert.rejects(approveTreasuryWithdrawal(pool,id,reviewer,true,'approve'),
   /DUAL_APPROVAL_REQUIRED/);
  assert.equal((await approveTreasuryWithdrawal(pool,id,approver,true,'approve')).state,'approved');
 }
 const status=await pool.query("SELECT state,reviewed_by_user_id,approved_by_user_id FROM tala_live_treasury_withdrawals WHERE id IN ($1,$2)",[first.id,courier.id]);
 assert.equal(status.rows.length,2);
 assert.ok(status.rows.every(x=>x.state==='reserved'&&x.reviewed_by_user_id===reviewer&&x.approved_by_user_id===approver));
 console.log('TREASURY_DUAL_PAYEE_PG15_TRANSACTIONAL_RESERVATION_PASS');
}finally{await pool.end();}
