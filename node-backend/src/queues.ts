import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';
const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
export const webhookQueue = new Queue('tala-node-staging-webhooks', {
  connection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: false,
    removeOnFail: false,
  },
});
export async function closeQueue() {
  await webhookQueue.close();
  connection.disconnect();
}
