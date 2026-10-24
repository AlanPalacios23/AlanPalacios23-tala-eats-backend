import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=(file)=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('RC7 cannot allow Stripe LIVE and requires TEST credentials',()=>{
 const config=read('src/config.ts');
 assert.match(config,/NODE_ENV: z\.enum\(\['staging','production'\]\)/);
 assert.match(config,/STRIPE_SECRET_KEY: z\.string\(\)\.regex\(/);
 assert.match(config,/(?:sk_test_|rk_test_)/);
 assert.match(config,/STAGING_REQUIRES_STRIPE_TEST_PUBLISHABLE/);
 assert.match(config,/STAGING_MONEY_WRITES_FORBIDDEN/);
 assert.match(config,/STAGE_STRIPE_TEST_CHECKOUT_ENABLED: z\.enum\(\['false','true'\]\)\.default\('false'\)/);
 assert.match(config,/STAGE_STRIPE_TEST_REQUIRES_ISOLATED_AUTH_KEYS_AND_NO_LIVE_WRITES/);
});

test('TEST checkout creates only pickup order; client cannot choose amount',()=>{
 const checkout=read('src/marketplace/checkout.ts');
 assert.match(checkout,/order_type:z\.literal\('pickup'\)/);
 assert.match(checkout,/payment_method:z\.enum\(\['cash','stripe'\]\)/);
 assert.match(checkout,/isStripePickupIntent/);
 assert.match(checkout,/status:cardStripe\?'awaiting_payment':'received'/);
 assert.match(checkout,/SELECT id FROM users WHERE id=\$\{account\.id\} FOR UPDATE/);
 assert.match(checkout,/clientReference:data\.client_reference/);
});

test('Stripe TEST is buyer-authenticated, provider-idempotent and webhook-only release',()=>{
 const gateway=read('src/stage-stripe-test.ts');
 const parity=read('src/parity/routes.ts');
 const worker=read('src/worker.ts');
 assert.match(gateway,/order\.userId!==buyerId/);
 assert.match(gateway,/idempotencyKey:requestKey/);
 assert.match(gateway,/allowed_payment_method_types:\['card'\]/);
 assert.match(gateway,/allow_redirects:'never'/);
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

test('RC7 provider creation reserves database ID before Stripe API and keeps retries bounded',()=>{
 const gateway=read('src/stage-stripe-test.ts');
 const start=gateway.indexOf("data:{paymentProviderId:STRIPE_INTENT_RESERVATION}");
 const remote=gateway.indexOf("provider.paymentIntents.create");
 assert.ok(start>=0&&remote>start,'DB reservation must precede provider call');
 assert.match(gateway,/30\*60\*1000/);
 assert.match(gateway,/paymentProviderId:STRIPE_INTENT_RESERVATION/);
 assert.match(gateway,/pointer===STRIPE_INTENT_RESERVATION/);
});

test('RC7 Stripe pickup requires verified ledger and must not collect card as cash',()=>{
 const lifecycle=read('src/marketplace/lifecycle.ts');
 const pickup=read('src/marketplace/pickup.ts');
 assert.match(lifecycle,/order.paymentStatus==='paid'/);
 assert.match(lifecycle,/stripe_test_collected/);
 assert.match(pickup,/kind:live\?'stripe_live_payment':'stripe_test_payment'/);
 assert.match(pickup,/config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED==='true'/);
 assert.match(pickup,/liveCardEnabled/);
 assert.match(pickup,/cashCollected:cash\?order.total:'0.00'/);
 assert.match(pickup,/order.paymentStatus==='paid'/);
});

test('RC7 unpaid Stripe cancellation demands confirmed PSP cancel before stock restoration',()=>{
 const gateway=read('src/stage-stripe-test.ts');
 const lifecycle=read('src/marketplace/lifecycle.ts');
 assert.match(gateway,/export async function cancelUnpaidStripeTestIntent/);
 assert.match(gateway,/paymentIntents.cancel/);
 assert.match(gateway,/intent.status!=='canceled'/);
 assert.match(gateway,/intent.amount_received!==0/);
 const remote=lifecycle.indexOf('await cancelUnpaidStripeTestIntent(orderId,actor.id)');
 const dbTransaction=lifecycle.indexOf('return db.$transaction(async tx=>{',remote);
 assert.ok(remote>=0&&dbTransaction>remote);
 assert.match(lifecycle,/order.paymentProviderId!==canceledIntent/);
 assert.match(lifecycle,/inventoryRestoredAt:when/);
 assert.match(lifecycle,/kind:'order_cancellation'/);
});

test('Captured payments cannot be canceled by stock-only route',()=>{
 const lifecycle=read('src/marketplace/lifecycle.ts');
 assert.match(lifecycle,/order.paymentStatus!=='pending'/);
 assert.match(lifecycle,/order.status!=='awaiting_payment'/);
 const gateway=read('src/stage-stripe-test.ts');
 assert.match(gateway,/Pago ya confirmado o pedido no cancelable/);
});

test('Signed webhook redelivery is requeued while ledger remains idempotent',()=>{
 const incoming=read('src/webhook.ts');
 const processor=read('src/stage-stripe-test.ts');
 assert.match(incoming,/deliveryCount: \{ increment: 1 \}/);
 assert.match(incoming,/receipt\.deliveryCount/);
 assert.match(incoming,/constructEvent/);
 assert.match(processor,/receipt\.status==='PROCESSED'/);
 assert.match(processor,/idempotencyKey:'order:'\+orderId\+':stripe-test:collected'/);
});

test('restricted TEST keys are supported but no LIVE secrets',()=>{
 const config=read('src/config.ts');
 const wizard=read('scripts/kali-stripe-test-secret-wizard.sh');
 assert.match(config,/rk_test_/);
 assert.match(config,/sk_test_/);
 assert.match(wizard,/rk_test_/);
 assert.match(wizard,/STRIPE_LIVE_FINANCIAL_WRITES=DISABLED/);
 assert.doesNotMatch(config,/STRIPE_SECRET_KEY:\s*z\.string\(\)\.optional\(\)/);
});
