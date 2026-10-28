/** Real disposable PostgreSQL one-time ADMIN step-up test.
 * No Stripe requests. Exercises replay across withdrawals and transfers,
 * incorrect OTP and different administrators.
 */
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {totpForTestOnly,verifiedTotpCounter} from '../dist/auth/crypto.js';
import {consumeTreasuryAdminOtp} from '../dist/live/treasury-admin-step-up.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5});
const secret='JBSWY3DPEHPK3PXP';
const now=Math.floor(Date.now()/1000);
const make=async(role='admin')=>{
 const email='treasury-step-'+randomUUID().slice(0,10)+'@example.test';
 return (await pool.query(
  'INSERT INTO users(name,email,role,two_factor_enabled,totp_secret) VALUES($1,$2,$3,true,$4) RETURNING id',
  ['Admin Step QA',email,role,secret])).rows[0].id;
};
try{
 const admin=await make(),another=await make(),driver=await make('driver');
 const otp=totpForTestOnly(secret,now);
 const next=totpForTestOnly(secret,now+30);
 const accepted=await consumeTreasuryAdminOtp(
  pool,admin,otp,'withdrawal_review','123',now);
 assert.equal(accepted.adminId,admin);
 await assert.rejects(consumeTreasuryAdminOtp(
  pool,admin,otp,'transfer_approve','200:driver:300',now),
  /TOTP_ALREADY_USED/);
 await assert.rejects(consumeTreasuryAdminOtp(
  pool,admin,'111111','withdrawal_approve','123',now),
  /TOTP_INVALID|TOTP_ALREADY_USED/);
 await assert.rejects(consumeTreasuryAdminOtp(
  pool,driver,otp,'transfer_review','200:restaurant:300',now),
  /NOT_AUTHORIZED/);
 const other=await consumeTreasuryAdminOtp(
  pool,another,otp,'withdrawal_approve','123',now);
 assert.equal(other.adminId,another);
 const second=await consumeTreasuryAdminOtp(
  pool,admin,next,'transfer_review','200:driver:300',now+30);
 assert.ok(second.counter>accepted.counter);
 const result=await pool.query(
  'SELECT action_kind,target_key,otp_step::text FROM tala_live_treasury_admin_steps WHERE admin_user_id=$1 ORDER BY otp_step',
  [admin]);
 assert.equal(result.rows.length,2);
 assert.equal(result.rows[0].action_kind,'withdrawal_review');
 assert.equal(result.rows[1].action_kind,'transfer_review');
 const blocked=await make();
 const wrong=Array.from({length:100},(_,i)=>String(i).padStart(6,'0'))
  .find(code=>verifiedTotpCounter(secret,code,now)===null);
 assert.ok(wrong);
 for(let i=0;i<5;i++){
  await assert.rejects(consumeTreasuryAdminOtp(
   pool,blocked,wrong,'withdrawal_review','500',now),/TOTP_INVALID/);
 }
 await assert.rejects(consumeTreasuryAdminOtp(
  pool,blocked,otp,'withdrawal_review','500',now),/TOTP_RATE_LIMITED/);
 const attempts=await pool.query(
  'SELECT COUNT(*)::int AS total FROM tala_live_treasury_totp_attempts WHERE user_id=$1',
  [blocked]);
 assert.equal(attempts.rows[0].total,5,'failed OTP checks must not vanish on rollback');
 console.log('TREASURY_ADMIN_FRESH_TOTP_PG15_PASS');
 console.log('TREASURY_OTP_BRUTE_FORCE_LIMIT_PG15_PASS');
 console.log('REPLAY_ACROSS_ENDPOINTS=BLOCKED SESSION_ONLY_MFA=INSUFFICIENT');
}finally{await pool.end();}
