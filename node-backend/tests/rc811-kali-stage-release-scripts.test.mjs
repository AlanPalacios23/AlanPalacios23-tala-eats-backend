import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const root=new URL('../scripts/',import.meta.url);
const names=['rc811-kali-stage-candidate.sh','rc811-kali-stage-promote.sh'];

test('RC811 both scripts parse with bash -n and stay nonexecutable by default',()=>{
 for(const name of names){
   const path=new URL(name,root).pathname;
   const res=spawnSync('bash',['-n',path],{encoding:'utf8'});
   assert.equal(res.status,0,name+': '+res.stderr);
   const usage=spawnSync('bash',[path],{encoding:'utf8'});
   assert.equal(usage.status,2,name+' unapproved must stop at argument check');
 }
});
test('RC811 preparation cannot start Stripe LIVE or run migrations',()=>{
 const p=readFileSync(new URL(names[0],root),'utf8');
 assert.match(p,/git -C "\$ROOT" rev-parse --verify HEAD/);
 assert.match(p,/STAGE_DELIVERY_STRIPE_TEST_ENABLED/);
 assert.match(p,/STRIPE_CONNECT_TRANSFERS_ENABLED/);
 assert.match(p,/migrate status/);
 assert.match(p,/kali-stage-migrate.sh --preflight/);
 assert.match(p,/npm ci --no-audit/);
 assert.match(p,/rc8-kali-public-pm2-upgrade.sh --plan/);
 assert.doesNotMatch(p,/pm2 (?:start|delete|restart|reload)/);
 assert.doesNotMatch(p,/migrate deploy/);
 assert.doesNotMatch(p,/pg_dump.*--apply/);
});
test('RC811 promotion must require separate exact approval and backup-restored cutover',()=>{
 const p=readFileSync(new URL(names[1],root),'utf8');
 assert.match(p,/I_APPROVE_RC811_STAGE_PM2_ONLY/);
 assert.match(p,/rc811-kali-stage-candidate.sh --plan/);
 assert.match(p,/rc8-kali-public-pm2-upgrade.sh --apply/);
 assert.match(p,/rc89-stage-postdeploy-check.sh/);
 assert.match(p,/STOP_AND_REVIEW_ORDERS_BEFORE_ROLLBACK/);
 assert.doesNotMatch(p,/migrate deploy|stripe payment_intents|STRIPE_LIVE_ENABLED=true/);
});
