import Stripe from 'stripe';
import { Pool } from 'pg';

const root = 'http://127.0.0.1:18190';
const stripe = new Stripe('sk_test_ci_integration_dummy');
const secret = 'whsec_ci_integration_dummy';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3500,
  max: 2,
});
const nap = ms => new Promise(resolve => setTimeout(resolve,ms));
async function check(path) {
  const r = await fetch(root+path, {signal: AbortSignal.timeout(2500)});
  if (!r.ok) throw new Error('HTTP_'+path+'_'+r.status);
  return r.json();
}
async function main() {
  let ready=false;
  for(let i=0;i<35;i++) {
    try {
      const obj=await check('/api/v1/ready');
      if(obj.ready===true && obj.database && obj.redis && obj.financialWrites===false) {
        ready=true;break;
      }
    } catch {}
    await nap(750);
  }
  if(!ready) throw new Error('STAGING_READY_FAILED');
  const health=await check('/api/v1/health');
  if(health.production!==false || health.status!=='ok') {
    throw new Error('STAGING_HEALTH_FAILED');
  }
  console.log('NATIVE_NODE_STAGING_HEALTH_READY=PASS');

  // Signed TEST event; never uses Stripe network/Connect/payout operations.
  const eventId='evt_ci_native_stage_001';
  const payload=JSON.stringify({
    id:eventId, object:'event', type:'account.updated',
    created:1700000000, livemode:false,
    data:{object:{id:'acct_ci_native_test'}},
  });
  const signature=stripe.webhooks.generateTestHeaderString({payload,secret});
  const receipt=await fetch(root+'/api/v1/webhooks/stripe',{
    method:'POST',
    headers:{'content-type':'application/json','stripe-signature':signature},
    body:payload,signal:AbortSignal.timeout(5000),
  });
  if(receipt.status!==200) throw new Error('SIGNED_TEST_WEBHOOK_STATUS_'+receipt.status);
  console.log('SIGNED_TEST_WEBHOOK=PASS');
  const malicious=await fetch(root+'/api/v1/webhooks/stripe',{
    method:'POST',headers:{'content-type':'application/json','stripe-signature':'invalid'},
    body:payload,signal:AbortSignal.timeout(5000),
  });
  if(malicious.status!==400) throw new Error('UNSIGNED_WEBHOOK_NOT_REJECTED');
  console.log('INVALID_SIGNATURE_REJECTED=PASS');

  let processed=false;
  for(let i=0;i<30;i++) {
    const q=await pool.query('SELECT status, "deliveryCount" FROM stripe_webhook_events WHERE id=$1',[eventId]);
    if(q.rows.length===1 && q.rows[0].status==='PROCESSED') {
      processed=true;break;
    }
    await nap(400);
  }
  if(!processed) throw new Error('BULLMQ_RECEIPT_NOT_PROCESSED');
  console.log('BULLMQ_PERSISTENT_RECEIPT=PASS');
  const q=await pool.query('SELECT count(*)::integer as count FROM payout_instructions');
  if(q.rows[0].count!==0) throw new Error('FINANCIAL_WRITE_DETECTED');
  console.log('FINANCIAL_PAYOUTS_UNTOUCHED=PASS');
}
try{await main();}finally{await pool.end();}
