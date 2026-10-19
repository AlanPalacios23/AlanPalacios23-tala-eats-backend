import express from 'express';
import helmet from 'helmet';
import { Redis } from 'ioredis';
import { db } from './db.js';
import { config } from './config.js';
import { stripeWebhook } from './webhook.js';
import { authRouter } from './auth/routes.js';
import { platformRouter, platformErrors } from './platform/routes.js';
import { marketplaceRouter, ownerRouter, stageOrdersRouter,
  stageDriverRouter, marketplaceErrors } from './marketplace/routes.js';

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.post('/api/v1/webhooks/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),
  stripeWebhook);
app.use(express.json({ limit: '128kb' }));
// Opt-in only after dedicated stage auth migration and tested secret provisioning.
if (config.AUTH_V02_ENABLED === 'true') app.use('/api/v1/auth', authRouter);
if (config.MARKETPLACE_B_ENABLED === 'true') {
  app.use('/api/v1/restaurants', marketplaceRouter);
  app.use('/api/v1/owner', ownerRouter);
  app.use('/api/v1/orders', stageOrdersRouter);
  app.use('/api/v1/driver', stageDriverRouter);
  if(config.PLATFORM_E1_ENABLED==='true')app.use('/api/v1/platform',platformRouter);
  app.use(platformErrors);
  app.use(marketplaceErrors);
}
app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0-node-stage', production: false });
});
app.get('/api/v1/ready', async (_req, res) => {
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true, connectTimeout: 2000,
    maxRetriesPerRequest: 1, retryStrategy: () => null,
  });
  try {
    await db.$queryRawUnsafe('SELECT 1');
    await redis.connect();
    if (await redis.ping() !== 'PONG') throw new Error('redis_not_ready');
    res.json({ ready: true, database: true, redis: true, financialWrites: false });
  } catch {
    res.status(503).json({ ready: false });
  } finally {
    redis.disconnect();
  }
});
app.use((_req, res) => res.status(404).json({ error: 'not_implemented' }));
