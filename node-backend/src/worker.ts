import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { db } from './db.js';
import { deliverStageMailBatch } from './email.js';
import { processStripeTestReceipt } from './stage-stripe-test.js';
import { webhookQueue, closeQueue } from './queues.js';
import { cancelCashPickupStage } from './marketplace/lifecycle.js';
import { STRIPE_INTENT_RESERVATION } from './stage-stripe-test.js';

// Nunca cobra ni transfiere dinero; únicamente marca un evento test verificado.
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker('tala-node-staging-webhooks', async (job) => {
  if (job.name !== 'receipt' || typeof job.data?.eventId !== 'string') {
    throw new Error('INVALID_RECEIPT_JOB');
  }
  const entry = await db.stripeWebhookEvent.findUnique({
    where: { id: job.data.eventId },
  });
  if (!entry) throw new Error('EVENT_NOT_REGISTERED');
  if (entry.status === 'PROCESSED') return { alreadyProcessed: true };
  const isPaymentEvent=['payment_intent.succeeded',
    'payment_intent.payment_failed','payment_intent.canceled'].includes(entry.type);
  if(isPaymentEvent){
    if(config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true') {
      // Safety: if TEST mode was disabled mid-checkout, retain the signed
      // receipt for later reconciliation. NEVER fake a PROCESSED receipt.
      throw new Error('STRIPE_TEST_RECEIPT_HELD_FEATURE_DISABLED');
    }
    await processStripeTestReceipt(entry.id);
    const done=await db.stripeWebhookEvent.findUnique({where:{id:entry.id}});
    if(done?.status==='PROCESSED')return { testPaymentReconciled:true };
    throw new Error('STRIPE_TEST_RECEIPT_NOT_CONFIRMED');
  }
  // Non-financial events can be retained as staging receipts.
  await db.stripeWebhookEvent.update({
    where: { id: entry.id },
    data: { status: 'PROCESSED', processedAt: new Date() },
  });
  return { recorded: true };
}, { connection, concurrency: 2 });
worker.on('failed', (job, error) => {
  console.error('STAGING_RECEIPT_FAILED', error.name);
  const eventId=job?.data?.eventId;
  // Only after attempts are exhausted; the event remains auditable in PG.
  if(typeof eventId==='string'&&job&&
     job.attemptsMade>=(job.opts.attempts??4)){
    void db.stripeWebhookEvent.updateMany({
      where:{id:eventId,status:'RECEIVED'},
      data:{status:'FAILED',lastErrorAt:new Date()},
    }).catch(()=>console.error('STAGING_RECEIPT_FAILURE_PERSIST_ERROR'));
  }
});
// Re-enqueue only already signed, durable receipts that have not reconciled.
// Covers interrupted workers, exhausted BullMQ retries and feature-disabled
// windows. Never fabricates events, payments or changes financial balances.
let receiptSweepBusy=false;
async function sweepTestReceipts(){
  if(receiptSweepBusy||config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true')return;
  receiptSweepBusy=true;
  try{
    const pending=await db.stripeWebhookEvent.findMany({
      where:{
        type:{in:['payment_intent.succeeded','payment_intent.payment_failed',
          'payment_intent.canceled']},
        OR:[
          {status:'RECEIVED',receivedAt:{lt:new Date(Date.now()-15_000)}},
          {status:'FAILED',lastErrorAt:{lt:new Date(Date.now()-5*60_000)}},
        ],
        receivedAt:{gt:new Date(Date.now()-48*60*60*1000)},
      },
      orderBy:{receivedAt:'asc'},take:20,select:{id:true},
    });
    const slot=Math.floor(Date.now()/60_000);
    for(const entry of pending){
      await webhookQueue.add('receipt',{eventId:entry.id},{
        jobId:'recover-'+entry.id+'-'+slot,attempts:4,
      });
    }
  }catch(err){
    console.error('STRIPE_TEST_RECEIPT_SWEEP_FAILED',
      err instanceof Error?err.name:'unknown');
  }finally{receiptSweepBusy=false;}
}
const receiptSweepTimer=setInterval(()=>{void sweepTestReceipts();},60_000);
void sweepTestReceipts();

// Conservative cleanup for abandoned TEST-only pickups. Before returning
// inventory, the cancellation routine verifies with Stripe that no payment
// was captured, or that the intent was canceled by Stripe. Unknown states,
// in-flight creation markers and payment success remain HELD for manual QA.
let testExpiryBusy=false;
async function expireAbandonedTestPickups(){
  if(testExpiryBusy||config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true')return;
  testExpiryBusy=true;
  try{
    const candidates=await db.marketOrder.findMany({
      where:{orderType:'pickup',paymentMethod:'stripe',
        paymentStatus:'pending',status:'awaiting_payment',
        paymentProviderId:{not:STRIPE_INTENT_RESERVATION},
        createdAt:{lt:new Date(Date.now()-35*60_000)}},
      select:{id:true,userId:true},orderBy:{createdAt:'asc'},take:10,
    });
    for(const item of candidates){
      try{
        const user=await db.authUser.findUnique({where:{id:item.userId}});
        if(!user||user.role!=='customer')continue;
        await cancelCashPickupStage(item.id,user,'Reserva de tarjeta TEST vencida');
      }catch(err){
        // No order id or payment data in logs. Fail closed: keep reservation.
        console.error('STRIPE_TEST_EXPIRY_HELD',
          err instanceof Error?err.name:'unknown');
      }
    }
  }catch(err){
    console.error('STRIPE_TEST_EXPIRY_SWEEP_FAILED',
      err instanceof Error?err.name:'unknown');
  }finally{testExpiryBusy=false;}
}
const testExpiryTimer=setInterval(()=>{void expireAbandonedTestPickups();},5*60_000);
void expireAbandonedTestPickups();
// A bounded Redis TTL confirms that the real PM2 worker event loop is alive;
// an API process alone must not be presented as an operationally complete app.
// Heartbeats never contain user identifiers, tokens or payment information.
const workerHeartbeatKey='tala:node:stage:worker:heartbeat';
async function publishWorkerHeartbeat(){
 try{await connection.set(workerHeartbeatKey,'online','EX',45);}
 catch{console.error('STAGE_WORKER_HEARTBEAT_UNAVAILABLE');}
}
const workerHeartbeatTimer=setInterval(()=>{void publishWorkerHeartbeat();},15_000);
void publishWorkerHeartbeat();
// An independent timer drains the existing PG outbox only when a provider is
// configured explicitly. Do not log addresses, tokens, or message bodies.
let mailBusy=false;
async function tickMail(){
 if(mailBusy)return;
 mailBusy=true;
 try{await deliverStageMailBatch();}
 catch(err){console.error('STAGE_MAIL_DELIVERY_ERROR',
   err instanceof Error?err.name:'unknown');}
 finally{mailBusy=false;}
}
const mailTimer=config.STAGE_EMAIL_DELIVERY_MODE==='resend'
 ? setInterval(()=>{void tickMail();},30_000):null;
if(mailTimer)void tickMail();
console.log('TALA_STAGE_WORKER_RUNNING');
async function shutdown() {
  if(mailTimer)clearInterval(mailTimer);
  clearInterval(workerHeartbeatTimer);
  clearInterval(receiptSweepTimer);
  clearInterval(testExpiryTimer);
  await worker.close();
  await closeQueue();
  connection.disconnect();
  await db.$disconnect();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
