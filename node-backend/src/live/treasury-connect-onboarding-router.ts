/**
 * Restaurant + driver Stripe Connect registration status and hosted onboarding.
 * Matches mobile /withdrawals/:role/:id/connect/{status,onboarding}.
 * No payout, transfer, merchant identity creation or financial ledger writes.
 * New payees are mapped by authorized admin before inviting owner to Stripe.
 */
import {Router,type Request} from 'express';
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import type {Redis} from 'ioredis';
import {current} from '../auth/routes.js';
import {requireTreasuryBankStepUp} from './treasury-connect-step-up.js';
import {config} from '../config.js';

type Role='restaurant'|'driver';
type Provider=Pick<Stripe,'accounts'|'accountLinks'>;
type Owner={role:Role;id:number;ownerId:number;email:string;account:string|null;approved:boolean};
const validId=(raw:unknown)=>{
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,9}$/.test(raw))throw Error('PAYEE_ID_INVALID');
 const id=Number(raw);if(!Number.isSafeInteger(id))throw Error('PAYEE_ID_INVALID');return id;
};
async function owner(req:Request,pool:Pool,role:Role,id:number):Promise<Owner>{
 const s=await current(req);
 if(role==='restaurant'){
  if(s.user.role!=='restaurant')throw Error('ROLE_REQUIRED');
  const r=await pool.query<{owner_id:number;email:string;is_active:boolean;
   stripe_account_id:string|null;owner_approved_at:Date|null}>(`
   SELECT r.owner_id,u.email,u.is_active,m.stripe_account_id,m.owner_approved_at
   FROM restaurants r JOIN users u ON u.id=r.owner_id
   LEFT JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id
   WHERE r.id=$1`,[id]);
  const x=r.rows[0];
  if(!x||!x.is_active||x.owner_id!==s.userId)throw Error('NOT_OWNER');
  return {role,id,ownerId:s.userId,email:x.email,account:x.stripe_account_id,
   approved:Boolean(x.owner_approved_at)};
 }
 if(s.user.role!=='driver'||id!==s.userId)throw Error('ROLE_REQUIRED');
 const r=await pool.query<{email:string;is_active:boolean;is_verified:boolean;
  stripe_account_id:string|null;owner_approved_at:Date|null}>(`
   SELECT u.email,u.is_active,p.is_verified,d.stripe_account_id,d.owner_approved_at
   FROM users u JOIN driver_profiles p ON p.user_id=u.id
   LEFT JOIN tala_live_driver_accounts d ON d.user_id=u.id
   WHERE u.id=$1 AND u.role='driver'`,[id]);
 const x=r.rows[0];
 if(!x||!x.is_active||!x.is_verified)throw Error('DRIVER_UNVERIFIED');
 return {role,id,ownerId:s.userId,email:x.email,account:x.stripe_account_id,
   approved:Boolean(x.owner_approved_at)};
}
function parse(req:Request):{role:Role;id:number}{
 const {role}=req.params;
 if(role!=='restaurant'&&role!=='driver')throw Error('ROLE_INVALID');
 return {role,id:validId(req.params.id)};
}
async function stripeState(provider:Provider,x:Owner){
 if(!x.account)return {status:'not_linked',bankStatus:'not_linked',connectReady:false,
  bankVerified:false,payoutSchedule:'unknown'};
 if(x.account===config.STRIPE_PLATFORM_ACCOUNT_ID||
    !/^acct_[A-Za-z0-9]+$/.test(x.account))throw Error('CONNECTED_ACCOUNT_ID_INVALID');
 const acct=await provider.accounts.retrieve(x.account);
 if(acct.id!==x.account||acct.country!=='MX'||!acct.email||
   acct.email.trim().toLowerCase()!==x.email.trim().toLowerCase())
  throw Error('STRIPE_ACCOUNT_OWNER_MISMATCH');
 const bank=await provider.accounts.listExternalAccounts(x.account,
  {object:'bank_account',limit:100});
 if(bank.has_more)throw Error('BANK_PAGINATION_INCOMPLETE');
 const defaults=bank.data.filter(v=>v.object==='bank_account'&&
  v.country==='MX'&&v.currency==='mxn'&&v.default_for_currency===true);
 if(defaults.length>1)throw Error('MULTIPLE_DEFAULT_BANKS');
 const bankEntry=defaults[0];
 // MX external banks may remain 'new' while Connect payouts are enabled.
 // App-level verified means payout-eligible, not a provider status rewrite.
 const bankPayoutReady=bankEntry?.object==='bank_account'&&
  ['new','verified'].includes(bankEntry.status)&&
  acct.payouts_enabled===true&&acct.details_submitted===true&&
  !acct.requirements?.disabled_reason;
 const bankStatus=!bankEntry?'not_linked':
  bankPayoutReady?'verified':
  bankEntry.object==='bank_account'&&bankEntry.status==='errored'?
   'restricted':'pending_review';
 const ready=acct.details_submitted===true&&acct.payouts_enabled===true&&
  acct.capabilities?.transfers==='active'&&!acct.requirements?.disabled_reason&&
  (acct.requirements?.currently_due?.length??0)===0&&
  (acct.requirements?.past_due?.length??0)===0&&x.approved;
 const status=!x.approved?'pending_review':
  ready&&bankStatus==='verified'?'verified':
  bankStatus==='restricted'?'restricted':'pending_verification';
 return {status,bankStatus,connectReady:ready,bankVerified:bankPayoutReady,
  payoutSchedule:acct.settings?.payouts?.schedule?.interval??'unknown'};
}
const MAX_STATUS_READS_PER_FIVE_MINUTES=30;
export async function checkConnectStatusRateLimit(redis:Redis,x:Pick<Owner,'ownerId'|'role'|'id'>):Promise<boolean>{
 // Distributed, bounded, per owner/payee. Never cache provider bank approval
 // or wallet funds: Stripe itself stays the source of truth.
 const key='tala:node:live:connect-status:'+x.ownerId+':'+x.role+':'+x.id;
 const result=await redis.multi().incr(key).expire(key,300).exec();
 const count=Number(result?.[0]?.[1]);
 if(!Number.isSafeInteger(count)||count<1)throw Error('CONNECT_RATE_LIMIT_UNAVAILABLE');
 return count<=MAX_STATUS_READS_PER_FIVE_MINUTES;
}
export function buildTreasuryConnectOnboardingRouter(pool:Pool,provider:Provider,redis:Redis){
 const r=Router();
 r.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 r.get('/withdrawals/:role/:id/connect/status',async(req,res)=>{
  try{
   const {role,id}=parse(req),x=await owner(req,pool,role,id);
   if(!await checkConnectStatusRateLimit(redis,x)){
    res.status(429).json({error:'CONNECT_STATUS_RATE_LIMITED'});return;
   }
   const v=await stripeState(provider,x);
   res.json({role,payee_id:id,status:v.status,
    bank:{status:v.bankStatus},
    owner_approved:x.approved,
    connect_ready:v.connectReady,
    bank_verified:v.bankVerified,
    payout_schedule:v.payoutSchedule,
    onboarding_available:Boolean(x.account&&x.approved),
    setup_required:!x.account?'admin_connect_mapping':null,
    server_allows_requests:false,
    payout_execution_enabled:false,
    stripe_bank_payout_created:false});
  }catch(err){
   const msg=err instanceof Error?err.message:'';
   res.status(/NOT_OWNER|ROLE_REQUIRED|DRIVER_UNVERIFIED/.test(msg)?403:
    /ROLE_INVALID|PAYEE_ID_INVALID/.test(msg)?404:503)
    .json({error:'CONNECT_STATUS_NOT_AVAILABLE'});
  }
 });
 r.post('/withdrawals/:role/:id/connect/onboarding',async(req,res)=>{
  try{
   const {role,id}=parse(req);
   const s=await current(req);

   const x=await owner(req,pool,role,id);
   if(!x.account||!x.approved){
    res.status(409).json({error:'CONNECT_MAPPING_OR_OWNER_APPROVAL_REQUIRED'});return;
   }
   await requireTreasuryBankStepUp(pool,s,req.body?.totp);
   await stripeState(provider,x); // Re-read live account ownership before issuing link.
   const link=await provider.accountLinks.create({
    account:x.account,type:'account_onboarding',
    refresh_url:'https://talaeats.alan-palacios-dev.com/api/v1/connect/onboarding/refresh',
    return_url:'https://talaeats.alan-palacios-dev.com/api/v1/connect/onboarding/return'
   });
   if(!/^https:\/\/(connect|dashboard)\.stripe\.com\//.test(link.url))
    throw Error('UNTRUSTED_STRIPE_ONBOARDING_URL');
   res.status(200).json({url:link.url,expires_at:link.expires_at,
    withdrawable:false,bank_payout_created:false});
  }catch(err){
   const msg=err instanceof Error?err.message:'';
   if(msg.startsWith('CONNECT_FRESH_TOTP_')||msg==='TREASURY_TOTP_RATE_LIMITED'){
    res.status(msg==='TREASURY_TOTP_RATE_LIMITED'?429:403)
      .json({error:msg});return;
   }
   res.status(/NOT_OWNER|ROLE_REQUIRED|DRIVER_UNVERIFIED/.test(msg)?403:
    /ROLE_INVALID|PAYEE_ID_INVALID/.test(msg)?404:503)
    .json({error:'CONNECT_ONBOARDING_NOT_AVAILABLE'});
  }
 });
 return r;
}
