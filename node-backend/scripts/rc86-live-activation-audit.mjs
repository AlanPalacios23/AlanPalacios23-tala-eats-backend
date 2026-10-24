#!/usr/bin/env node
/** RC8.6 LIVE activation audit. GET-only Stripe; READ-ONLY PostgreSQL. */
import {Pool} from 'pg';
import {inspectLiveFinancialData} from '../dist/live/financial-readiness.js';
const env=process.env;
const fail=(reason)=>{console.log('LIVE_ACTIVATION_AUDIT=HOLD_'+reason);process.exitCode=1;};
if(env.NODE_ENV!=='production'||
   !/^(sk|rk)_live_[A-Za-z0-9]{16,}$/.test(env.STRIPE_SECRET_KEY??'')||
   !/^pk_live_[A-Za-z0-9]{16,}$/.test(env.STRIPE_PUBLISHABLE_KEY??'')||
   !/^whsec_[A-Za-z0-9]{16,}$/.test(env.STRIPE_WEBHOOK_SECRET??'')||
   !/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_PLATFORM_ACCOUNT_ID??'')||
   env.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'){
  fail('ENV'); 
}else{
 const pool=new Pool({connectionString:env.DATABASE_URL,max:1,
  connectionTimeoutMillis:5000,statement_timeout:7000});
 const stripeGet=async(url)=>{
  const r=await fetch('https://api.stripe.com'+url,{
   headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY},
   method:'GET',redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('STRIPE_GET_FAILED');
  return r.json();
 };
 try{
  const [audit,pg,account,webhooks]=await Promise.all([
   inspectLiveFinancialData(pool),
   pool.query(`SELECT COUNT(*) FILTER (WHERE m.owner_approved_at IS NOT NULL)::int AS approved
     FROM tala_live_merchant_accounts m`),
   stripeGet('/v1/account'),stripeGet('/v1/webhook_endpoints?limit=100')
  ]);
  if(audit.classification!=='LIVE_FINANCIAL_DATA_PASS')
   throw Error('FINANCIAL_HOLD');
  if(account.id!==env.STRIPE_PLATFORM_ACCOUNT_ID||
     account.capabilities?.card_payments!=='active'||
     account.charges_enabled!==true)throw Error('PLATFORM_NOT_READY');
  const url='https://talaeats.alan-palacios-dev.com/api/v1/payments/stripe/webhook';
  if(webhooks.has_more===true)throw Error('WEBHOOK_PAGINATED');
  const hook=webhooks.data?.find(x=>x.url===url&&
    x.status==='enabled'&&x.livemode===true);
  const needs=[
   'payment_intent.succeeded','payment_intent.payment_failed',
   'payment_intent.canceled','charge.refunded',
   'refund.created','refund.updated','refund.failed',
   'charge.dispute.created','charge.dispute.closed'
  ];
  if(!hook||!(hook.enabled_events?.includes('*')||
    needs.every(x=>hook.enabled_events?.includes(x))))
   throw Error('WEBHOOK_SUBSCRIPTIONS');
  console.log('LIVE_FINANCIAL_DATA=PASS');
  console.log('STRIPE_PLATFORM_LIVE=PASS');
  console.log('STRIPE_WEBHOOK_EVENTS=PASS');
  const n=Number(pg.rows[0]?.approved??0);
  console.log('SELLER_OWNER_APPROVED_MAPPINGS='+n);
  if(n===0){
   console.log('CHECKOUT_REQUIRES_REAL_APPROVED_SELLER=YES');
   console.log('WARNING_NO_RESTAURANT_CAN_ACCEPT_LIVE_PAYMENTS_YET');
  }
  console.log('LIVE_ACTIVATION_AUDIT=PASS');
 }catch(error){
  // Return only a fixed diagnostic category, never credentials or SQL text.
  const pgCode=typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)
    ?'POSTGRES_'+error.code:null;
  const categories=new Set(['FINANCIAL_HOLD','PLATFORM_NOT_READY',
    'WEBHOOK_PAGINATED','WEBHOOK_SUBSCRIPTIONS','STRIPE_GET_FAILED']);
  const reason=pgCode??(categories.has(error?.message)?error.message:'UNKNOWN');
  fail(reason);
 }finally{await pool.end().catch(()=>{});}
}
console.log('PAYMENT_INTENTS_CREATED=0');
console.log('REFUNDS_TRANSFERS_PAYOUTS_CREATED=0');
