/**
 * RC9: TWO DIFFERENT administrator MFA approvals, with user ownership
 * separate from the requesting restaurant/driver. DB is the source of truth.
 * Does not create a Stripe payout; no HTTP route until the treasury release.
 */
import type {Pool} from 'pg';
const valid=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<1e9;
export async function approveTreasuryWithdrawal(
 pool:Pool,withdrawalId:string,adminId:number,mfaVerified:boolean,
 phase:'review'|'approve'
):Promise<{state:'reviewed'|'approved';id:string}>{
 if(!/^[1-9][0-9]{0,15}$/.test(withdrawalId)||!valid(adminId)||
    !mfaVerified||!['review','approve'].includes(phase))
  throw Error('TREASURY_APPROVER_MFA_REQUIRED');
 const client=await pool.connect();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  const auth=await client.query<{role:string;is_active:boolean;two_factor_enabled:boolean}>(
   'SELECT role,is_active,two_factor_enabled FROM users WHERE id=$1 FOR UPDATE',[adminId]);
  if(auth.rows.length!==1||auth.rows[0]?.role!=='admin'||
     !auth.rows[0]?.is_active||!auth.rows[0]?.two_factor_enabled)
   throw Error('TREASURY_APPROVER_IDENTITY_INVALID');
  const result=await client.query<{id:string;state:string;requested_by_user_id:number;
   reviewed_by_user_id:number|null;approved_by_user_id:number|null}>(
   'SELECT id::text,state,requested_by_user_id,reviewed_by_user_id,approved_by_user_id FROM tala_live_treasury_withdrawals WHERE id=$1 FOR UPDATE',
   [withdrawalId]);
  const x=result.rows[0];
  if(!x||x.state!=='reserved'||x.requested_by_user_id===adminId)
   throw Error('TREASURY_WITHDRAWAL_NOT_REVIEWABLE');
  if(phase==='review'){
   if(x.reviewed_by_user_id!==null||x.approved_by_user_id!==null)
    throw Error('TREASURY_ALREADY_REVIEWED');
   const a=await client.query(
    'UPDATE tala_live_treasury_withdrawals SET reviewed_by_user_id=$2,updated_at=NOW() WHERE id=$1 AND state=$3 AND reviewed_by_user_id IS NULL AND approved_by_user_id IS NULL',
    [withdrawalId,adminId,'reserved']);
   if(a.rowCount!==1)throw Error('TREASURY_REVIEW_RACE');
  }else{
   if(x.reviewed_by_user_id===null||x.reviewed_by_user_id===adminId||
      x.approved_by_user_id!==null)
    throw Error('TREASURY_DUAL_APPROVAL_REQUIRED');
   const a=await client.query(
    'UPDATE tala_live_treasury_withdrawals SET approved_by_user_id=$2,updated_at=NOW() WHERE id=$1 AND state=$3 AND reviewed_by_user_id IS NOT NULL AND reviewed_by_user_id<>$2 AND approved_by_user_id IS NULL',
    [withdrawalId,adminId,'reserved']);
   if(a.rowCount!==1)throw Error('TREASURY_APPROVAL_RACE');
  }
  await client.query('COMMIT');begun=false;
  return {id:withdrawalId,state:phase==='review'?'reviewed':'approved'};
 }catch(e){if(begun)await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{client.release();}
}
