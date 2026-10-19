import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';
import { db } from './db.js';

// Nunca cobra ni transfiere dinero; únicamente marca un evento test verificado.
const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
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
console.log('TALA_STAGE_WORKER_RUNNING');
async function shutdown() {
  await worker.close();
  connection.disconnect();
  await db.$disconnect();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
