import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.literal('staging'),
  HOST: z.literal('127.0.0.1'),
  PORT: z.coerce.number().int().min(1024).max(65535),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_test_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
  STRIPE_FINANCIAL_WRITES_ENABLED: z.literal('false'),
  AUTH_V02_ENABLED: z.enum(['false', 'true']).default('false'),
  MARKETPLACE_B_ENABLED: z.enum(['false','true']).default('false'),
  STAGE_SUPPORT_EMAIL: z.email().optional(),
  // Email sending is opt-in and restricted to an explicit staging recipient allowlist.
  STAGE_EMAIL_DELIVERY_MODE: z.enum(['disabled','resend']).default('disabled'),
  STAGE_EMAIL_RESEND_API_KEY: z.string().min(12).optional(),
  STAGE_EMAIL_FROM: z.string().min(6).max(220).optional(),
  STAGE_EMAIL_ALLOWED_RECIPIENTS: z.string().optional(),
  STAGE_DRIVER_DELIVERY_ENABLED: z.enum(['false','true']).default('false'),
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
if (config.PORT!==18190 ||
    !['postgres:', 'postgresql:'].includes(pg.protocol) ||
    pg.hostname!=='127.0.0.1' || pg.port!=='15435' ||
    pg.pathname!=='/tala_node_stage' || pg.username!=='tala_node_stage' ||
    !pg.password || /REPLACE|CHANGE/i.test(pg.password)) {
  throw new Error('STAGING_POSTGRES_ISOLATION_REQUIRED');
}
if (!['redis:', 'rediss:'].includes(redis.protocol) ||
    redis.hostname!=='127.0.0.1' || redis.port!=='16379' ||
    redis.pathname!=='/0' || !redis.password ||
    /REPLACE|CHANGE/i.test(redis.password)) {
  throw new Error('STAGING_REDIS_ISOLATION_REQUIRED');
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

if(config.STAGE_DRIVER_DELIVERY_ENABLED==='true' &&
  (config.MARKETPLACE_B_ENABLED!=='true'||config.AUTH_V02_ENABLED!=='true'||
   config.MERCHANT_MANAGED_DELIVERY==='true')){
  throw new Error('STAGE_DRIVER_DELIVERY_REQUIRES_ISOLATED_AUTH_AND_MARKETPLACE');
}
