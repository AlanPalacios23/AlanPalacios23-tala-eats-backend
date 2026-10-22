import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=(file)=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('RC7 cannot allow Stripe LIVE and requires TEST credentials',()=>{
 const config=read('src/config.ts');
 assert.match(config,/NODE_ENV: z\.literal\('staging'\)/);
 assert.match(config,/STRIPE_SECRET_KEY: z\.string\(\)\.startsWith\('sk_test_'\)/);
 assert.match(config,/STRIPE_PUBLISHABLE_KEY: z\.string\(\)\.startsWith\('pk_test_'\)/);
 assert.match(config,/STRIPE_FINANCIAL_WRITES_ENABLED: z\.literal\('false'\)/);
 assert.match(config,/STAGE_STRIPE_TEST_CHECKOUT_ENABLED: z\.enum\(\['false','true'\]\)\.default\('false'\)/);
 assert.match(config,/STAGE_STRIPE_TEST_REQUIRES_ISOLATED_AUTH_KEYS_AND_NO_LIVE_WRITES/);
});

test('TEST checkout creates only pickup order; client cannot choose amount',()=>{
 const checkout=read('src/marketplace/checkout.ts');
 assert.match(checkout,/order_type:z\.literal\('pickup'\)/);
 assert.match(checkout,/payment_method:z\.enum\(\['cash','stripe'\]\)/);
 assert.match(checkout,/isStripePickupIntent/);
 assert.match(checkout,/status:testStripe\?'awaiting_payment':'received'/);
 assert.match(checkout,/SELECT id FROM users WHERE id=\$\{account\.id\} FOR UPDATE/);
 assert.match(checkout,/clientReference:data\.client_reference/);
});

test('Stripe TEST is buyer-authenticated, provider-idempotent and webhook-only release',()=>{
 const gateway=read('src/stage-stripe-test.ts');
 const parity=read('src/parity/routes.ts');
 const worker=read('src/worker.ts');
 assert.match(gateway,/order\.userId!==buyerId/);
 assert.match(gateway,/idempotencyKey:requestKey/);
 assert.match(gateway,/intent\.amount_received!==intent\.amount/);
 assert.match(gateway,/order\.paymentProviderId!==intent\.id/);
 assert.match(gateway,/where:\{id:orderId,paymentStatus:'pending',status:'awaiting_payment'\}/);
 assert.match(gateway,/idempotencyKey:'order:'\+orderId\+':stripe-test:collected'/);
 assert.match(parity,/createTestPaymentIntent/);
 assert.match(worker,/processStripeTestReceipt/);
 assert.doesNotMatch(gateway,/stripe\.transfers\.create|stripe\.payouts\.create|sk_live_/);
});

test('Unverified payments and payouts remain unavailable',()=>{
 const parity=read('src/parity/routes.ts');
 for(const scope of ['stripe_refund','stripe_split_settlement',
   'withdrawal_requires_verified_ledger_and_provider',
   'stripe_connect_oauth_provider_required',
   'cash_receipt_matching_not_reconciled']){
   assert.ok(parity.includes("financialUnavailable('"+scope+"')"),scope);
 }
 const schema=read('prisma/schema.prisma');
 assert.match(schema,/idempotencyKey\s+String\s+@unique/);
});
