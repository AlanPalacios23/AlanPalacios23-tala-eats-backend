/**
 * Fail-closed distributed rate limit for financial TOTP attempts.
 *
 * Authentication OTP checks in banking must count FAILURES as well as
 * successes. A separate DB transaction commits the attempt BEFORE verifying
 * the code, so rolling back a withdrawal cannot erase bad-code evidence.
 * PostgreSQL advisory lock serializes concurrent requests per user.
 * This is NOT tied to any HTTP worker or client IP.
 */
import type {Pool} from 'pg';
export type TreasuryOtpPurpose='withdrawal_request'|'admin_money_review';
export const TREASURY_TOTP_MAX_ATTEMPTS=5;
export async function recordTreasuryOtpAttempt(
 pool:Pool,userId:number,purpose:TreasuryOtpPurpose
):Promise<void>{
 if(!Number.isSafeInteger(userId)||userId<=0||
   !['withdrawal_request','admin_money_review'].includes(purpose))
  throw Error('TREASURY_TOTP_ATTEMPT_INVALID');
 const client=await pool.connect();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
   ['treasury:totp:attempt:'+userId]);
  const result=await client.query<{attempts:string}>(
   "SELECT COUNT(*)::text AS attempts FROM tala_live_treasury_totp_attempts WHERE user_id=$1 AND attempted_at > NOW()-INTERVAL '10 minutes'",
   [userId]);
  const count=Number(result.rows[0]?.attempts);
  if(!Number.isSafeInteger(count)||count>=TREASURY_TOTP_MAX_ATTEMPTS)
   throw Error('TREASURY_TOTP_RATE_LIMITED');
  const inserted=await client.query(
   'INSERT INTO tala_live_treasury_totp_attempts(user_id,action_kind) VALUES($1,$2)',
   [userId,purpose]);
  if(inserted.rowCount!==1)throw Error('TREASURY_TOTP_ATTEMPT_NOT_DURABLE');
  await client.query('COMMIT');begun=false;
 }catch(err){if(begun)await client.query('ROLLBACK').catch(()=>{});throw err;}
 finally{client.release();}
}
