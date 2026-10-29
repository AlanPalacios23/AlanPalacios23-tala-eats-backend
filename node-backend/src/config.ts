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
  // Separate endpoint secret for signed Connect events, disabled by default.
  TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED: z.enum(['false','true']).default('false'),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]{16,}$/).optional(),
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
  // LIVE authentication mail is independent of Stripe and deliberately OFF.
  // The sender domain must be verified at Resend before an operator enables
  // these values in the private LIVE env; never commit credentials to Git.
  LIVE_AUTH_EMAIL_DELIVERY_MODE: z.enum(['disabled','resend']).default('disabled'),
  LIVE_AUTH_EMAIL_SENDER_APPROVED: z.enum(['false','true']).default('false'),
  LIVE_AUTH_EMAIL_RESEND_API_KEY: z.string().min(12).optional(),
  LIVE_AUTH_EMAIL_FROM: z.email().max(220).optional(),

  // RC9.5: separate LIVE driver presence pilot; never enables checkout or dispatch.
  LIVE_DRIVER_PRESENCE_ENABLED: z.enum(['false','true']).default('false'),
  // RC9.6: future independent delivery release, all OFF; never reuse stage flags.
  LIVE_DELIVERY_DISPATCH_ENABLED: z.enum(['false','true']).default('false'),
  LIVE_DELIVERY_CARD_CHECKOUT_ENABLED: z.enum(['false','true']).default('false'),
  LIVE_DELIVERY_RELEASE_APPROVED: z.enum(['false','true']).default('false'),
  // Separate attestation that real Stripe TEST + GPS + PIN + signed webhooks completed.
  LIVE_DELIVERY_CARD_E2E_APPROVED: z.enum(['false','true']).default('false'),
  // RC12.2: cash at merchant pickup has independent LIVE release; staging flag is never authority in production.
  LIVE_PICKUP_CASH_CHECKOUT_ENABLED: z.enum(['false','true']).default('false'),
  LIVE_PICKUP_CASH_RELEASE_APPROVED: z.enum(['false','true']).default('false'),
  // RC11.2/11.3: independent CASH-at-door LIVE admission, NO Stripe charge.
  // All switches must be simultaneously released after an audited rollout.
  LIVE_DELIVERY_CASH_CHECKOUT_ENABLED: z.enum(['false','true']).default('false'),
  LIVE_DELIVERY_CASH_DISPATCH_ENABLED: z.enum(['false','true']).default('false'),
  LIVE_DELIVERY_CASH_RELEASE_APPROVED: z.enum(['false','true']).default('false'),
  LIVE_CASH_HANDOFF_V2_ENABLED: z.enum(['false','true']).default('false'),
  STAGE_CASH_HANDOFF_V2_ENABLED: z.enum(['false','true']).default('false'),
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
  WEB_PUSH_ENABLED: z.enum(['false','true']).default('false'),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{86,88}$/).optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{42,44}$/).optional(),
  WEB_PUSH_SUBJECT: z.string().regex(/^(mailto:.+@.+|https:\/\/[^/]+.*)$/).optional(),
});
// Stripe is the only online payment provider in this Node release.
// RC12.3 card delivery needs FOUR independent approvals. No partial rollout:
// an operator must first prove Stripe TEST 3-PWA E2E, signed capture,
// refund/dispute recovery, geo dispatch, PIN, and reversal/rollback.
const deliveryCardKeys=['LIVE_DELIVERY_DISPATCH_ENABLED',
 'LIVE_DELIVERY_CARD_CHECKOUT_ENABLED','LIVE_DELIVERY_RELEASE_APPROVED',
 'LIVE_DELIVERY_CARD_E2E_APPROVED'] as const;
const deliveryCardValues=deliveryCardKeys.map(k=>process.env[k]==='true');
if(deliveryCardValues.some(Boolean)&&!deliveryCardValues.every(Boolean))
 throw new Error('RC96_LIVE_DELIVERY_NOT_RELEASED_STRIPE_TEST_REQUIRED');
if(deliveryCardValues.every(Boolean)&&(
 process.env.NODE_ENV!=='production'||
 process.env.LIVE_DRIVER_PRESENCE_ENABLED!=='true'||
 process.env.MARKETPLACE_B_ENABLED!=='true'||
 process.env.AUTH_V02_ENABLED!=='true'||
 process.env.MERCHANT_MANAGED_DELIVERY==='true'||
 process.env.COMMERCIAL_PRICING_V162_ENABLED==='true'||
 ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
  'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
  'STRIPE_MANUAL_SETTLEMENT_APPROVED'].some(k=>process.env[k]!=='true')||
 ['STRIPE_CONNECT_TRANSFERS_ENABLED','STAGE_DRIVER_DELIVERY_ENABLED',
  'STAGE_DELIVERY_CASH_CHECKOUT_ENABLED',
  'STAGE_DELIVERY_STRIPE_TEST_ENABLED',
  'STAGE_STRIPE_TEST_CHECKOUT_ENABLED'].some(k=>process.env[k]==='true')
)) throw new Error('RC123_LIVE_CARD_DELIVERY_PRECONDITIONS_NOT_MET');

// LIVE cash pickup is a distinct release. A staging cash pickup flag cannot release it.
const liveCashPickupKeys=['LIVE_PICKUP_CASH_CHECKOUT_ENABLED','LIVE_PICKUP_CASH_RELEASE_APPROVED'] as const;
const liveCashPickupValues=liveCashPickupKeys.map(k=>process.env[k]==='true');
if(liveCashPickupValues.some(Boolean)&&!liveCashPickupValues.every(Boolean))
 throw Error('RC122_PARTIAL_LIVE_CASH_PICKUP_RELEASE_FORBIDDEN');
