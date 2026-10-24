import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['staging','production']),
  HOST: z.literal('127.0.0.1'),
  PORT: z.coerce.number().int().min(1024).max(65535),
  // RC8.13: opt-in parallel stage; never reuse the currently LIVE port 18190.
  STAGE_PARALLEL_ENABLED: z.enum(['false','true']).default('false'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().regex(/^(?:sk_test_|rk_test_|(?:sk|rk)_live_)[A-Za-z0-9]+$/).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_(?:test|live)_[A-Za-z0-9]+$/).optional(),
  STAGE_STRIPE_TEST_CHECKOUT_ENABLED: z.enum(['false','true']).default('false'),
  STRIPE_FINANCIAL_WRITES_ENABLED: z.enum(['false','true']).default('false'),
  STRIPE_LIVE_ENABLED: z.enum(['false','true']).default('false'),
  STRIPE_LIVE_RELEASE_APPROVED: z.enum(['false','true']).default('false'),
  STRIPE_REFUNDS_ENABLED: z.enum(['false','true']).default('false'),
  STRIPE_CONNECT_TRANSFERS_ENABLED: z.enum(['false','true']).default('false'),
  STRIPE_MANUAL_SETTLEMENT_APPROVED: z.enum(['false','true']).default('false'),
  STRIPE_PLATFORM_ACCOUNT_ID: z.string().regex(/^acct_[A-Za-z0-9]+$/).optional(),
  STRIPE_LIVE_MAX_ORDER_MINOR: z.coerce.number().int().min(100).max(50000).default(50000),
  AUTH_V02_ENABLED: z.enum(['false', 'true']).default('false'),
  MARKETPLACE_B_ENABLED: z.enum(['false','true']).default('false'),
  STAGE_SUPPORT_EMAIL: z.email().optional(),
  // Email sending is opt-in and restricted to an explicit staging recipient allowlist.
  STAGE_EMAIL_DELIVERY_MODE: z.enum(['disabled','resend']).default('disabled'),
  STAGE_EMAIL_RESEND_API_KEY: z.string().min(12).optional(),
  STAGE_EMAIL_FROM: z.string().min(6).max(220).optional(),
  STAGE_EMAIL_ALLOWED_RECIPIENTS: z.string().optional(),
  STAGE_DRIVER_DELIVERY_ENABLED: z.enum(['false','true']).default('false'),
  STAGE_DRIVER_MAX_PICKUP_KM: z.coerce.number().finite().min(1).max(30).default(8),
  STAGE_DELIVERY_CASH_CHECKOUT_ENABLED: z.enum(['false','true']).default('false'),
  STAGE_DELIVERY_STRIPE_TEST_ENABLED: z.enum(['false','true']).default('false'),
  STAGE_PICKUP_CASH_CHECKOUT_ENABLED: z.enum(['false','true']).default('false'),
  // Stage checkout supports default Python v1.5.2 or v1.6.2 pricing.
  // Select v1.6.2 explicitly only after PG15 stage review; custom overrides fail closed.
  COMMERCIAL_PRICING_V152_ENABLED: z.literal('true').default('true'),
  COMMERCIAL_PRICING_V162_ENABLED: z.enum(['false','true']).default('false'),
  MERCHANT_MANAGED_DELIVERY: z.enum(['false','true']).default('false'),
  SCHEDULE_PREP_LEAD_MINUTES: z.coerce.number().int().min(5).max(360).default(45),
  AUTH_JWT_SECRET: z.string().min(40).optional(),
});
// Stripe is the only online payment provider in this Node release.
// Reject accidentally imported Mercado Pago secrets even with writes off.
const forbiddenPaymentKeys = Object.keys(process.env).filter(k =>
  /^MERCADOPAGO_/i.test(k) || /^(MP_ACCESS_TOKEN|MP_PUBLIC_KEY|MP_WEBHOOK_SECRET)$/i.test(k));
