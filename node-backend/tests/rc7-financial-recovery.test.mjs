import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const read=(path)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Stripe payment receipt is HELD when TEST checkout is disabled',()=>{
  const worker=read('src/worker.ts');
  assert.match(worker,/isPaymentEvent/);
  assert.match(worker,/STRIPE_TEST_RECEIPT_HELD_FEATURE_DISABLED/);
  const held=worker.indexOf('STRIPE_TEST_RECEIPT_HELD_FEATURE_DISABLED');
  const processed=worker.indexOf("status: 'PROCESSED'");
  assert.ok(held>=0&&processed>held,'not silently processed as receipt');
});

test('recovery only scans previously signed receipts and keeps bounded retries',()=>{
  const worker=read('src/worker.ts');
  assert.match(worker,/stripeWebhookEvent.findMany/);
  assert.match(worker,/status:'FAILED'/);
  assert.match(worker,/receivedAt:\{gt:new Date\(Date\.now\(\)-48\*60\*60\*1000\)\}/);
  assert.match(worker,/take:20/);
  assert.match(worker,/lastErrorAt:\{lt:new Date\(Date\.now\(\)-5\*60_000\)\}/);
  assert.match(worker,/jobId:'recover-'/);
  assert.match(worker,/await closeQueue\(\)/);
  assert.match(read('src/webhook.ts'),/constructEvent/);
});

test('only buyer can read their payment state, no client secret, no fake success',()=>{
  const parity=read('src/parity/routes.ts');
  const first=parity.indexOf("parityRouter.get('/payments/stripe/orders/:orderId/status'");
  const last=parity.indexOf("parityRouter.post('/payments/stripe/orders/:orderId/payment-intent'",first);
  assert.ok(first>0&&last>first);
  const code=parity.slice(first,last);
  assert.match(code,/account\(req,\['customer'\]\)/);
  assert.match(code,/order\.userId!==who\.id/);
  assert.match(code,/memoPrivate\(res\)/);
  assert.match(code,/stageFinancialLedgerEntry.findUnique/);
  assert.match(code,/receipt\.amount\.toFixed\(2\)===order\.total\.toFixed\(2\)/);
  assert.match(code,/confirmed_by_server:confirmed/);
  assert.match(code,/requires_manual_review:/);
  assert.doesNotMatch(code,/client_secret|publishable_key|paymentIntents\.create/);
});

test('cancellation of uncharged TEST orders tolerates zero contribution margin',()=>{
  const lifecycle=read('src/marketplace/lifecycle.ts');
  assert.match(lifecycle,/new Set\(ledger\.map\(e=>e\.account\)\)\.size!==ledger\.length/);
  assert.match(lifecycle,/const required=\['gmv','restaurant_payable'\]/);
  assert.match(lifecycle,/if\(stripe&&ledger\.length!==0\)/);
  assert.match(lifecycle,/old\.direction==='credit'\?'debit':'credit'/);
  assert.match(lifecycle,/order\.paymentProviderId!==canceledIntent/);
});

test('Kali wizard/preflight fail closed and never place keys in code',()=>{
  const wizard=read('scripts/kali-stripe-test-secret-wizard.sh');
  const preflight=read('scripts/rc7-kali-finance-preflight.sh');
  for(const script of [wizard,preflight]){
    assert.match(script,/STRIPE_FINANCIAL_WRITES_ENABLED/);
    assert.match(script,/tala-node-stage/);
    const check=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
    assert.equal(check.status,0,check.stderr);
  }
  assert.match(preflight,/RC7_PREFLIGHT_READ_ONLY=PASS/);
  assert.match(preflight,/STRIPE_TEST_CHECKOUT_ENABLED=true/);
  assert.doesNotMatch(preflight,/sk_live_[A-Za-z0-9]/);
  assert.match(wizard,/STRIPE_TEST_CHECKOUT_STILL_DISABLED=YES/);
});

test('TEST Stripe cannot accrue GMV or merchant liability before verified payment',()=>{
 const checkout=read('src/marketplace/checkout.ts');
 const receipt=read('src/stage-stripe-test.ts');
 assert.match(checkout,/if\(!cardStripe\)\{/);
 assert.match(checkout,/cash-only accrual; Stripe is posted atomically on confirmed charge/);
 const start=receipt.indexOf('if(event.type===\'payment_intent.succeeded\')');
 const ledger=receipt.indexOf("const accrual=[",start);
 const state=receipt.indexOf("data:{paymentStatus:'paid',status:'received'}",start);
 assert.ok(state>start&&ledger>state,'ledger after payment success branch');
 assert.match(receipt,/existingAccrual!==0/);
 assert.match(receipt,/kind:'order_settlement'/);
 assert.match(receipt,/idempotencyKey:'order:'\+orderId\+':ledger:'\+accountName/);
 assert.match(receipt,/idempotencyKey:'order:'\+orderId\+':stripe-test:collected'/);
 const outbox=receipt.indexOf("eventKey:'order:'\+orderId\+':created'",ledger);
 assert.ok(outbox>ledger,'order.created only after provider charge');
});

test('abandoned TEST pickup reservations expire only after Stripe safe cancel',()=>{
  const worker=read('src/worker.ts');
  const life=read('src/marketplace/lifecycle.ts');
  const stripe=read('src/stage-stripe-test.ts');
  assert.match(worker,/expireAbandonedTestPickups/);
  assert.match(worker,/createdAt:\{lt:new Date\(Date\.now\(\)-35\*60_000\)\}/);
  assert.match(worker,/paymentProviderId:\{not:STRIPE_INTENT_RESERVATION\}/);
  assert.match(worker,/take:10/);
  assert.match(worker,/await cancelCashPickupStage\(item\.id,user/);
  assert.match(life,/cancelUnpaidStripeTestIntent\(orderId,actor\.id\)/);
  assert.match(stripe,/paymentIntents\.cancel/);
  assert.match(stripe,/intent\.amount_received!==0/);
  assert.match(worker,/STRIPE_TEST_EXPIRY_HELD/);
});

test('no accounts payable or order-created dispatch before Stripe TEST receipt',()=>{
  const checkout=read('src/marketplace/checkout.ts');
  const processor=read('src/stage-stripe-test.ts');
  assert.match(checkout,/if\(!cardStripe\)\{/);
  assert.match(checkout,/if\(cardStripe&&account\.role!=='customer'\)/);
  assert.match(processor,/existingAccrual!==0/);
  assert.match(processor,/eventKey:'order:'\+orderId\+':created'/);
  assert.match(processor,/account:'stripe_test_collected'/);
});

test('route inventory grants only reviewed node-only Stripe status endpoint',()=>{
  const inventory=read('scripts/node_route_coverage.py');
  assert.match(inventory,/STRIPE_TEST_STATUS_NODE_ONLY/);
  assert.match(inventory,/\("GET", "\/api\/v1\/payments\/stripe\/orders\/\{\}\/status"\)/);
  assert.match(inventory,/observed != \(ADMIN_NODE_ONLY \| STRIPE_TEST_STATUS_NODE_ONLY/);
  assert.match(inventory,/PASSWORD_RESET_BROWSER_NODE_ONLY/);
  assert.match(inventory,/PICKUP_PRICE_PREVIEW_NODE_ONLY/);
});
