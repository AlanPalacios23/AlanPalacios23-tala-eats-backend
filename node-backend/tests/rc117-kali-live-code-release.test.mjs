import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const shell=new URL('../scripts/rc117-kali-live-code-release.sh',import.meta.url);
test('RC11.7 release script passes bash syntax before server deployment',()=>{
 const result=spawnSync('bash',['-n',shell.pathname],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
const src=readFileSync(new URL('../scripts/rc117-kali-live-code-release.sh',import.meta.url),'utf8');
test('RC11.7 code deploy is SHA-pinned, guarded and never toggles LIVE money',()=>{
 for(const v of ['--(plan|apply|verify)','I_APPROVE_RC117_LIVE_CODE_ONLY',
 'HOLD_PINNED_RELEASE_MISSING','tala-node-stage','npm run verify',
 'rc114-kali-live-code-cutover.sh --plan',
 'rc114-kali-live-code-cutover.sh --apply',
 'rc114-kali-live-code-cutover.sh --verify',
 'rc117-kali-live-public-preflight.mjs',
 'RC117_PRODUCTION_PAYMENTS_OR_WITHDRAWALS_NEWLY_ACTIVATED=NO'])
  assert.ok(src.includes(v),v);
 for(const bad of ['db:migrate:deploy','stripe.transfers.create',
  'stripe.payouts.create','LIVE_DELIVERY_CASH_CHECKOUT_ENABLED=true',
  'STRIPE_CONNECT_TRANSFERS_ENABLED=true']){
  assert.ok(!src.includes(bad),bad);
 }
});
test('RC11.7 only delegates state changes to the existing protected PM2 installer',()=>{
 assert.doesNotMatch(src,/pm2\s+(?:delete|start|restart|reload)/);
 assert.doesNotMatch(src,/ALTER TABLE|UPDATE orders|INSERT INTO|DELETE FROM/i);
 assert.match(src,/--apply\)/);
});
