import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateLiveSettings,LiveGateError,liveReceiptIdentity,
  livePilotAmount} from '../dist/live/guard.js';
import {createLivePickupPaymentIntent,verifyLiveStripeEvent,
  LIVE_PI_RESERVED} from '../dist/live/stripe-payments.js';
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

const valid=()=>({
 nodeEnv:'production',explicitlyEnabled:'true',readinessApproved:'true',
 key:'rk_live_'+'Z'.repeat(24),
 publishableKey:'pk_live_'+'Y'.repeat(24),
 webhookSecret:'whsec_'+'K'.repeat(24),
 databaseUrl:'postgresql://live:secret@127.0.0.1:15445/tala_live',
 redisUrl:'redis://:secret@127.0.0.1:16389/1',
 refundsEnabled:'false',transfersEnabled:'false',maxOrderMinor:'5000'
});
test('LIVE cannot inherit stage Postgres Redis or test credentials',()=>{
 assert.equal(validateLiveSettings(valid()).maxOrderMinor,5000);
 for(const [key,value] of [
  ['nodeEnv','staging'],['explicitlyEnabled','false'],
  ['readinessApproved','false'],
  ['key','rk_test_'+'A'.repeat(24)],
  ['publishableKey','pk_test_'+'A'.repeat(24)],
  ['transfersEnabled','true'],['refundsEnabled','true'],['maxOrderMinor','50001'],
  ['databaseUrl','postgresql://tala_node_stage:secret@127.0.0.1:15435/tala_node_stage'],
  ['redisUrl','redis://:secret@127.0.0.1:16379/0'],
 ]){
   assert.throws(()=>validateLiveSettings({...valid(),[key]:value}),
     error=>error instanceof LiveGateError,key);
 }
});
test('pilot amount is bounded, integer MXN cent amount',()=>{
 for(const x of [0,-1,99,5001,Infinity,100.1,NaN])
  assert.throws(()=>livePilotAmount(x,5000),LiveGateError);
 assert.equal(livePilotAmount(200,5000),200);
});
test('verified payment requires LIVE captured amount, mode, account and buyer',()=>{
 const order={id:17,buyerId:20,amountMinor:1299};
 const base={id:'pi_ABC123',livemode:true,amount:1299,
   amount_received:1299,currency:'mxn',status:'succeeded',
   metadata:{order_id:'17',buyer_id:'20',tala_mode:'rc8_live_pickup'}};
 assert.equal(liveReceiptIdentity(base,order),true);
 for(const patch of [
  {livemode:false},{amount:1300},{amount_received:1000},
  {status:'processing'},{currency:'usd'},
  {metadata:{...base.metadata,buyer_id:'21'}},
  {metadata:{...base.metadata,tala_mode:'rc7_test_pickup'}},
 ]){
   assert.throws(()=>liveReceiptIdentity({...base,...patch},order),LiveGateError);
 }
});
test('Live intent is bound to one buyer and provider idempotency key',async()=>{
 const settings=validateLiveSettings(valid());
 let reserveCount=0,attached='';
 const store={
  reserveForPayment:async(id,buyer)=>{
   reserveCount++;
   return id===17&&buyer===20 ? {
    id:17,buyerId:20,amountMinor:1299,currency:'mxn',
    method:'stripe',fulfillment:'pickup',status:'awaiting_payment',
    paymentStatus:'pending',intentId:LIVE_PI_RESERVED,
    createdAtMs:Date.now(),refundedMinor:0,
   }:null;
  },
  attachStripeIntent:async(_id,_buyer,pi)=>{attached=pi;return true;}
 };
 let createCalls=0;
 const provider={paymentIntents:{
  create:async(data,options)=>{
   createCalls++;
   assert.equal(data.amount,1299);
   assert.equal(data.currency,'mxn');
   assert.equal(data.metadata.buyer_id,'20');
   assert.equal(options.idempotencyKey,'tala-live-v1-pickup-order-17');
   assert.equal(data.application_fee_amount,undefined);
   assert.equal(data.transfer_data,undefined);
   return {id:'pi_ABCD123',livemode:true,amount:1299,
    currency:'mxn',status:'requires_payment_method',
    client_secret:'pi_secret_example',metadata:data.metadata};
  },
  retrieve:async()=>{throw Error('unexpected retrieve');}
 }};
 const result=await createLivePickupPaymentIntent(store,provider,settings,17,20);
 assert.equal(result.mode,'live');
 assert.equal(result.payment_intent_id,'pi_ABCD123');
 assert.equal(createCalls,1);
 assert.equal(reserveCount,1);
 assert.equal(attached,'pi_ABCD123');
 await assert.rejects(()=>createLivePickupPaymentIntent(store,provider,settings,17,21),
  LiveGateError);
});
test('Captured or processing Intent cannot be reopened to customer',async()=>{
 const settings=validateLiveSettings(valid());
 const store={
  reserveForPayment:async()=>({
   id:17,buyerId:20,amountMinor:1299,currency:'mxn',
   method:'stripe',fulfillment:'pickup',status:'awaiting_payment',
   paymentStatus:'pending',intentId:'pi_ABCD123',
   createdAtMs:Date.now(),refundedMinor:0
  }),
  attachStripeIntent:async()=>{throw Error('should not attach');}
 };
 for(const status of ['succeeded','processing','canceled']){
   const stripe={paymentIntents:{retrieve:async()=>({
      id:'pi_ABCD123',livemode:true,amount:1299,currency:'mxn',
      metadata:{order_id:'17',buyer_id:'20',tala_mode:'rc8_live_pickup'},
      status,client_secret:'pi_secret'
   })}};
   await assert.rejects(()=>createLivePickupPaymentIntent(store,stripe,settings,17,20),LiveGateError);
 }
});
test('Stripe webhook requires signature and rejects TEST or Connect',()=>{
 const settings=validateLiveSettings(valid());
 const client={webhooks:{constructEvent:(body,signature,secret)=>{
  assert.ok(Buffer.isBuffer(body));assert.equal(signature,'sig');
  assert.equal(secret,settings.webhookSecret);
  return {id:'evt_TEST',livemode:false,account:undefined};
 }}};
 assert.throws(()=>verifyLiveStripeEvent(client,settings,Buffer.from('{}'),'sig'),LiveGateError);
 assert.throws(()=>verifyLiveStripeEvent(client,settings,Buffer.from('{}'),''),LiveGateError);
});
test('Stage entrypoints cannot import or activate Stripe LIVE module',()=>{
 for(const p of ['src/app.ts','src/worker.ts','src/config.ts',
                   'src/stripe.ts','src/webhook.ts']){
  const s=source(p);
  assert.doesNotMatch(s,/from ['\"]\.\/live\//);
  assert.doesNotMatch(s,/from ['\"]\.\.\/live\//);
 }
 const reconcile=source('src/live/reconcile.ts');
 assert.match(reconcile,/stripe_webhook_events/);
 assert.match(reconcile,/ON CONFLICT\(id\)/);
 assert.match(reconcile,/FOR UPDATE/);
 assert.match(reconcile,/COMMIT/);
 assert.match(reconcile,/stripe_live_collected/);
 assert.doesNotMatch(reconcile,/transfers\.create|payouts\.create|refunds\.create/);
});