if (forbiddenPaymentKeys.length) {
  throw new Error('STAGING_STRIPE_ONLY_FORBIDS_MERCADOPAGO_ENV');
}
export const config = schema.parse(process.env);
if(config.STAGE_EMAIL_DELIVERY_MODE==='resend') {
  if(!config.STAGE_EMAIL_RESEND_API_KEY?.startsWith('re_') ||
     !config.STAGE_EMAIL_FROM?.includes('@') ||
     !config.STAGE_EMAIL_ALLOWED_RECIPIENTS?.split(',').some(x=>z.email().safeParse(x.trim()).success)) {
    throw new Error('STAGING_EMAIL_PROVIDER_REQUIRES_VERIFIED_SENDER_AND_RECIPIENT_ALLOWLIST');
  }
}
const pg = new URL(config.DATABASE_URL);
const redis = new URL(config.REDIS_URL);
if(config.NODE_ENV==='staging'){
  if(config.PORT!==(config.STAGE_PARALLEL_ENABLED==='true'?18192:18190)||
     !['postgres:','postgresql:'].includes(pg.protocol)||
     pg.hostname!=='127.0.0.1'||pg.port!=='15435'||
     pg.pathname!=='/tala_node_stage'||pg.username!=='tala_node_stage'||
     !pg.password||/REPLACE|CHANGE/i.test(pg.password))
    throw new Error('STAGING_POSTGRES_ISOLATION_REQUIRED');
  if(!['redis:','rediss:'].includes(redis.protocol)||
     redis.hostname!=='127.0.0.1'||redis.port!=='16379'||
     redis.pathname!=='/0'||!redis.password||
     /REPLACE|CHANGE/i.test(redis.password))
    throw new Error('STAGING_REDIS_ISOLATION_REQUIRED');
  if(config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
     config.STRIPE_LIVE_ENABLED!=='false'||
     config.STRIPE_LIVE_RELEASE_APPROVED!=='false'||
     config.STRIPE_REFUNDS_ENABLED!=='false'||
     config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
     config.STRIPE_MANUAL_SETTLEMENT_APPROVED!=='false')
    throw new Error('STAGING_MONEY_WRITES_FORBIDDEN');
  if(config.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/.test(config.STRIPE_SECRET_KEY))
    throw new Error('STAGING_REQUIRES_STRIPE_TEST_KEY');
  if(config.STRIPE_PUBLISHABLE_KEY&&!config.STRIPE_PUBLISHABLE_KEY.startsWith('pk_test_'))
    throw new Error('STAGING_REQUIRES_STRIPE_TEST_PUBLISHABLE');
}else{
  // Same public PM2 port/domain. Separate authenticated production data,
  // new customer auth and signed Stripe LIVE only. All settings fail closed.
  if(config.STAGE_PARALLEL_ENABLED==='true')
    throw new Error('PARALLEL_STAGE_MODE_FORBIDDEN_IN_LIVE');
  if(config.HOST!=='127.0.0.1'||config.PORT!==18190||
     !['postgres:','postgresql:'].includes(pg.protocol)||
     !pg.username||!pg.password||!pg.hostname||
     (pg.hostname==='127.0.0.1'&&pg.port==='15435')||
     pg.pathname==='/tala_node_stage'||pg.username==='tala_node_stage')
    throw new Error('LIVE_PRODUCTION_POSTGRES_ISOLATION_REQUIRED');
  if(!['redis:','rediss:'].includes(redis.protocol)||
     !redis.password||!redis.hostname||
     (redis.hostname==='127.0.0.1'&&redis.port==='16379'&&
      (redis.pathname===''||redis.pathname==='/0')))
    throw new Error('LIVE_PRODUCTION_REDIS_ISOLATION_REQUIRED');
  if(config.AUTH_V02_ENABLED!=='true'||config.MARKETPLACE_B_ENABLED!=='true'||
     !config.AUTH_JWT_SECRET||
     config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='false'||
     config.STAGE_DRIVER_DELIVERY_ENABLED!=='false'||
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='false'||
     config.STAGE_DELIVERY_STRIPE_TEST_ENABLED!=='false')
    throw new Error('LIVE_MARKETPLACE_AUTH_AND_TEST_ISOLATION_REQUIRED');
  if(config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false')
    throw new Error('LIVE_CONNECT_PAYOUTS_REQUIRE_SEPARATE_AUDIT');
  if(!config.STRIPE_PLATFORM_ACCOUNT_ID||
     !config.STRIPE_SECRET_KEY||!/^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY)||
     !config.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_live_')||
     !config.STRIPE_WEBHOOK_SECRET)
    throw new Error('LIVE_STRIPE_SECRETS_REQUIRED');
  // Production can boot in explicit standby with cards OFF. Never allow
  // any partially enabled combination (including refunds) to start.
  const financialFlags=[config.STRIPE_LIVE_ENABLED,
    config.STRIPE_LIVE_RELEASE_APPROVED,config.STRIPE_FINANCIAL_WRITES_ENABLED,
    config.STRIPE_REFUNDS_ENABLED,config.STRIPE_MANUAL_SETTLEMENT_APPROVED];
  if(!financialFlags.every(v=>v==='true')&&
     !financialFlags.every(v=>v==='false'))
    throw new Error('LIVE_FINANCIAL_RELEASE_NOT_APPROVED');
}
if (config.STRIPE_SECRET_KEY?.includes('CHANGE') ||
    config.STRIPE_WEBHOOK_SECRET?.includes('CHANGE')) {
  throw new Error('STAGING_STRIPE_PLACEHOLDER_FORBIDDEN');
}

