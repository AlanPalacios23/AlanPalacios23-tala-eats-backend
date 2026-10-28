/**
 * Shared financial step-up guard.
 *
 * Every route creating a Stripe Connect onboarding link or approving a
 * beneficiary must require a fresh six-digit TOTP, not merely an old
 * access token bearing an MFA claim. Invalid attempts are persisted before
 * verification and limited across all API workers through PostgreSQL.
 *
 * No payouts, transfers, DB schema changes or account approval by redirect.
 */
import type {Pool} from 'pg';
import {verifiedTotpCounter} from '../auth/crypto.js';
import {recordTreasuryOtpAttempt} from './treasury-totp-rate-limit.js';

export type BankStepUpSession={
 userId:number;
 mfaVerified:boolean;
 user:{isActive:boolean;twoFactorEnabled:boolean;totpSecret:string|null};
};

export async function requireTreasuryBankStepUp(
 pool:Pool,session:BankStepUpSession,rawOtp:unknown
):Promise<void>{
 if(!session.user.isActive||!session.user.twoFactorEnabled||
    !session.mfaVerified||typeof session.user.totpSecret!=='string'||
    session.user.totpSecret.length<8||
    typeof rawOtp!=='string'||!/^[0-9]{6}$/.test(rawOtp))
  throw Error('CONNECT_FRESH_TOTP_REQUIRED');
 // Failed codes must consume a durable shared attempt; Redis or this HTTP
 // process alone are not reliable evidence for financial step-up.
 await recordTreasuryOtpAttempt(pool,session.userId,'withdrawal_request');
 const counter=verifiedTotpCounter(session.user.totpSecret,rawOtp,
  Math.floor(Date.now()/1000));
 if(counter===null)throw Error('CONNECT_FRESH_TOTP_INVALID');
 // Durable replay protection: the same accepted counter cannot approve two
 // financial identity changes, even across requests or different PM2 workers.
 // No OTP or TOTP secret is stored, only the user ID and accepted time step.
 const consumed=await pool.query(
  "INSERT INTO tala_live_connect_otp_consumptions(user_id,otp_counter,purpose) VALUES($1,$2,'bank_step_up') ON CONFLICT (user_id,otp_counter) DO NOTHING RETURNING id",
  [session.userId,String(counter)]);
 if(consumed.rowCount!==1)throw Error('CONNECT_FRESH_TOTP_ALREADY_USED');
}
