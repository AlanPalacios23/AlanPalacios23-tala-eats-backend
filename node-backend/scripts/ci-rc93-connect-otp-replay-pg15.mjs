/** PostgreSQL 15 RC93 replay test. NEVER connects to LIVE. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {requireTreasuryBankStepUp} from '../dist/live/treasury-connect-step-up.js';
import {totpForTestOnly} from '../dist/auth/crypto.js';

const url=new URL(process.env.DATABASE_URL??'');
if(url.hostname!=='127.0.0.1'||url.port!=='15445'||url.pathname!=='/rc9_ci'||
   url.username!=='rc9_ci'||process.env.NODE_ENV==='production'){
 throw Error('RC93_REPLAY_CI_ONLY');
}
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,
 connectionTimeoutMillis:4000,statement_timeout:10000});
try{
 const secret='JBSWY3DPEHPK3PXP';
 const owner=(await pool.query(
  "INSERT INTO users(name,email,role,two_factor_enabled,totp_secret) VALUES($1,$2,$3,true,$4) RETURNING id",
  ['RC93 test',randomUUID()+'@example.test','restaurant',secret])).rows[0].id;
 const s={userId:owner,mfaVerified:true,
  user:{isActive:true,twoFactorEnabled:true,totpSecret:secret}};
 const code=totpForTestOnly(secret,Math.floor(Date.now()/1000));
 const calls=await Promise.allSettled([
  requireTreasuryBankStepUp(pool,s,code),
  requireTreasuryBankStepUp(pool,s,code)
 ]);
 assert.equal(calls.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(calls.filter(x=>x.status==='rejected'&&
  /CONNECT_FRESH_TOTP_ALREADY_USED/.test(String(x.reason))).length,1);
 const consumed=await pool.query(
  'SELECT otp_counter,purpose FROM tala_live_connect_otp_consumptions WHERE user_id=$1',
  [owner]);
 assert.equal(consumed.rows.length,1);
 assert.equal(consumed.rows[0].purpose,'bank_step_up');
 const attempts=await pool.query(
  'SELECT count(*)::int AS n FROM tala_live_treasury_totp_attempts WHERE user_id=$1',
  [owner]);
 assert.equal(attempts.rows[0].n,2);
 // Explicit DB uniqueness must reject a third duplicate even when callers
 // have separate API connections.
 const conflict=await pool.query(
  "INSERT INTO tala_live_connect_otp_consumptions(user_id,otp_counter,purpose) VALUES($1,$2,'bank_step_up') ON CONFLICT(user_id,otp_counter) DO NOTHING RETURNING id",
  [owner,String(consumed.rows[0].otp_counter)]);
 assert.equal(conflict.rowCount,0);
 console.log('RC93_POSTGRES_DURABLE_TOTP_REPLAY=PASS');
}finally{await pool.end();}
