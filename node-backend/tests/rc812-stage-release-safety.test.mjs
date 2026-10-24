import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const scripts=new URL('../scripts/',import.meta.url);
const promote=readFileSync(new URL('kali-stage-first-pm2-promote.sh',scripts),'utf8');
const wrapper=readFileSync(new URL('rc812-kali-stage-release.sh',scripts),'utf8');

test('RC8.12 release scripts parse, refuse missing approval, and never enable LIVE',()=>{
  for(const file of ['kali-stage-first-pm2-promote.sh',
    'rc812-kali-stage-release.sh','rc811-kali-stage-promote.sh',
    'rc811-kali-stage-candidate.sh']){
    const path=new URL(file,scripts).pathname;
    const parsed=spawnSync('bash',['-n',path],{encoding:'utf8'});
    assert.equal(parsed.status,0,file+': '+parsed.stderr);
  }
  const usage=spawnSync('bash',[new URL('rc812-kali-stage-release.sh',scripts).pathname],
    {encoding:'utf8'});
  assert.equal(usage.status,2);
  assert.match(wrapper,/I_APPROVE_RC812_STAGE_PM2_ONLY/);
  assert.match(wrapper,/rc811-kali-stage-promote.sh --apply/);
  assert.doesNotMatch(wrapper,/\b(?:migrate deploy|pm2 delete|pm2 restart|stripe\.paymentIntents\.create)\b/);
  assert.doesNotMatch(wrapper,/STRIPE_LIVE_ENABLED=['"]?true|STRIPE_FINANCIAL_WRITES_ENABLED=['"]?true/);
});

test('RC8.12 candidate cutover starts worker BEFORE API',()=>{
  assert.match(promote,/ROLLOUT_STARTED=yes/);
  const cutover=promote.slice(promote.indexOf('ROLLOUT_STARTED=yes'));
  const startWorker=cutover.indexOf('pm2 start ecosystem.config.cjs --only tala-node-stage-worker');
  const startApi=cutover.indexOf('pm2 start ecosystem.config.cjs --only tala-node-stage-api');
  assert.ok(startWorker>0&&startApi>startWorker,
    'new worker must exist before API readiness can become true');
  assert.match(cutover,/WORKER_HEARTBEAT=no/);
  assert.match(cutover,/tala:node:stage:worker:heartbeat/);
  assert.match(cutover,/ABORT_CANDIDATE_WORKER_HEARTBEAT_MISSING/);
  assert.match(cutover,/v\.workerOnline===true/);
});

test('RC8.12 rollback restores worker FIRST and waits for ready heartbeat',()=>{
  const rollback=promote.slice(promote.indexOf('rollback() {'),
    promote.indexOf('trap rollback EXIT'));
  const startWorker=rollback.indexOf('pm2 start ecosystem.config.cjs --only tala-node-stage-worker');
  const startApi=rollback.indexOf('pm2 start ecosystem.config.cjs --only tala-node-stage-api');
  assert.ok(startWorker>0&&startApi>startWorker);
  assert.match(rollback,/ROLBACK_READY=no/);
  assert.match(rollback,/v\.workerOnline===true/);
  assert.match(rollback,/STAGE_PM2_ROLLBACK_READY=FAIL_MANUAL_REVIEW_REQUIRED/);
});

test('RC8.12 wrapper fails closed when stage SHA / source / explicit approval is wrong',()=>{
  assert.match(wrapper,/PINNED_CLEAN_RELEASE_REQUIRED/);
  assert.match(wrapper,/\-z "\$\(git -C "\$ROOT" status --porcelain --untracked-files=no\)"/);
  assert.match(wrapper,/RC812_ABORT=STAGE_USER_REQUIRED/);
  assert.match(wrapper,/RC812_ABORT=EXPLICIT_STAGE_PM2_APPROVAL_REQUIRED/);
  assert.match(wrapper,/--prepare.*rc811-kali-stage-candidate\.sh --prepare/s);
});
