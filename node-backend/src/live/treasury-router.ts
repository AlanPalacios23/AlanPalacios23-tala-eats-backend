/**
 * Node Treasury v1 — same contract for Restaurant and Driver.
 * Authenticated READS only. LIVE provider mutations remain intentionally
 * unavailable until independently reviewed transfer execution, signed Connect
 * webhook reconciliation, migrations, replay handling and rollout approval.
 * Never replace a missing Stripe balance with an invented positive balance.
 */
import {Router,type Request} from 'express';
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {current} from '../auth/routes.js';
import {config} from '../config.js';
import {treasuryBalance,displayMinor,
  NODE_TREASURY_LIVE_EXECUTION_ENABLED,type TreasuryPayee} from './treasury-policy.js';
import {inspectConnectedBankAndPayouts} from './treasury-bank-verification.js';
import {reserveTreasuryWithdrawal} from './treasury-reservations.js';
import {approveTreasuryWithdrawal} from './treasury-dual-approval.js';
import {recordTreasuryTransferReview} from './treasury-transfer-reservations.js';
import {consumeTreasuryAdminOtp} from './treasury-admin-step-up.js';

const positive=(raw:unknown)=>{
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,9}$/.test(raw))throw Error('PAYEE_ID_INVALID');
 const n=Number(raw);
 if(!Number.isSafeInteger(n))throw Error('PAYEE_ID_INVALID');
 return n;
};
const minor=(raw:unknown):bigint=>{
 if(typeof raw!=='string'||!/^\d{1,16}$/.test(raw))throw Error('TREASURY_MINOR_INVALID');
 return BigInt(raw);
};
type RoleIdentity={kind:TreasuryPayee;id:number;ownerId:number;account:string;approved:boolean;
 ownerEmail:string};
