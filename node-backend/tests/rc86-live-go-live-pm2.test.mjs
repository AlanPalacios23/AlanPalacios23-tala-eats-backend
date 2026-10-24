import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(path.join(root,p),'utf8');
test('LIVE PM2 activation script is valid Bash and restricted to explicit consent',()=>{
 const filename=path.join(root,'scripts/rc86-stripe-live-go-live-pm2.sh');
 const result=spawnSync('bash',['-n',filename],{encoding:'utf8',timeout:8000});
 assert.equal(result.status,0,result.stderr);
 const sh=read('scripts/rc86-stripe-live-go-live-pm2.sh');
 for(const x of ['--plan','--apply','I_AUTHORIZE_STRIPE_LIVE_CHARGES',
   'PRE_LIVE_DATABASE_BACKUP=PASS','LIVE_ENV_ROLLBACK=ATTEMPTED',
   'PUBLIC_PM2_ROLLBACK=START','pm2 save','rc86-live-activation-audit.mjs',
   'STRIPE_CONNECT_TRANSFERS=OFF','SIGNED_PAYMENT_WEBHOOK_E2E=STILL_REQUIRES_REAL_PAYMENT_TEST']){
  assert.ok(sh.includes(x),x);
 }
 assert.doesNotMatch(sh,/paymentIntents\.create|transfers\.create|payouts\.create|refunds\.create|prisma migrate deploy/);
});
test('actual order creation and PaymentIntent both require seller approval',()=>{
 const app=read('src/app.ts');
 assert.match(app,/SELLER_CONNECT_NOT_APPROVED/);
 assert.match(app,/SELLER_CONNECT_NOT_READY/);
 assert.match(app,/PAYMENT_MERCHANT_AUDIT_UNAVAILABLE/);
 assert.match(app,/remote\.id===config\.STRIPE_PLATFORM_ACCOUNT_ID/);
 assert.match(app,/owner_approved_at/);
 assert.match(app,/app\.post\(\['\/api\/v1\/orders\/:id\/stripe\/payment-intent'/);
 assert.match(app,/LIVE_CARD_CHECKOUT_NOT_APPROVED/);
});
test('Stripe activation audit never mutates Stripe or database',()=>{
 const audit=read('scripts/rc86-live-activation-audit.mjs');
 assert.match(audit,/method:'GET'/);
 assert.match(audit,/inspectLiveFinancialData/);
 assert.match(audit,/STRIPE_WEBHOOK_EVENTS=PASS/);
 assert.match(audit,/WARNING_NO_RESTAURANT_CAN_ACCEPT_LIVE_PAYMENTS_YET/);
 assert.doesNotMatch(audit,/paymentIntents\.create|transfers\.create|payouts\.create|refunds\.create|INSERT INTO|UPDATE [A-Z]|DELETE FROM/);
});
