import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const script=readFileSync(new URL('../scripts/rc117-kali-live-code-release.sh',import.meta.url),'utf8');
const synthetic={
 HOME:'/tmp',USER:'tala-node-stage',LOGNAME:'tala-node-stage',
 PATH:process.env.PATH??'/usr/bin:/bin',
 NODE_ENV:'staging',HOST:'127.0.0.1',PORT:'18190',
 DATABASE_URL:'postgresql://tala_node_stage:RC117SyntheticNonProductionNoAccess@127.0.0.1:15435/tala_node_stage',
 REDIS_URL:'redis://:RC117SyntheticNonProductionNoAccess@127.0.0.1:16379/0',
 STRIPE_FINANCIAL_WRITES_ENABLED:'false',STRIPE_LIVE_ENABLED:'false',
 STRIPE_LIVE_RELEASE_APPROVED:'false',STRIPE_REFUNDS_ENABLED:'false',
 STRIPE_CONNECT_TRANSFERS_ENABLED:'false',
 STRIPE_MANUAL_SETTLEMENT_APPROVED:'false',
 STAGE_PICKUP_CASH_CHECKOUT_ENABLED:'false',
 STAGE_DELIVERY_CASH_CHECKOUT_ENABLED:'false',
 STAGE_DRIVER_DELIVERY_ENABLED:'false',
 STAGE_DELIVERY_STRIPE_TEST_ENABLED:'false',
 STAGE_STRIPE_TEST_CHECKOUT_ENABLED:'false',
};
test('RC11.7 deployment tests use isolated synthetic env, never LIVE env or credentials',()=>{
 assert.ok(script.includes('RC117_ISOLATED_TEST_ENV=SYNTHETIC_NO_LIVE_SECRETS'));
 assert.ok(script.includes('env -i HOME="$HOME"'));
 assert.ok(script.includes('NODE_ENV=staging HOST=127.0.0.1 PORT=18190'));
 assert.ok(script.includes('RC117SyntheticNonProductionNoAccess'));
 assert.ok(script.includes('STRIPE_CONNECT_TRANSFERS_ENABLED=false'));
 assert.ok(script.includes('STRIPE_LIVE_ENABLED=false'));
 assert.ok(!script.includes('npm run verify --env-file'));
 assert.ok(!script.includes('source "$HOME/.config/talaeats-node-live.env"'));
});
test('RC11.7 4 formerly failing config imports pass with isolated env and no LIVE DB',()=>{
 const paths=[
  'tests/rc810-stage-stripe-delivery-gates.test.mjs',
  'tests/rc812-runtime-readiness.test.mjs',
  'tests/rc91-stripe-onboarding-return.test.mjs',
  'tests/rc93-connect-status-rate-limit.test.mjs',
 ];
 const r=spawnSync(process.execPath,['--test',...paths],{
  cwd:new URL('..',import.meta.url).pathname,
  env:synthetic,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
 });
 assert.equal(r.status,0,
  'synthetic offline tests failed: '+(r.error?.message??'')+'\n'+r.stdout+'\n'+r.stderr);
 assert.match(r.stdout,/fail 0/);
});