async function identity(req:Request,pool:Pool,kind:TreasuryPayee,payeeId:number):Promise<RoleIdentity>{
 const s=await current(req);
 if(kind==='restaurant'){
  if(s.user.role!=='restaurant')throw Error('RESTAURANT_ROLE_REQUIRED');
  const a=await pool.query<{owner_id:number;stripe_account_id:string|null;owner_approved_at:Date|null;email:string;active:boolean}>(
   'SELECT r.owner_id,m.stripe_account_id,m.owner_approved_at,u.email,u.is_active AS active FROM restaurants r JOIN users u ON u.id=r.owner_id LEFT JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id WHERE r.id=$1',[payeeId]);
  const x=a.rows[0];
  if(!x||x.owner_id!==s.userId||!x.active||!x.stripe_account_id)throw Error('MERCHANT_NOT_AUTHORIZED_OR_CONNECT_MISSING');
  return {kind,id:payeeId,ownerId:s.userId,account:x.stripe_account_id,approved:Boolean(x.owner_approved_at),ownerEmail:x.email};
 }
 if(s.user.role!=='driver'||s.userId!==payeeId)throw Error('DRIVER_ROLE_REQUIRED');
 const a=await pool.query<{stripe_account_id:string;owner_approved_at:Date|null;email:string;active:boolean}>(
  'SELECT d.stripe_account_id,d.owner_approved_at,u.email,u.is_active AS active FROM tala_live_driver_accounts d JOIN users u ON u.id=d.user_id JOIN driver_profiles p ON p.user_id=d.user_id WHERE d.user_id=$1 AND p.is_verified=true',[payeeId]);
 const x=a.rows[0];
 if(!x||!x.active)throw Error('DRIVER_NOT_VERIFIED_OR_CONNECT_MISSING');
 return {kind,id:payeeId,ownerId:s.userId,account:x.stripe_account_id,approved:Boolean(x.owner_approved_at),ownerEmail:x.email};
}
type ConnectedReads=Pick<Stripe,'accounts'|'balance'|'transfers'|'charges'|'payouts'|'paymentIntents'>;
async function auditedSnapshot(pool:Pool,stripe:ConnectedReads,x:RoleIdentity){
 if(!/^acct_[A-Za-z0-9]+$/.test(x.account)||x.account===config.STRIPE_PLATFORM_ACCOUNT_ID)
  throw Error('INVALID_CONNECT_RECIPIENT');
 const acct=await stripe.accounts.retrieve(x.account);
 const connectReady=acct.id===x.account&&acct.country==='MX'&&
  acct.email?.trim().toLowerCase()===x.ownerEmail.trim().toLowerCase()&&
  acct.capabilities?.transfers==='active'&&acct.payouts_enabled===true&&
  acct.details_submitted===true&&!acct.requirements?.disabled_reason&&
  (acct.requirements?.currently_due?.length??0)===0&&
  (acct.requirements?.past_due?.length??0)===0;
 const stripeBalance=await stripe.balance.retrieve({}, {stripeAccount:x.account});
 const accountAvailable=stripeBalance.available.filter(b=>b.currency==='mxn');
 const cardMinor=accountAvailable[0]?.source_types?.card;
 if(accountAvailable.length!==1||typeof cardMinor!=='number'||
   !Number.isSafeInteger(cardMinor))
  throw Error('CONNECT_CARD_BALANCE_UNVERIFIED');
 const available=BigInt(cardMinor);
 if(available<0n)throw Error('CONNECT_NEGATIVE_BALANCE');
 const transferRows=await pool.query<{order_id:number;payee_kind:string;payee_id:number;
   connected_account_id:string;stripe_transfer_id:string;amount_minor:string;
   source_charge_id:string}>(
  "SELECT order_id,payee_kind,payee_id,connected_account_id,stripe_transfer_id,amount_minor::text,source_charge_id FROM tala_live_treasury_transfers WHERE payee_kind=$1 AND payee_id=$2 AND state='completed' ORDER BY id ASC LIMIT 101",
   [x.kind,x.id]);
 if(transferRows.rows.length>100)throw Error('TREASURY_TRANSFER_PAGINATION_REQUIRED');
 let total=0n;
 for(const row of transferRows.rows){
  if(row.payee_kind!==x.kind||row.payee_id!==x.id||
    row.connected_account_id!==x.account||!/^tr_[A-Za-z0-9]+$/.test(row.stripe_transfer_id)||
    !/^ch_[A-Za-z0-9]+$/.test(row.source_charge_id))
    throw Error('FOREIGN_STRIPE_TRANSFER');
  const amount=minor(row.amount_minor);
  const t=await stripe.transfers.retrieve(row.stripe_transfer_id);
  if(t.id!==row.stripe_transfer_id||t.destination!==x.account||
    t.source_transaction!==row.source_charge_id||t.currency!=='mxn'||
    !t.livemode||t.amount!==Number(amount)||t.amount_reversed!==0)
    throw Error('PROVIDER_TRANSFER_INCONSISTENT');
  const charge=await stripe.charges.retrieve(row.source_charge_id);
  if(!charge.livemode||charge.id!==row.source_charge_id||!charge.paid||
    charge.refunded||charge.disputed||charge.currency!=='mxn')
    throw Error('ORIGINAL_CHARGE_REFUND_DISPUTE_HOLD');
  total+=amount;
 }
 const [withdrawals,holds,cases]=await Promise.all([
  pool.query<{total:string;pending:string}>(
    "SELECT COALESCE(SUM(amount_minor),0)::text AS total, COALESCE(SUM(CASE WHEN state IN ('reserved','submitted','unknown','review_required') THEN 1 ELSE 0 END),0)::text AS pending FROM tala_live_treasury_withdrawals WHERE payee_kind=$1 AND payee_id=$2 AND state IN ('reserved','submitted','unknown','review_required','paid')",
    [x.kind,x.id]),
  pool.query<{n:string}>(
    "SELECT count(*)::text AS n FROM tala_live_treasury_transfers WHERE payee_kind=$1 AND payee_id=$2 AND state IN ('reserved','submitted','unknown','manual_hold')",
    [x.kind,x.id]),
  pool.query<{n:string}>(
    "SELECT count(*)::text AS n FROM tala_live_payee_allocations a JOIN tala_live_financial_cases f ON f.order_id=a.order_id WHERE a.payee_kind=$1 AND a.payee_id=$2 AND f.status<>'resolved'",
    [x.kind,x.id])
 ]);
 const reserved=minor(withdrawals.rows[0]?.total??'0');
 const pending=Number(withdrawals.rows[0]?.pending??'0');
 const holdCount=Number(holds.rows[0]?.n??'0');
 const incidentCount=Number(cases.rows[0]?.n??'0');
 const bankSchedule=acct.settings?.payouts?.schedule?.interval==='manual';
 const known=await pool.query<{id:string;withdrawal_id:string;payee_kind:'restaurant'|'driver';payee_id:number;amount_minor:string;bank_destination_id:string;state:string}>(
  "SELECT stripe_payout_id AS id,id::text AS withdrawal_id,payee_kind,payee_id,amount_minor::text,bank_destination_id,state FROM tala_live_treasury_withdrawals WHERE connected_account_id=$1 AND stripe_payout_id IS NOT NULL",
  [x.account]);
 const bank=await inspectConnectedBankAndPayouts(stripe,x.account,
  known.rows.map(v=>({id:v.id,withdrawalId:v.withdrawal_id,payeeKind:v.payee_kind,
    payeeId:v.payee_id,amountMinor:v.amount_minor,bankId:v.bank_destination_id,state:v.state})));
 const balance=treasuryBalance({
  amountTransferredMinor:total,committedWithdrawalsMinor:reserved,
  stripeAvailableMinor:available,openFinancialCases:incidentCount,
  pendingTransferCount:holdCount,unrecognizedProviderPayouts:bank.unknownPayouts,
  bankVerified:bank.verified,scheduleManual:bankSchedule,
  ownerApproved:x.approved,connectReady:Boolean(connectReady),
  pendingUnknownWithdrawals:pending
 });
 return {...balance,serverAllowsRequests:NODE_TREASURY_LIVE_EXECUTION_ENABLED,
  payoutExecutionEnabled:NODE_TREASURY_LIVE_EXECUTION_ENABLED,
  bankStatus:(bank.verified?'verified':'verification_pending') as 'verified'|'verification_pending',
  serverOnly:{
   kind:x.kind,payeeId:x.id,ownerId:x.ownerId,accountId:x.account,
   bankId:bank.bankId??'',transferredMinor:total,stripeAvailableMinor:available,
   ownerApproved:x.approved,connectReady:Boolean(connectReady),
   bankVerified:bank.verified,scheduleManual:bankSchedule,
   openCases:incidentCount,unrecognizedPayouts:bank.unknownPayouts,
   pendingTransfers:holdCount
  }};
}
export function buildTreasuryRouter(pool:Pool,stripe:ConnectedReads){
 const router=Router();
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 router.get('/withdrawals/:role/:id/balance',async(req,res)=>{
  try{
   const role=req.params.role;
   if(role!=='restaurant'&&role!=='driver'){res.status(404).json({error:'PAYEE_KIND_INVALID'});return;}
   const id=positive(req.params.id);
   const x=await identity(req,pool,role,id);
   const b=await auditedSnapshot(pool,stripe,x);
   res.json({payee_kind:role,payee_id:id,currency:'MXN',unit:'centavos',
    eligible_cents:b.eligibleMinor.toString(),already_requested_cents:b.reservedMinor.toString(),
    provider_available_cents:b.providerAvailableMinor.toString(),
    withdrawable_cents:b.withdrawableMinor.toString(),withdrawable:displayMinor(b.withdrawableMinor),
    bank:{status:b.bankStatus},eligible:b.eligible,blockers:b.blockers,
    server_allows_requests:false,payout_execution_enabled:false,
    source:b.source,real_bank_payouts_created:false});
  }catch(e){
   if(e instanceof Error&&/NOT_AUTHORIZED|ROLE_REQUIRED|NOT_VERIFIED|CONNECT_MISSING/.test(e.message)){
    res.status(403).json({error:'PAYEE_NOT_AUTHORIZED'});return;
   }
   res.status(503).json({error:'WITHDRAWAL_BALANCE_RECONCILIATION_HOLD'});
  }
 });
 router.get('/withdrawals/:role/:id/history',async(req,res)=>{
  try{
   const role=req.params.role;
   if(role!=='restaurant'&&role!=='driver'){res.status(404).end();return;}
   const id=positive(req.params.id);
   await identity(req,pool,role,id);
   const r=await pool.query<{id:string;amount_minor:string;state:string;created_at:Date}>(
    'SELECT id::text,amount_minor::text,state,created_at FROM tala_live_treasury_withdrawals WHERE payee_kind=$1 AND payee_id=$2 ORDER BY id DESC LIMIT 50',[role,id]);
   res.json({payee_kind:role,payee_id:id,currency:'MXN',
    withdrawals:r.rows.map(w=>({id:w.id,amount_cents:w.amount_minor,status:w.state,created_at:w.created_at})),
    bank_payouts_not_enabled:true});
  }catch{res.status(403).json({error:'WITHDRAWAL_HISTORY_NOT_AUTHORIZED'});}
 });
 router.post('/withdrawals/:role/:id/request',async(req,res)=>{
  if(!NODE_TREASURY_LIVE_EXECUTION_ENABLED){
   res.status(503).json({error:'TREASURY_WITHDRAWALS_NOT_RELEASED',
    withdrawals_execution_enabled:false,bank_payout_created:false});return;
  }
  try{
   const role=req.params.role;
   if(role!=='restaurant'&&role!=='driver'){res.status(404).end();return;}
   const payeeId=positive(req.params.id);
   const session=await current(req);
   if(!session.user.twoFactorEnabled||!session.mfaVerified)
    {res.status(403).json({error:'WITHDRAWAL_STEP_UP_MFA_REQUIRED'});return;}
   const body=req.body as Record<string,unknown>|undefined;
   if(!body||Object.keys(body).sort().join(',')!=='amount_cents,request_key,totp'||
      typeof body.amount_cents!=='string'||!/^[1-9][0-9]{0,10}$/.test(body.amount_cents)||
      typeof body.request_key!=='string'||typeof body.totp!=='string')
    {res.status(422).json({error:'WITHDRAWAL_INPUT_INVALID'});return;}
   const recipient=await identity(req,pool,role,payeeId);
   const balance=await auditedSnapshot(pool,stripe,recipient);
   if(!balance.eligible||balance.withdrawableMinor<100n)
    {res.status(409).json({error:'WITHDRAWAL_VERIFIED_BALANCE_HOLD'});return;}
   const reserved=await reserveTreasuryWithdrawal(pool,{
    snapshot:balance.serverOnly,actorUserId:session.userId,
    amountMinor:BigInt(body.amount_cents),clientKey:body.request_key,
    totp:body.totp
   });
   // Receipt must echo only persistent server-owned fields, including
   // replays, so Flutter does not invent time, amount or payment status.
   const receipt=await pool.query<{id:string;amount_cents:string;currency:string;
     created_at:Date;state:string}>(
    "SELECT id::text,amount_minor::text AS amount_cents,currency,created_at,state FROM tala_live_treasury_withdrawals WHERE id=$1 AND payee_kind=$2 AND payee_id=$3 AND requested_by_user_id=$4",
    [reserved.id,role,payeeId,session.userId]);
   if(receipt.rows.length!==1||receipt.rows[0]?.amount_cents!==body.amount_cents)
    {res.status(503).json({error:'TREASURY_RECEIPT_RECONCILIATION_REQUIRED'});return;}
   res.status(202).json({...receipt.rows[0],withdrawal_id:reserved.id,
     new_reservation:reserved.created,bank_payout_created:false,
     requires_admin_dual_approval:true});
  }catch{res.status(409).json({error:'WITHDRAWAL_IDENTITY_BALANCE_OR_OTP_HOLD'});}
 });
 router.post('/admin/treasury/withdrawals/:id/:phase',async(req,res)=>{
  if(!NODE_TREASURY_LIVE_EXECUTION_ENABLED){res.status(503).json({error:'TREASURY_NOT_RELEASED'});return;}
  try{
   const session=await current(req);
   if(session.user.role!=='admin'||!session.user.twoFactorEnabled||!session.mfaVerified)
    {res.status(403).json({error:'ADMIN_TREASURY_MFA_REQUIRED'});return;}
   const phase=req.params.phase;
   if(phase!=='review'&&phase!=='approve'){res.status(404).end();return;}
   const id=positive(req.params.id);
   const body=req.body as Record<string,unknown>|undefined;
   if(!body||Object.keys(body).join(',')!=='totp'||typeof body.totp!=='string'){
    res.status(422).json({error:'ADMIN_TREASURY_OTP_REQUIRED'});return;
   }
   await consumeTreasuryAdminOtp(pool,session.userId,body.totp,
    phase==='review'?'withdrawal_review':'withdrawal_approve',String(id));
   const result=await approveTreasuryWithdrawal(pool,String(id),session.userId,true,phase);
   res.status(200).json(result);
  }catch{res.status(409).json({error:'TREASURY_WITHDRAWAL_REVIEW_DENIED'});}
 });
 router.post('/admin/treasury/transfers/:orderId/:kind/:payeeId/:phase',async(req,res)=>{
  if(!NODE_TREASURY_LIVE_EXECUTION_ENABLED){res.status(503).json({error:'TREASURY_NOT_RELEASED'});return;}
  try{
   const session=await current(req);
   if(session.user.role!=='admin'||!session.user.twoFactorEnabled||!session.mfaVerified)
    {res.status(403).json({error:'ADMIN_TREASURY_MFA_REQUIRED'});return;}
   const kind=req.params.kind,phase=req.params.phase;
   if((kind!=='restaurant'&&kind!=='driver')||
      (phase!=='review'&&phase!=='approve')){res.status(404).end();return;}
   const orderId=positive(req.params.orderId),payeeId=positive(req.params.payeeId);
   const body=req.body as Record<string,unknown>|undefined;
   if(!body||Object.keys(body).join(',')!=='totp'||typeof body.totp!=='string'){
    res.status(422).json({error:'ADMIN_TREASURY_OTP_REQUIRED'});return;
   }
   await consumeTreasuryAdminOtp(pool,session.userId,body.totp,
    phase==='review'?'transfer_review':'transfer_approve',
    orderId+':'+kind+':'+payeeId);
   const result=await recordTreasuryTransferReview(pool,stripe,{
    orderId,kind,payeeId,adminId:session.userId,adminMfaVerified:true,phase});
   res.status(200).json({...result,money_moved:false});
  }catch{res.status(409).json({error:'TREASURY_TRANSFER_REVIEW_DENIED'});}
 });
 return router;
}
