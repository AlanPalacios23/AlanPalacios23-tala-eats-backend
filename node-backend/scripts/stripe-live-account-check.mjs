#!/usr/bin/env node
/**
 * Read-only Stripe LIVE credential verification on Kali.
 * Run with node --env-file=/home/tala-node-stage/.config/talaeats-node-live.env.
 * No payment intents, refunds, transfers, data writes or printed secrets.
 */
import Stripe from 'stripe';

const key=process.env.STRIPE_SECRET_KEY??'';
const platform=process.env.STRIPE_PLATFORM_ACCOUNT_ID??'';
const connected=process.env.STRIPE_CONNECTED_ACCOUNT_ID??'';
const publishable=process.env.STRIPE_PUBLISHABLE_KEY??'';
const webhook=process.env.STRIPE_WEBHOOK_SECRET??'';
const checks={
  LIVE_API_KEY_FORMAT:/^(sk|rk)_live_[A-Za-z0-9]{16,}$/.test(key),
  LIVE_PUBLISHABLE_KEY_FORMAT:/^pk_live_[A-Za-z0-9]{16,}$/.test(publishable),
  WEBHOOK_SIGNING_SECRET_FORMAT:/^whsec_[A-Za-z0-9]{16,}$/.test(webhook),
  PLATFORM_ACCOUNT_ID_FORMAT:/^acct_[A-Za-z0-9]+$/.test(platform),
  CONNECT_ACCOUNT_ID_FORMAT:/^acct_[A-Za-z0-9]+$/.test(connected),
};
for(const [name,pass] of Object.entries(checks))
  console.log(name+'='+(pass?'PASS':'BLOCKED'));
if(Object.values(checks).some(x=>!x)){
  console.log('LIVE_STRIPE_CREDENTIAL_CHECK=BLOCKED');
  process.exitCode=1;
}else{
  const stripe=new Stripe(key,{timeout:8000,maxNetworkRetries:1});
  try{
    const account=await stripe.accounts.retrieve();
    const match=account.id===platform;
    const cards=account.capabilities?.card_payments==='active';
    const enabled=Boolean(account.charges_enabled);
    console.log('PLATFORM_ACCOUNT_MATCH='+(match?'PASS':'BLOCKED'));
    console.log('PLATFORM_CARD_PAYMENTS='+(cards?'ACTIVE':'BLOCKED'));
    console.log('PLATFORM_CHARGES_ENABLED='+(enabled?'YES':'NO'));
    try{
      const recipient=await stripe.accounts.retrieve(connected);
      console.log('CONNECT_ACCOUNT_MATCH='+(recipient.id===connected?'PASS':'BLOCKED'));
      console.log('CONNECT_TRANSFERS='+(recipient.capabilities?.transfers==='active'?'ACTIVE':'NOT_ACTIVE'));
      console.log('CONNECT_PAYOUTS='+(recipient.payouts_enabled?'ENABLED':'NOT_ENABLED'));
    }catch{
      console.log('CONNECT_STATUS=UNVERIFIED_READ_PERMISSION_OR_STRIPE_ERROR');
    }
    console.log('LIVE_API_READ_ONLY_CHECK='+(match&&cards&&enabled?'PASS':'BLOCKED'));
    if(!match||!cards||!enabled)process.exitCode=1;
  }catch{
    console.log('LIVE_API_READ_ONLY_CHECK=BLOCKED_ACCOUNT_LOOKUP_FAILED');
    process.exitCode=1;
  }
  console.log('CHECKOUT_ACTIVATION=NOT_PERFORMED');
}
