import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { db } from './db.js';
import { deliverStageMailBatch } from './email.js';

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
  await db.stripeWebhookEvent.update({
    where: { id: entry.id },
    data: { status: 'PROCESSED', processedAt: new Date() },
  });
  return { recorded: true };
}, { connection, concurrency: 2 });
worker.on('failed', (_job, error) => console.error('STAGING_RECEIPT_FAILED', error.name));
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
  await worker.close();
  connection.disconnect();
  await db.$disconnect();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
