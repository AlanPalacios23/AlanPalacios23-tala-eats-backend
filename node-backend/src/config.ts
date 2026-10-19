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
  AUTH_JWT_SECRET: z.string().min(40).optional(),
});
export const config = schema.parse(process.env);
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
