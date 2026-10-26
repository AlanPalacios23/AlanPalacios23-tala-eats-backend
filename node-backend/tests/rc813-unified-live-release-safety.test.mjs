import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const pre=read('../scripts/rc813-unified-live-preflight.sh');
const promote=read('../scripts/rc813-unified-live-cutover.sh');
const retire=read('../scripts/rc813-retire-parallel-stage.sh');
const eco=read('../rc813-live/ecosystem.config.cjs');
const app=read('../src/app.ts');
test('RC8.13 unified LIVE retains single public PM2 API+dedicated Stripe finance worker',()=>{
 assert.match(eco,/name:'tala-node-stage-worker'/);
 assert.match(eco,/name:'tala-node-stage-api'/);
 assert.match(eco,/dist\/live\/production-worker\.js/);
 assert.match(eco,/dist\/server\.js/);
 assert.match(eco,/node_args:\['--env-file='/);
 assert.match(eco,/TALA_LIVE_ENV_FILE/);
 assert.match(eco,/PM2_HOME!==/);
 assert.match(eco,/NODE_ENV:'production'/);
 assert.doesNotMatch(eco,/tala-rc813-parallel-api|tala-rc813-parallel-worker/);
 assert.match(app,/version:live\?'rc8\.13-unified-live':'rc8\.13-staging'/);
});
test('RC8.13 promotion stops old API before worker, starts new worker before API',()=>{
 const start=promote.indexOf('ROLLOUT_STARTED=yes\nlive_pm2 delete tala-node-stage-api');
 const delWorker=promote.indexOf('live_pm2 delete tala-node-stage-worker',start);
 const newWorker=promote.indexOf('live_pm2 start "$ECO" --only tala-node-stage-worker',start);
 const newApi=promote.indexOf('live_pm2 start "$ECO" --only tala-node-stage-api',start);
 assert.ok(start>0&&delWorker>start&&newWorker>delWorker&&newApi>newWorker);
 assert.match(promote,/RC813_LIVE_WORKER_PM2_IDENTITY=PASS/);
 assert.match(promote,/RC813_ONE_LIVE_PM2_API_WORKER=PASS/);
 assert.match(promote,/tala:node:live:worker:heartbeat/);
 assert.match(promote,/RC813_UNIFIED_LIVE_DEPLOYED=PASS/);
 assert.match(promote,/RC813_LIVE_ROLLBACK=ATTEMPTED_OPERATOR_CHECK_REQUIRED/);
 assert.match(promote,/pg_restore/);
 assert.match(promote,/pg_dump/);
 assert.doesNotMatch(promote,/prisma migrate deploy|prisma\/build\/index\.js migrate deploy|cloudflared.*restart/);
});
test('RC8.13 payment-capable LIVE gate is read-only, preserves active LIVE pickup and holds staging delivery',()=>{
 assert.match(pre,/RC813_ONE_LIVE_FINANCIAL_FLAGS_COMPATIBLE=PASS/);
 assert.match(pre,/rc86-live-activation-audit\.mjs/);
 assert.match(pre,/prisma\/build\/index\.js migrate status/);
 assert.match(pre,/STAGE_DRIVER_DELIVERY_ENABLED!=='false'/);
 assert.match(pre,/STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='false'/);
 assert.match(pre,/STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='false'/);
 assert.match(pre,/STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'/);
 assert.doesNotMatch(pre,/STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true'/);
 assert.match(pre,/RC813_ONE_LIVE_PROMOTION_PLAN=PASS_READ_ONLY/);
 assert.match(pre,/RC813_UNIFIED_LIVE_LOCAL_AND_PUBLIC_READY=PASS/);
 assert.doesNotMatch(pre,/prisma migrate deploy/);
});
test('RC8.13 retiring temporary PM2 requires verified LIVE SHA and separate operator consent',()=>{
 assert.match(retire,/I_APPROVE_STOP_RC813_STAGING_PM2_ONLY/);
 assert.match(retire,/rc813-unified-live-preflight\.sh --verify/);
 assert.match(retire,/RC813_UNIFIED_LIVE_SHA_AND_TWO_PM2=PASS/);
 assert.match(retire,/\.pm2-tala-rc813-parallel/);
 assert.match(retire,/stage_pm2 delete tala-rc813-parallel-api/);
 assert.match(retire,/stage_pm2 delete tala-rc813-parallel-worker/);
 assert.doesNotMatch(retire,/flushdb|flushall|DROP DATABASE|prisma migrate deploy/);
});
test('RC8.14 pickup LIVE promotion locks exact current WEB PUSH financial runtime',()=>{
 assert.match(promote,/10f28bcaf63efd3e0ab9dc0366440219da261916/);
 assert.doesNotMatch(promote,/OLD_SHA.*aea74744ba47db2333bcef052b296a7a7ab63eb9/);
 assert.match(promote,/STRIPE_CONNECT_TRANSFERS=STILL_OFF/);
 assert.match(promote,/RC813_LIVE_PUSH_WORKER_AND_PUBLIC_VAPID=PASS/);
});
test('RC8.13 shell syntax and no invocation without deliberate approval',()=>{
 for(const file of ['rc813-unified-live-preflight.sh','rc813-unified-live-cutover.sh','rc813-retire-parallel-stage.sh']){
  const path=new URL('../scripts/'+file,import.meta.url).pathname;
  const syntax=spawnSync('bash',['-n',path],{encoding:'utf8'});
  assert.equal(syntax.status,0,file+' '+syntax.stderr);
  const noArgs=spawnSync('bash',[path],{encoding:'utf8'});
  assert.equal(noArgs.status,2,file);
 }
 const echo=spawnSync('node',['--check',new URL('../rc813-live/ecosystem.config.cjs',import.meta.url).pathname],{encoding:'utf8'});
 assert.equal(echo.status,0,echo.stderr);
});