if (config.AUTH_V02_ENABLED === 'true' && !config.AUTH_JWT_SECRET) {
  throw new Error('STAGING_AUTH_V02_REQUIRES_NEW_40_CHAR_SECRET');
}

if (config.MARKETPLACE_B_ENABLED === 'true' && config.AUTH_V02_ENABLED !== 'true') {
  throw new Error('MARKETPLACE_STAGE_REQUIRES_AUTH_V02');
}

if (config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED === 'true' &&
    (config.MARKETPLACE_B_ENABLED !== 'true' ||
      config.AUTH_V02_ENABLED !== 'true')) {
  throw new Error('STAGE_PICKUP_CHECKOUT_REQUIRES_MARKETPLACE_AND_AUTH');
}

if(config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED==='true' &&
   (config.NODE_ENV!=='staging'||
    config.AUTH_V02_ENABLED!=='true' || config.MARKETPLACE_B_ENABLED!=='true' ||
    !config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET || !config.STRIPE_PUBLISHABLE_KEY ||
    config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false')){
  throw new Error('STAGE_STRIPE_TEST_REQUIRES_ISOLATED_AUTH_KEYS_AND_NO_LIVE_WRITES');
}

if(config.STAGE_DRIVER_DELIVERY_ENABLED==='true' &&
  (config.MARKETPLACE_B_ENABLED!=='true'||config.AUTH_V02_ENABLED!=='true'||
   config.MERCHANT_MANAGED_DELIVERY==='true')){
  throw new Error('STAGE_DRIVER_DELIVERY_REQUIRES_ISOLATED_AUTH_AND_MARKETPLACE');
}

if(config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&(
    config.NODE_ENV!=='staging'||
    config.AUTH_V02_ENABLED!=='true'||
    config.MARKETPLACE_B_ENABLED!=='true'||
    config.STAGE_DRIVER_DELIVERY_ENABLED!=='true'||
    config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'||
    config.MERCHANT_MANAGED_DELIVERY!=='false'||
    config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false')){
  throw new Error('RC87_DELIVERY_CASH_REQUIRES_ISOLATED_DRIVER_STAGE');
}

if(config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true'&&(
    config.NODE_ENV!=='staging'||
    config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true'||
    config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true'||
    config.STAGE_DRIVER_DELIVERY_ENABLED!=='true'||
    config.MERCHANT_MANAGED_DELIVERY!=='false'||
    !config.STRIPE_SECRET_KEY||
    !/^(sk|rk)_test_/.test(config.STRIPE_SECRET_KEY)||
    !config.STRIPE_WEBHOOK_SECRET||
    !config.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')||
    config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
    config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false')){
  throw new Error('RC810_TEST_DELIVERY_REQUIRES_SIGNED_STRIPE_TEST_ONLY');
}
