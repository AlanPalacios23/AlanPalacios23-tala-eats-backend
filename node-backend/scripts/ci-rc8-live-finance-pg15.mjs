/**
 * Disposable CI PG15 finance integration. Never calls Stripe, never uses
 * secrets; inserts synthetic buyer + pickup and simulates a signed event.
 */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {validateLiveSettings} from '../dist/live/guard.js';
import {ingestSignedLiveStripeWebhook} from '../dist/live/webhook-inbox.js';
import {reconcileRecordedLiveStripeEvent} from '../dist/live/reconcile.js';
import {inspectLiveFinancialData} from '../dist/live/financial-readiness.js';

const databaseUrl=process.env.DATABASE_URL;
assert.ok(databaseUrl && new URL(databaseUrl).pathname==='/rc8_ci',
 'CI only: refuses non-disposable PostgreSQL');
const pool=new Pool({connectionString:databaseUrl});
const settings=validateLiveSettings({
 nodeEnv:'production',explicitlyEnabled:'true',readinessApproved:'true',
 key:'rk_'+'live_'+'A'.repeat(24),publishableKey:'pk_'+'live_'+'B'.repeat(24),
 webhookSecret:'whsec_'+'C'.repeat(24),
 databaseUrl,redisUrl:'redis://:private@127.0.0.1:16389/1',
 refundsEnabled:'false',transfersEnabled:'false',maxOrderMinor:'5000',
});
const create=async(sql,args=[])=> (await pool.query(sql,args)).rows[0];
const count=async(sql,args=[])=>Number((await pool.query(sql,args)).rows[0].n);
const amount='12.50';
try {
 const buyer=await create(`INSERT INTO users(name,email,role)
   VALUES('RC8 CI Buyer','rc8-ci-buyer@example.invalid','customer')
   RETURNING id`);
 const restaurant=await create(`INSERT INTO restaurants(name)
   VALUES('RC8 CI Restaurant') RETURNING id`);
 const order=await create(`
   INSERT INTO orders(user_id,restaurant_id,status,payment_method,
     payment_status,payment_provider,payment_provider_id,
     order_type,total,subtotal,restaurant_payout,platform_revenue,
     payment_processing_fee,contribution_margin,address)
   VALUES($1,$2,'awaiting_payment','stripe','pending','stripe',
     'pi_reserving_rc8_live','pickup',$3,10.00,10.00,2.50,0.25,2.25,'RC8 TEST')
   RETURNING id`,[buyer.id,restaurant.id,amount]);
 const eventId='evt_RC8FINANCE001',paymentIntentId='pi_RC8FINANCE001';
 const event={id:eventId,type:'payment_intent.succeeded',livemode:true,
   data:{object:{object:'payment_intent',id:paymentIntentId}}};
 const intent={
   id:paymentIntentId,object:'payment_intent',livemode:true,
   currency:'mxn',amount:1250,amount_received:1250,status:'succeeded',
   metadata:{tala_mode:'rc8_live_pickup',
     order_id:String(order.id),buyer_id:String(buyer.id)}
 };
 let providerReads=0;
 const fakeStripe={
   webhooks:{constructEvent:(body,signature,secret)=>{
     assert.ok(Buffer.isBuffer(body));
     assert.equal(signature,'signed-synthetic');
     assert.equal(secret,settings.webhookSecret);
     return event;
   }},
   events:{retrieve:async id=>{
     assert.equal(id,eventId);providerReads++;return event;
   }},
   paymentIntents:{retrieve:async id=>{
     assert.equal(id,paymentIntentId);providerReads++;return intent;
   }}
 };
 const ingested=await ingestSignedLiveStripeWebhook(
   Buffer.from('{}'),'signed-synthetic',fakeStripe,pool,settings);
 assert.equal(ingested.queued,true);
 const first=await reconcileRecordedLiveStripeEvent(
    eventId,fakeStripe,pool,settings);
 assert.deepEqual(first,{received:true,alreadyProcessed:false});
 assert.equal(providerReads,3);
 const orderResult=await create(`
   SELECT status,payment_status,payment_provider_id
   FROM orders WHERE id=$1`,[order.id]);
 assert.equal(orderResult.status,'received');
 assert.equal(orderResult.payment_status,'paid');
 assert.equal(orderResult.payment_provider_id,paymentIntentId);
 assert.equal(await count(`SELECT COUNT(*)::int n FROM financial_ledger_entries
   WHERE order_id=$1`,[order.id]),6);
 assert.equal(await count(`SELECT COUNT(*)::int n FROM event_outbox
   WHERE aggregate_id=$1 AND event_type IN ('order.created','order.paid')`,
   [String(order.id)]),2);
 assert.equal(await count(`SELECT COUNT(*)::int n FROM order_events
   WHERE order_id=$1 AND status='received'`,[order.id]),1);
 const receipt=await create(`SELECT status,"processedAt" AS at
   FROM stripe_webhook_events WHERE id=$1`,[eventId]);
 assert.equal(receipt.status,'PROCESSED');
 assert.ok(receipt.at);
 const second=await reconcileRecordedLiveStripeEvent(
   eventId,fakeStripe,pool,settings);
 assert.deepEqual(second,{received:true,alreadyProcessed:true});
 assert.equal(await count(`SELECT COUNT(*)::int n FROM financial_ledger_entries
   WHERE order_id=$1`,[order.id]),6);
 assert.equal(await count(`SELECT COUNT(*)::int n FROM event_outbox
   WHERE aggregate_id=$1`,[String(order.id)]),2);
 const audit=await inspectLiveFinancialData(pool);
 assert.equal(audit.classification,'LIVE_FINANCIAL_DATA_PASS');
 assert.equal(audit.liveEnabled,false);
 console.log('RC8_POSTGRES15_FINANCIAL_SETTLEMENT=PASS');
 console.log('RC8_LEDGER_OUTBOX_DUPLICATE_REPLAY=PASS');
 console.log('RC8_FINANCE_READINESS_COUNTS=PASS');
 console.log('STRIPE_NETWORK_CHARGES=ZERO');
} finally {
 await pool.end();
}
