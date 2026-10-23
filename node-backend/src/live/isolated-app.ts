/**
 * Isolated RC8 application composition. Importing this file makes no network
 * connections and does not change RC7. Production operator must provide
 * independent authenticated Postgres, Redis and signed Stripe client.
 */
import express from 'express';
import helmet from 'helmet';
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import type {Redis} from 'ioredis';
import type {ValidatedLiveSettings} from './guard.js';
import type {LiveStripeApi} from './stripe-payments.js';
import {buildIsolatedCheckoutRouter} from './checkout-router.js';
import {buildIsolatedWebhookRouter} from './webhook-router.js';
import {inspectLiveFinancialData} from './financial-readiness.js';

type Deps={
  settings:ValidatedLiveSettings;
  authSecret:string;
  pool:Pool;
  redis:Pick<Redis,'eval'>;
  stripe:LiveStripeApi;
  // Must remain false until independent release/rollback + refunds signed off.
  checkoutApproved:boolean;
};
export function buildIsolatedLiveApp(deps:Deps){
 const app=express();
 app.disable('x-powered-by');
 app.use(helmet());
 app.use((_req,res,next)=>{
   res.setHeader('Cache-Control','no-store');
   next();
 });
 // Stripe signature is verified against the exact raw request body.
 app.use('/api/v1/webhooks',buildIsolatedWebhookRouter(
   deps.stripe as Pick<Stripe,'webhooks'>,deps.pool,deps.settings));
 app.use(express.json({limit:'32kb',strict:true}));
 app.get('/api/v1/health',(_req,res)=>res.json({
  status:'ok',version:'rc8-isolated-service',
  checkoutEnabled:deps.checkoutApproved,
  transfersEnabled:false,
 }));
 app.get('/api/v1/ready',async(_req,res)=>{
  try{
   await deps.pool.query('SELECT 1');
   const audit=await inspectLiveFinancialData(deps.pool);
   const ready=deps.checkoutApproved &&
     audit.classification==='LIVE_FINANCIAL_DATA_PASS';
   res.status(ready?200:503).json({
     ready,productionReady:ready,
     liveCheckoutEnabled:deps.checkoutApproved,
     transfersEnabled:false,
     finance:audit.classification
   });
  }catch{
   res.status(503).json({
     ready:false,productionReady:false,
     error:'ISOLATED_PRODUCTION_DEPENDENCIES_NOT_READY'
   });
  }
 });
 app.use('/api/v1',buildIsolatedCheckoutRouter({
   enabled:deps.checkoutApproved,
   authSecret:deps.authSecret,
   pool:deps.pool,redis:deps.redis,
   stripe:deps.stripe,settings:deps.settings,
 }));
 return app;
}
