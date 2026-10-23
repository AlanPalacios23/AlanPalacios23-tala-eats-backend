import express from 'express';
import helmet from 'helmet';
import { Redis } from 'ioredis';
import {buildLiveRuntimeDependencies} from './live/runtime-dependencies.js';
import {buildIsolatedWebhookRouter} from './live/webhook-router.js';
import {buildIsolatedCheckoutRouter} from './live/checkout-router.js';
import {inspectLiveFinancialData} from './live/financial-readiness.js';
import { db } from './db.js';
import { config } from './config.js';
import { stripeWebhook } from './webhook.js';
import { authRouter } from './auth/routes.js';
import { platformRouter, platformErrors } from './platform/routes.js';
import { adminRouter, operationsRouter, opsErrors } from './operational/routes.js';
import { v9Router, v10Router, v11Router } from './versions/routes.js';
import { resilienceRouter, resilienceErrors } from './resilience/routes.js';
import { parityRouter, parityErrors } from './parity/routes.js';
import { marketplaceRouter, ownerRouter, stageOrdersRouter,
  stageDriverRouter, marketplaceErrors } from './marketplace/routes.js';

export const app = express();
const live=config.NODE_ENV==='production'?buildLiveRuntimeDependencies():null;
app.disable('x-powered-by');
app.use(helmet());
if(live){
  // Mount signed LIVE webhooks BEFORE JSON body parsing, at the CURRENT
  // Stripe Dashboard destination. Never accept TEST receipts in production.
  app.use('/api/v1/payments/stripe',buildIsolatedWebhookRouter(
    live.stripe,live.pool,live.settings,'/webhook'));
  app.use('/api/v1/webhooks',buildIsolatedWebhookRouter(
    live.stripe,live.pool,live.settings));
}else{
  app.post('/api/v1/webhooks/stripe',
    express.raw({type:'application/json',limit:'1mb'}),stripeWebhook);
}
app.use(express.json({ limit: '128kb' }));
// Existing order routes remain public. LIVE card PaymentIntents are created
// only for authenticated/customer-owned persisted Stripe pickup orders.
if(live){
  app.use('/api/v1',buildIsolatedCheckoutRouter({
    enabled:true,authSecret:config.AUTH_JWT_SECRET!,pool:live.pool,
    redis:live.redis,stripe:live.stripe,settings:live.settings,
  }));
  // Do not reserve customer stock when Stripe LIVE reconciliation is down.
  // This gate precedes POST /orders while preserving cash order semantics.
  app.use('/api/v1/orders',async(req,res,next)=>{
    if(req.method!=='POST'||req.path!=='/'||
       req.body?.payment_method!=='stripe'){next();return;}
    try{
      const audit=await inspectLiveFinancialData(live.pool);
      if(audit.classification!=='LIVE_FINANCIAL_DATA_PASS'){
        res.status(503).json({error:'LIVE_FINANCIAL_RECONCILIATION_HOLD'});
        return;
      }
      next();
    }catch{
      res.status(503).json({error:'LIVE_FINANCIAL_DATA_UNAVAILABLE'});
    }
  });
}
// Opt-in only after dedicated stage auth migration and tested secret provisioning.
if (config.AUTH_V02_ENABLED === 'true') app.use('/api/v1/auth', authRouter);
if (config.MARKETPLACE_B_ENABLED === 'true') {
  // Specific parity endpoints must precede generic /orders/:orderId routes.
  app.use('/api/v1', parityRouter);
  app.use('/api/v1/restaurants', marketplaceRouter);
  app.use('/api/v1/owner', ownerRouter);
  app.use('/api/v1/orders', stageOrdersRouter);
  app.use('/api/v1/driver', stageDriverRouter);
  app.use('/api/v1/platform', platformRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/operations', operationsRouter);
  app.use('/api/v1/v9', v9Router);
  app.use('/api/v1/v10', v10Router);
  app.use('/api/v1/v11', v11Router);
  app.use('/api/v1/resilience', resilienceRouter);
  app.use(parityErrors);
  app.use(resilienceErrors);
  app.use(opsErrors);
  app.use(platformErrors);
  app.use(marketplaceErrors);
}
app.get('/api/v1/health', (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.json({status:'ok',
    version:live?'rc8.3-live-pickup-pm2':'0.1.0-node-stripe-only-stage',
    production:Boolean(live),digital_payment_provider:'stripe',
    online_payment_writes:Boolean(live)});
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
    // Operational dependency reporting is advisory in staging because CI
    // deliberately tests the API without starting the worker. Never equate
    // HTTP /ready with authorization to take customer payments.
    const heartbeat=await redis.get(live
      ?'tala:node:live:worker:heartbeat'
      :'tala:node:stage:worker:heartbeat');
    let financialPass=false;
    if(live){
      const audit=await inspectLiveFinancialData(live.pool);
      financialPass=audit.classification==='LIVE_FINANCIAL_DATA_PASS';
    }
    const workerOnline=Boolean(heartbeat);
    const ready=!live||(workerOnline&&financialPass);
    res.setHeader('Cache-Control','no-store');
    res.status(ready?200:503).json({
      ready,database:true,redis:true,workerOnline,
      productionReady:Boolean(live&&ready),
      environment:live?'production':'staging',
      financialWrites:Boolean(live&&ready),
      digitalPaymentProvider:'stripe',
      onlinePaymentsEnabled:Boolean(live&&ready),
    });
  } catch {
    res.status(503).json({ ready: false });
  } finally {
    redis.disconnect();
  }
});
app.use((_req, res) => res.status(404).json({ error: 'not_implemented' }));
