#!/usr/bin/env node
import {Pool} from 'pg';
/**
 * Read-only Stripe LIVE credentials probe, usable from a temporary path.
 * Run with Node 24 --env-file=/home/tala-node-stage/.config/talaeats-node-live.env.
 * Only HTTP GETs to Stripe; never prints secrets, payment data or API errors.
 */
const key=process.env.STRIPE_SECRET_KEY??'';
const platform=process.env.STRIPE_PLATFORM_ACCOUNT_ID??'';
const publishable=process.env.STRIPE_PUBLISHABLE_KEY??'';
const webhook=process.env.STRIPE_WEBHOOK_SECRET??'';
const checks={
  LIVE_API_KEY_FORMAT:/^(sk|rk)_live_[A-Za-z0-9]{16,}$/.test(key),
  LIVE_PUBLISHABLE_KEY_FORMAT:/^pk_live_[A-Za-z0-9]{16,}$/.test(publishable),
  WEBHOOK_SIGNING_SECRET_FORMAT:/^whsec_[A-Za-z0-9]{16,}$/.test(webhook),
  PLATFORM_ACCOUNT_ID_FORMAT:/^acct_[A-Za-z0-9]+$/.test(platform),
};
for(const [name,pass] of Object.entries(checks))
  console.log(name+'='+(pass?'PASS':'BLOCKED'));
if(Object.values(checks).some(x=>!x)){
  console.log('LIVE_STRIPE_CREDENTIAL_CHECK=BLOCKED');
  process.exitCode=1;
}else{
  const get=async(path)=>{
    const response=await fetch('https://api.stripe.com'+path,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+key,'Accept':'application/json'},
    });
    if(!response.ok)throw Error('STRIPE_READ_FAILED');
    return response.json();
  };
  try{
    const account=await get('/v1/account');
    const match=account.id===platform;
    const cards=account.capabilities?.card_payments==='active';
    const enabled=Boolean(account.charges_enabled);
    console.log('PLATFORM_ACCOUNT_MATCH='+(match?'PASS':'BLOCKED'));
    console.log('PLATFORM_CARD_PAYMENTS='+(cards?'ACTIVE':'BLOCKED'));
    console.log('PLATFORM_CHARGES_ENABLED='+(enabled?'YES':'NO'));
    // Each seller is isolated: readiness is based on the seller's own
    // approved Connect recipient, not a single personal account env var.
    let connectReady=false;
    let readySellers=0;
    let reviewedSellers=0;
    let pool;
    try{
      const url=new URL(process.env.DATABASE_URL??'');
      if(!['postgres:','postgresql:'].includes(url.protocol)||
         !url.hostname||!url.username||!url.password||
         url.pathname==='/tala_node_stage'||url.username==='tala_node_stage')
        throw Error('PRODUCTION_PG_REQUIRED');
      pool=new Pool({connectionString:url.toString(),max:1,
        connectionTimeoutMillis:5000,statement_timeout:7000});
      const client=await pool.connect();
      let rows;
      try{
        await client.query('BEGIN READ ONLY');
        const result=await client.query(
          "SELECT m.stripe_account_id,m.owner_approved_at,u.email "+
          "FROM tala_live_merchant_accounts m "+
          "JOIN restaurants r ON r.id=m.restaurant_id "+
          "JOIN users u ON u.id=r.owner_id "+
          "WHERE u.is_active=true AND r.owner_id IS NOT NULL "+
          "ORDER BY m.restaurant_id LIMIT 101");
        rows=result.rows;
        await client.query('ROLLBACK');
      }finally{client.release();}
      if(rows.length>100)throw Error('MAPPING_AUDIT_LIMIT');
      reviewedSellers=rows.length;
      for(const seller of rows){
        const id=seller.stripe_account_id;
        if(typeof id!=='string'||!/^acct_[A-Za-z0-9]+$/.test(id)||
           id===platform||!seller.owner_approved_at)continue;
        try{
          const connected=await get('/v1/accounts/'+id);
          if(connected.id===id&&connected.country==='MX'&&
             connected.email?.trim().toLowerCase()===
               seller.email?.trim().toLowerCase()&&
             connected.capabilities?.transfers==='active'&&
             connected.payouts_enabled===true&&
             connected.details_submitted===true){
             readySellers++;
          }
        }catch{
          // A seller missing access/verification is in HOLD, not passed.
        }
      }
      connectReady=readySellers>=1;
      console.log('CONNECT_REGISTERED_SELLERS='+reviewedSellers);
      console.log('CONNECT_LIVE_READY_SELLERS='+readySellers);
      console.log('CONNECT_MARKETPLACE_READY='+(connectReady?'PASS':'BLOCKED'));
    }catch{
      console.log('CONNECT_MARKETPLACE_READY=BLOCKED');
      console.log('CONNECT_DATABASE_OR_STRIPE_AUDIT=UNAVAILABLE');
    }finally{if(pool)await pool.end().catch(()=>{});}
    // Verify the existing LIVE destination before an operator enables charges.
    // GET-only: no endpoint changes and no fabricated webhook deliveries.
    let webhookReady=false;
    try{
      const destination='https://talaeats.alan-palacios-dev.com/api/v1/payments/stripe/webhook';
      const listed=await get('/v1/webhook_endpoints?limit=100');
      if(listed.has_more===true)throw Error('INCOMPLETE_WEBHOOK_PAGE');
      const candidate=Array.isArray(listed.data)?listed.data.find(x=>
        x.url===destination&&x.status==='enabled'&&x.livemode===true):undefined;
      const events=new Set(candidate?.enabled_events??[]);
      const required=[
        'payment_intent.succeeded','payment_intent.payment_failed',
        'payment_intent.canceled','charge.refunded',
        'refund.created','refund.updated',
        'refund.failed','charge.dispute.created','charge.dispute.closed',
      ];
      const covered=events.has('*')||required.every(x=>events.has(x));
      console.log('LIVE_WEBHOOK_DESTINATION='+(candidate?'MATCH':'BLOCKED'));
      console.log('LIVE_WEBHOOK_EVENT_COVERAGE='+(covered?'PASS':'BLOCKED'));
      webhookReady=Boolean(candidate&&covered);
    }catch{
      console.log('LIVE_WEBHOOK_VERIFICATION=BLOCKED_READ_ACCESS_OR_STRIPE_ERROR');
    }
    const ready=match&&cards&&enabled&&webhookReady&&connectReady;
    console.log('LIVE_API_READ_ONLY_CHECK='+(ready?'PASS':'BLOCKED'));
    console.log('LIVE_WEBHOOK_SIGNATURE_DELIVERY=UNVERIFIED_UNTIL_SIGNED_EVENT');
    if(!ready)process.exitCode=1;
  }catch{
    console.log('LIVE_API_READ_ONLY_CHECK=BLOCKED_ACCOUNT_LOOKUP_FAILED');
    process.exitCode=1;
  }
  console.log('CHECKOUT_ACTIVATION=NOT_PERFORMED');
}
