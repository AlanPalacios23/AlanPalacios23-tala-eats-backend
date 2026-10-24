/**
 * ONE public PM2 API / worker, with independent production PG + Redis.
 * Factory is invoked only when NODE_ENV=production; importing never creates
 * Stripe charges or an independent public listener.
 */
import Stripe from 'stripe';
import {Redis} from 'ioredis';
import {config} from '../config.js';
import {validateLiveSettings,validateLiveStandbySettings,type ValidatedLiveSettings} from './guard.js';
import {productionPool} from './postgres-store.js';

export function liveSettingsFromProduction():ValidatedLiveSettings{
 if(config.NODE_ENV!=='production')
  throw Error('LIVE_MODE_REQUIRES_PRODUCTION');
 const validate=config.STRIPE_LIVE_ENABLED==='false'
  ?validateLiveStandbySettings:validateLiveSettings;
 return validate({
  nodeEnv:config.NODE_ENV,explicitlyEnabled:config.STRIPE_LIVE_ENABLED,
  readinessApproved:config.STRIPE_LIVE_RELEASE_APPROVED,
  key:config.STRIPE_SECRET_KEY??'',
  publishableKey:config.STRIPE_PUBLISHABLE_KEY??'',
  webhookSecret:config.STRIPE_WEBHOOK_SECRET??'',
  databaseUrl:config.DATABASE_URL,redisUrl:config.REDIS_URL,
  refundsEnabled:config.STRIPE_REFUNDS_ENABLED,
  transfersEnabled:config.STRIPE_CONNECT_TRANSFERS_ENABLED,
  manualSettlementApproved:config.STRIPE_MANUAL_SETTLEMENT_APPROVED,
  maxOrderMinor:String(config.STRIPE_LIVE_MAX_ORDER_MINOR),
 });
}
export function buildLiveRuntimeDependencies(){
 const settings=liveSettingsFromProduction();
 const pool=productionPool(settings);
 const redis=new Redis(settings.redisUrl,{
   lazyConnect:true,connectTimeout:3000,maxRetriesPerRequest:1,
   retryStrategy:()=>null,
 });
 const stripe=new Stripe(settings.secretKey,{maxNetworkRetries:1,timeout:10000});
 return {settings,pool,redis,stripe};
}
