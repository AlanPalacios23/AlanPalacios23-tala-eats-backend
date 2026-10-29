import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const script=new URL('../scripts/rc118-kali-live-business-readiness.sh',import.meta.url);
const source=readFileSync(script,'utf8');
test('RC118 1-command production audit requires exact service and LIVE database',()=>{
 const parsed=spawnSync('bash',['-n',script.pathname],{encoding:'utf8'});
 assert.equal(parsed.status,0,parsed.stderr);
 for(const marker of ['tala-node-stage','HOLD_SERVICE_USER_OR_SHA',
  'HOLD_RELEASE_MISMATCH','HOLD_LIVE_ENV','HOLD_NOT_LIVE_DATABASE',
  "pg.port!=='15445'","pg.pathname!=='/tala_node_live'",
  'RC118_AUTO_RELEASE=NO','RC118_REAL_COMMERCE_E2E=NOT_VERIFIED'])
  assert.ok(source.includes(marker),marker);
});
test('RC118 checks all four existing auditors without restarting PM2 or changing flags',()=>{
 for(const marker of [
  'rc114-kali-live-cash-readiness.mjs',
  'rc115-kali-live-connect-readiness.mjs',
  'rc116-kali-live-financial-recovery-audit.mjs',
  'rc117-kali-live-public-preflight.mjs',
  'HOLD_FAILED_CHECK_COUNT_',
  'RC118_FINANCIAL_WRITES=NONE'])
  assert.ok(source.includes(marker),marker);
 assert.doesNotMatch(source,/(?:\bpm2\b|npm run db:migrate:deploy|stripe\.(?:transfers|refunds|payouts)\.create\()/);
 const missing=spawnSync('bash',[script.pathname],{encoding:'utf8'});
 assert.notEqual(missing.status,0);
});