if(liveCashPickupValues.every(Boolean)&&(
 process.env.NODE_ENV!=='production'||process.env.MARKETPLACE_B_ENABLED!=='true'||
 process.env.AUTH_V02_ENABLED!=='true'||process.env.MERCHANT_MANAGED_DELIVERY==='true'||
 ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
  'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_MANUAL_SETTLEMENT_APPROVED']
 .some(k=>process.env[k]!=='true')))
 throw Error('RC122_LIVE_CASH_PICKUP_REQUIRES_APPROVED_PRODUCTION_SETTLEMENT');

// Production cash delivery is independent of the Stripe card-delivery lock.
const liveCashKeys=['LIVE_DELIVERY_CASH_CHECKOUT_ENABLED',
 'LIVE_DELIVERY_CASH_DISPATCH_ENABLED','LIVE_DELIVERY_CASH_RELEASE_APPROVED'] as const;
const liveCashValues=liveCashKeys.map(k=>process.env[k]==='true');
// Prevent release of the legacy driver-retains-cash path without merchant handoff.
if(liveCashValues.every(Boolean)&&process.env.LIVE_CASH_HANDOFF_V2_ENABLED!=='true')
 throw Error('RC135_CASH_DELIVERY_REQUIRES_MERCHANT_HANDOFF');
if(liveCashValues.some(Boolean)&&!liveCashValues.every(Boolean))
 throw Error('RC112_PARTIAL_LIVE_CASH_DELIVERY_RELEASE_FORBIDDEN');
if(liveCashValues.every(Boolean)&&(
 process.env.NODE_ENV!=='production'||process.env.LIVE_DRIVER_PRESENCE_ENABLED!=='true'||
 process.env.MERCHANT_MANAGED_DELIVERY==='true'||process.env.MARKETPLACE_B_ENABLED!=='true'||
 process.env.COMMERCIAL_PRICING_V162_ENABLED==='true'||
 process.env.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'||
 process.env.STAGE_DRIVER_DELIVERY_ENABLED==='true'))
 throw Error('RC112_LIVE_CASH_DELIVERY_REQUIRES_APPROVED_PRODUCTION_PRESENCE');

// Reject accidentally imported Mercado Pago secrets even with writes off.
const forbiddenPaymentKeys = Object.keys(process.env).filter(k =>
  /^MERCADOPAGO_/i.test(k) || /^(MP_ACCESS_TOKEN|MP_PUBLIC_KEY|MP_WEBHOOK_SECRET)$/i.test(k));
if (forbiddenPaymentKeys.length) {
  throw new Error('STAGING_STRIPE_ONLY_FORBIDS_MERCADOPAGO_ENV');
}
export const config = schema.parse(process.env);
if(config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED==='true'&&
   (!config.STRIPE_CONNECT_WEBHOOK_SECRET||
    config.STRIPE_CONNECT_WEBHOOK_SECRET===config.STRIPE_WEBHOOK_SECRET))
 throw Error('CONNECT_WEBHOOK_REQUIRES_SEPARATE_SIGNING_SECRET');
if(config.NODE_ENV==='staging'&&config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED==='true')
 throw Error('TREASURY_CONNECT_WEBHOOK_STAGE_HTTP_DISABLED');
if(config.WEB_PUSH_ENABLED==='true'&&
   (!config.WEB_PUSH_VAPID_PUBLIC_KEY||!config.WEB_PUSH_VAPID_PRIVATE_KEY||!config.WEB_PUSH_SUBJECT))
  throw new Error('WEB_PUSH_ENABLED_REQUIRES_VALID_VAPID_KEYS_AND_SUBJECT');
if(config.NODE_ENV==='staging'&&config.LIVE_DRIVER_PRESENCE_ENABLED==='true')
  throw new Error('STAGING_CANNOT_ENABLE_LIVE_DRIVER_PRESENCE');
if(config.NODE_ENV==='production'&&config.STAGE_EMAIL_DELIVERY_MODE==='resend')
 throw Error('STAGING_EMAIL_PROVIDER_FORBIDDEN_IN_PRODUCTION');
if(config.LIVE_AUTH_EMAIL_DELIVERY_MODE==='resend'){
 if(config.NODE_ENV!=='production'||config.LIVE_AUTH_EMAIL_SENDER_APPROVED!=='true'||
    !config.LIVE_AUTH_EMAIL_RESEND_API_KEY?.startsWith('re_')||
    !config.LIVE_AUTH_EMAIL_FROM)
  throw Error('LIVE_AUTH_EMAIL_REQUIRES_APPROVED_VERIFIED_RESEND_SENDER');
}
if(config.NODE_ENV!=='production'&&config.LIVE_AUTH_EMAIL_DELIVERY_MODE!=='disabled')
 throw Error('LIVE_AUTH_EMAIL_FORBIDDEN_IN_STAGING');
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
     redis.pathname!==(config.STAGE_PARALLEL_ENABLED==='true'?'/1':'/0')||!redis.password||
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

if(config.STAGE_CASH_HANDOFF_V2_ENABLED==='true'&&(
    config.NODE_ENV!=='staging'||
    config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true'||
    config.STAGE_DRIVER_DELIVERY_ENABLED!=='true'||
    config.STRIPE_LIVE_ENABLED!=='false'||
    config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
    config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false')){
  throw new Error('RC137_STAGING_CASH_HANDOFF_MUST_BE_DISPOSABLE');
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
