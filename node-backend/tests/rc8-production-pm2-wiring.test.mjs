import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=p=>readFileSync(path.join(root,p),'utf8');
const production={
 // This fixture models production independently of the caller's staging
 // flags. RC8.13's parallel stage uses true; production must use false.
 NODE_ENV:'production',HOST:'127.0.0.1',PORT:'18190',
 STAGE_PARALLEL_ENABLED:'false',
 DATABASE_URL:'postgresql://tala_live:longsecret@127.0.0.1:15445/tala_node_live',
 REDIS_URL:'redis://:longsecret@127.0.0.1:16389/1',
 STRIPE_PLATFORM_ACCOUNT_ID:'acct_'+'Z'.repeat(20),
 STRIPE_SECRET_KEY:'sk_live_'+'A'.repeat(30),
 STRIPE_PUBLISHABLE_KEY:'pk_live_'+'B'.repeat(30),
 STRIPE_WEBHOOK_SECRET:'whsec_'+'C'.repeat(30),
 STRIPE_LIVE_ENABLED:'true',STRIPE_LIVE_RELEASE_APPROVED:'true',
 STRIPE_FINANCIAL_WRITES_ENABLED:'true',STRIPE_REFUNDS_ENABLED:'true',
 STRIPE_MANUAL_SETTLEMENT_APPROVED:'true',
 STRIPE_CONNECT_TRANSFERS_ENABLED:'false',
 AUTH_V02_ENABLED:'true',MARKETPLACE_B_ENABLED:'true',
 AUTH_JWT_SECRET:'production-secret-no-real-key-'+'D'.repeat(48),
 STAGE_STRIPE_TEST_CHECKOUT_ENABLED:'false',
 STAGE_DRIVER_DELIVERY_ENABLED:'false',
};
const check=(overrides={})=>spawnSync(process.execPath,['--input-type=module','-e',
 "import('./dist/config.js').then(()=>process.stdout.write('CONFIG_OK')).catch(()=>process.exit(1))"
],{cwd:root,encoding:'utf8',timeout:9000,env:{...process.env,...production,...overrides}});
test('single-runtime production config can boot without staging resources or live Stripe API calls',()=>{
 const run=check();
 assert.equal(run.status,0,run.stderr);
 assert.match(run.stdout,/CONFIG_OK/);
});
test('production fails closed for missing approval, Stripe TEST, staging PG Redis, or Connect money movement',()=>{
 for(const [key,value] of [
  ['NODE_ENV','staging'],
  ['STRIPE_LIVE_ENABLED','false'],
  ['STRIPE_LIVE_RELEASE_APPROVED','false'],
  ['STRIPE_FINANCIAL_WRITES_ENABLED','false'],
  ['STRIPE_MANUAL_SETTLEMENT_APPROVED','false'],
  ['STRIPE_REFUNDS_ENABLED','false'],
  ['STRIPE_CONNECT_TRANSFERS_ENABLED','true'],
  ['STRIPE_SECRET_KEY','sk_test_'+'T'.repeat(30)],
  ['STRIPE_PUBLISHABLE_KEY','pk_test_'+'T'.repeat(30)],
  ['DATABASE_URL','postgresql://tala_node_stage:password@127.0.0.1:15435/tala_node_stage'],
  ['REDIS_URL','redis://:password@127.0.0.1:16379/0'],
  ['AUTH_V02_ENABLED','false'],['MARKETPLACE_B_ENABLED','false'],
  ['STAGE_STRIPE_TEST_CHECKOUT_ENABLED','true'],
  ['STAGE_PARALLEL_ENABLED','true'],
 ]){
   const result=check({[key]:value});
   assert.notEqual(result.status,0,key);
   assert.doesNotMatch(result.stdout,/CONFIG_OK/,key);
 }
});
test('production standby starts only with ALL financial flags OFF',()=>{
 const standby={STRIPE_LIVE_ENABLED:'false',STRIPE_LIVE_RELEASE_APPROVED:'false',
  STRIPE_FINANCIAL_WRITES_ENABLED:'false',STRIPE_REFUNDS_ENABLED:'false',
  STRIPE_MANUAL_SETTLEMENT_APPROVED:'false'};
 const run=check(standby);
 assert.equal(run.status,0,run.stderr);
 assert.match(run.stdout,/CONFIG_OK/);
 // A single true flag in standby must never activate a partial release.
 for(const name of Object.keys(standby)){
  const partial=check({...standby,[name]:'true'});
  assert.notEqual(partial.status,0,name);
 }
});
test('existing Flutter payment routes now have signed LIVE API with same user/worker names',()=>{
 const app=source('src/app.ts');
 const order=source('src/marketplace/checkout.ts');
 const router=source('src/live/checkout-router.ts');
 const status=source('src/parity/routes.ts');
 const pm2=source('ecosystem.production.config.cjs');
 assert.match(app,/config.NODE_ENV==='production'\?buildLiveRuntimeDependencies\(\):null/);
 assert.match(app,/app\.use\('\/api\/v1\/payments\/stripe',buildIsolatedWebhookRouter/);
 assert.match(app,/enabled:liveChargeApproved,authSecret:config.AUTH_JWT_SECRET!/);
 assert.match(app,/LIVE_FINANCIAL_RECONCILIATION_HOLD/);
 assert.match(order,/status:cardStripe\?'awaiting_payment':'received'/);
 assert.match(order,/if\(!cardStripe\)\{/);
 assert.match(router,/\/payments\/stripe\/orders\/:id\/payment-intent/);
 assert.match(status,/order:'\+id\+':stripe-live:collected'/);
 assert.match(status,/confirmed_by_server:verified/);
 assert.match(pm2,/name:'tala-node-stage-api'/);
 assert.match(pm2,/name:'tala-node-stage-worker'/);
 assert.match(pm2,/dist\/live\/production-worker\.js/);
 assert.doesNotMatch(pm2,/pm2 (?:start|restart|reload|delete)|docker compose/);
});


test('Kali production provisioning wizard is valid Python, secret-hidden and cannot activate charges',()=>{
 const file=path.join(root,'scripts','kali-rc83-live-env-wizard.py');
 const script=readFileSync(file,'utf8');
 const ast=spawnSync('python3',['-c','import ast,sys; ast.parse(sys.stdin.read())'],
   {input:script,encoding:'utf8'});
 assert.equal(ast.status,0,ast.stderr);
 assert.match(script,/getpass\.getpass/);
 assert.match(script,/os\.fchmod\(fd,0o600\)/);
 assert.match(script,/os\.replace\(temporary,TARGET\)/);
 for(const name of ['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
 'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
 'STRIPE_MANUAL_SETTLEMENT_APPROVED','STRIPE_CONNECT_TRANSFERS_ENABLED']){
  assert.ok(script.includes('"'+name+'":"false"'),name);
 }
 assert.doesNotMatch(script,/subprocess\.|os\.system|paymentIntents\.create|stripe\.charges/);
});
