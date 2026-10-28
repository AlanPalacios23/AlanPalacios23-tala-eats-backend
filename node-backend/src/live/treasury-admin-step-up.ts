/**
 * Fresh administrator TOTP step-up for every treasury review/approval.
 *
 * The JWT's mfa=true only proves MFA at login (possibly hours ago).
 * A transfer or payout review additionally requires a fresh one-time TOTP
 * and the accepted 30-second counter is persisted with UNIQUE(admin, step)
 * across all treasury operations. No PINs, passwords or OTPs are stored.
 * LIVE release lock is enforced by the HTTP caller, before this function.
 */
import type {Pool} from 'pg';
import {verifiedTotpCounter} from '../auth/crypto.js';

export type TreasuryAdminAction=
 'withdrawal_review'|'withdrawal_approve'|'transfer_review'|'transfer_approve';
const actions=new Set<TreasuryAdminAction>([
 'withdrawal_review','withdrawal_approve','transfer_review','transfer_approve'
]);
export async function consumeTreasuryAdminOtp(
 pool:Pool,adminId:number,otp:string,action:TreasuryAdminAction,target:string,
 nowSeconds=Math.floor(Date.now()/1000)
):Promise<{adminId:number;counter:number}>{
 if(!Number.isSafeInteger(adminId)||adminId<1||
    !/^[0-9]{6}$/.test(otp)||!actions.has(action)||
    !/^[1-9][0-9]{0,15}(?::(?:restaurant|driver):[1-9][0-9]{0,15})?$/.test(target)||
    !Number.isSafeInteger(nowSeconds)||nowSeconds<0)
  throw Error('TREASURY_ADMIN_STEP_UP_INVALID');
 const client=await pool.connect();let began=false;
 try{
  await client.query('BEGIN');began=true;
  // Lock the admin record across processes, even if the same OTP is submitted
  // to different endpoints in the same 30-second interval.
  const users=await client.query<{role:string;is_active:boolean;
    two_factor_enabled:boolean;totp_secret:string|null}>(
   'SELECT role,is_active,two_factor_enabled,totp_secret FROM users WHERE id=$1 FOR UPDATE',
   [adminId]);
  const user=users.rows[0];
  if(!user||user.role!=='admin'||!user.is_active||
     !user.two_factor_enabled||!user.totp_secret)
   throw Error('TREASURY_ADMIN_STEP_UP_NOT_AUTHORIZED');
  const counter=verifiedTotpCounter(user.totp_secret,otp,nowSeconds);
  if(counter===null)throw Error('TREASURY_ADMIN_TOTP_INVALID');
  const claim=await client.query(
   'INSERT INTO tala_live_treasury_admin_steps(admin_user_id,otp_step,action_kind,target_key) VALUES($1,$2,$3,$4) ON CONFLICT(admin_user_id,otp_step) DO NOTHING',
   [adminId,String(counter),action,target]);
  if(claim.rowCount!==1)throw Error('TREASURY_ADMIN_TOTP_ALREADY_USED');
  await client.query('COMMIT');began=false;
  return {adminId,counter};
 }catch(err){
  if(began)await client.query('ROLLBACK').catch(()=>{});
  throw err;
 }finally{client.release();}
}
