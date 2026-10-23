// Disposable PostgreSQL 15 only. Synthetic signed event; NO Stripe calls.
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {ingestSignedLiveStripeWebhook} from '../dist/live/webhook-inbox.js';
import {validateLiveSettings} from '../dist/live/guard.js';

const dbUrl=process.env.DATABASE_URL;
assert.ok(dbUrl?.includes('/rc8_ci'), 'isolated CI db required');
const settings=validateLiveSettings({
 nodeEnv:'production',explicitlyEnabled:'true',readinessApproved:'true',
 key:'rk_live_'+'A'.repeat(24),publishableKey:'pk_live_'+'B'.repeat(24),
 webhookSecret:'whsec_'+'C'.repeat(24),
 databaseUrl:dbUrl,redisUrl:'redis://:private@127.0.0.1:16389/1',
 refundsEnabled:'false',transfersEnabled:'false',maxOrderMinor:'5000'
});
const pool=new Pool({connectionString:dbUrl});
const id='evt_RC8CISYNTH001';
const event={id,livemode:true,account:undefined,
 type:'payment_intent.succeeded',
 data:{object:{object:'payment_intent',id:'pi_RC8CISYNTH001'}}};
const provider={webhooks:{constructEvent:(raw,sig,secret)=>{
  assert.ok(Buffer.isBuffer(raw));
  assert.equal(sig,'synthetic-signature');
  assert.equal(secret,settings.webhookSecret);
  return event;
}}};
try{
 await pool.query('SELECT 1');
 const first=await ingestSignedLiveStripeWebhook(
   Buffer.from('{}'),'synthetic-signature',provider,pool,settings);
 assert.deepEqual(first,{received:true,queued:true});
 const second=await ingestSignedLiveStripeWebhook(
   Buffer.from('{}'),'synthetic-signature',provider,pool,settings);
 assert.deepEqual(second,{received:true,queued:true});
 const r=await pool.query(`
  SELECT "objectId" AS oid,"deliveryCount" AS deliveries,
         "stripeAccountId" AS connected,"receivedAt" AS created,
         status
  FROM stripe_webhook_events WHERE id=$1
 `,[id]);
 assert.equal(r.rows.length,1);
 assert.equal(r.rows[0].oid,'pi_RC8CISYNTH001');
 assert.equal(r.rows[0].deliveries,2);
 assert.equal(r.rows[0].connected,null);
 assert.equal(r.rows[0].status,'RECEIVED');
 const malicious={...event,data:{object:{object:'payment_intent',
   id:'pi_DIFFERENT'}}};
 provider.webhooks.constructEvent=()=>malicious;
 await assert.rejects(
   ()=>ingestSignedLiveStripeWebhook(Buffer.from('{}'),
   'synthetic-signature',provider,pool,settings));
 const count=await pool.query('SELECT COUNT(*)::int AS n FROM stripe_webhook_events WHERE id=$1',[id]);
 assert.equal(count.rows[0].n,1);
 console.log('RC8_PG15_LIVE_WEBHOOK_SCHEMA=PASS');
 console.log('REAL_STRIPE_API_CALLS=ZERO');
}finally{
 await pool.end();
}
