import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=p=>readFileSync(path.join(root,p),'utf8');

test('production standby PM2 shell script is syntactically valid',()=>{
 const file=path.join(root,'scripts/rc86-production-standby-pm2.sh');
 const result=spawnSync('bash',['-n',file],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
});
test('standby PM2 cutover preserves two process identities and rollback',()=>{
 const sh=source('scripts/rc86-production-standby-pm2.sh');
 assert.match(sh,/I_APPROVE_PRODUCTION_STANDBY_NO_CHARGES/);
 assert.match(sh,/PRODUCTION_STANDBY_FLAGS=PASS_ALL_OFF/);
 assert.match(sh,/LIVE_DATABASE_BACKUP=PASS/);
 assert.match(sh,/trap rollback ERR EXIT/);
 assert.match(sh,/ecosystem.production.config.cjs/);
 assert.match(sh,/ecosystem.config.cjs/);
 assert.match(sh,/pm2 delete tala-node-stage-worker/);
 assert.match(sh,/pm2 delete tala-node-stage-api/);
 assert.match(sh,/pm2 save/);
 assert.match(sh,/PUBLIC_STANDBY_API_AND_PAYMENTS_OFF=PASS/);
 assert.doesNotMatch(sh,/paymentIntents.create|transfers.create|payouts.create|refunds.create|prisma migrate deploy/);
});
test('production standby keeps create-order and payment-intent blocked',()=>{
 const app=source('src/app.ts');
 const config=source('src/config.ts');
 const guard=source('src/live/guard.ts');
 assert.match(app,/enabled:liveChargeApproved/);
 assert.match(app,/LIVE_CARD_CHECKOUT_NOT_APPROVED/);
 assert.match(app,/online_payment_writes:liveChargeApproved/);
 assert.match(app,/financialWrites:Boolean\(liveChargeApproved&&ready\)/);
 assert.match(config,/!financialFlags.every\(v=>v==='true'\)/);
 assert.match(config,/!financialFlags.every\(v=>v==='false'\)/);
 assert.match(guard,/STANDBY_REQUIRES_ALL_MONEY_FLAGS_OFF/);
});
