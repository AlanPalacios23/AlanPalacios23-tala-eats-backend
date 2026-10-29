import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const p=new URL('../scripts/rc114-kali-live-code-cutover.sh',import.meta.url);
const src=readFileSync(p,'utf8');
test('RC120 rollout can archive only a receipt from the currently running PM2 SHA',()=>{
 const check=spawnSync('bash',['-n',p.pathname],{encoding:'utf8'});
 assert.equal(check.status,0,check.stderr);
 for(const marker of [
  "doc.sha!==sha",
  'PREVIOUS_RECEIPT_NOT_ACTIVE_SHA',
  'RC114_PREVIOUS_ROLLBACK_RECEIPT_ARCHIVED=PASS',
  'rc114-previous-receipts',
  'RECEIPT_ARCHIVE_CONFLICT',
  'HISTORY_SYMLINK',
  'PREVIOUS_ROLLBACK_RECEIPT_EXISTS',
  'PM2_IDENTITY_MISMATCH',
  'BASELINE_SHA_CHANGED',
  'RC114_AUTOMATIC_ROLLBACK=START',
 ])assert.ok(src.includes(marker),marker);
 assert.ok(src.indexOf("old_sha=\"")<src.indexOf("doc.sha!==sha"));
 assert.ok(src.indexOf("mv -- \"$RECEIPT\" \"$archived\"")<
  src.indexOf("printf '{\"sha\":\"%s\""));
 assert.doesNotMatch(src,/\brm\s+-rf?\s+["']?\$RECEIPT/);
});
test('RC120 untouched money policy and no automatic risky flag changes',()=>{
 for(const flag of ['STRIPE_CONNECT_TRANSFERS_ENABLED',
  'LIVE_DELIVERY_CARD_CHECKOUT_ENABLED','LIVE_DELIVERY_CASH_RELEASE_APPROVED'])
  assert.ok(src.includes(flag),flag);
 assert.ok(src.includes('RC114_STRIPE_DB_PWA=UNCHANGED'));
 assert.doesNotMatch(src,/stripe\.(?:payouts|transfers|paymentIntents)\.create\(/);
});
