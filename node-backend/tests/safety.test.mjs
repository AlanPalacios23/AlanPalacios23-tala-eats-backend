import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
test('PM2 only staging processes', () => {
  const pm=read('ecosystem.config.cjs');
  assert.match(pm, /tala-node-stage-api/);
  assert.match(pm, /tala-node-stage-worker/);
  assert.doesNotMatch(pm, /talaeats-v3-backend/);
});
test('hard isolation of database, Redis, port and Stripe', () => {
  const cfg=read('src/config.ts');
  for(const s of ['15435','16379','18190','sk_test_','STAGING_POSTGRES_ISOLATION_REQUIRED']) {
    assert.ok((cfg+read('.env.example')).includes(s),s);
  }
});
test('webhooks raw signed and never live', () => {
  const w=read('src/webhook.ts'), app=read('src/app.ts');
  assert.match(app,/express.raw/);
  assert.match(w,/constructEvent/);
  assert.match(w,/event.livemode/);
});
test('no financial payments or payouts executed', () => {
  for(const p of ['src/worker.ts','src/webhook.ts','src/queues.ts']) {
    assert.doesNotMatch(read(p),/stripe\.payouts\.create|stripe\.transfers\.create|stripe\.paymentIntents\.create/);
  }
});
test('Prisma uniqueness constraints prevent duplicate receipt IDs', () => {
  assert.match(read('prisma/schema.prisma'),/id\s+String\s+@id/);
  assert.match(read('prisma/schema.prisma'),/idempotencyKey\s+String\s+@unique/);
});
test('production connection not in repository', () => {
  assert.doesNotMatch(read('.env.example'),/sk_live_|rk_live_/);
  assert.match(read('.gitignore'),/\.env/);
});
