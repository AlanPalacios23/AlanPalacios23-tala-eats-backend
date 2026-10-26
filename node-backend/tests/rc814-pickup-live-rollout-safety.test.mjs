import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const s=read('../scripts/rc814-pickup-live-go-live.sh');
const promoter=read('../scripts/rc813-unified-live-cutover.sh');
const checks=[
 'I_APPROVE_RC814_PICKUP_LIVE_TWO_PM2_ONLY',
 '10f28bcaf63efd3e0ab9dc0366440219da261916',
 'bash scripts/rc813-unified-live-preflight.sh --prepare',
 'bash scripts/rc813-unified-live-preflight.sh --plan',
 'bash scripts/rc813-unified-live-cutover.sh',
 'rc814-pickup-readiness-audit.mjs',
 'RC814_PICKUP_BACKEND_PLAN=PASS_NO_WRITES',
 'RC814_STRIPE_LIVE_AND_WEB_PUSH_PRESERVED=PASS',
 'RC814_SELLER_ONBOARDING_STILL_REQUIRED=YES',
 'RC814_PICKUP_LIVE_BACKEND_DEPLOYED=PASS',
];
test('RC814 pickup rollout is approval-gated, pinned, with existing finance rollback',()=>{
 for(const token of checks) assert.ok(s.includes(token),token);
 assert.ok(promoter.includes("'10f28bcaf63efd3e0ab9dc0366440219da261916'"));
 assert.ok(s.indexOf('bash scripts/rc813-unified-live-preflight.sh --plan')<
  s.indexOf('bash scripts/rc813-unified-live-cutover.sh'));
 for(const x of ['prisma migrate deploy','FLUSHALL','FLUSHDB','cloudflared restart',
   'STRIPE_CONNECT_TRANSFERS_ENABLED=true'])assert.ok(!s.includes(x),x);
});
test('RC814 standalone script syntax and non-applicable usage fail closed',()=>{
 const source=new URL('../scripts/rc814-pickup-live-go-live.sh',import.meta.url).pathname;
 const c=spawnSync('bash',['-n',source],{encoding:'utf8'});
 assert.equal(c.status,0,c.stderr);
 for(const args of [[],['--apply','notasha'],['--apply','a'.repeat(40)],['--plan']]){
  const v=spawnSync('bash',[source,...args],{encoding:'utf8'});
  assert.equal(v.status,2,args.join(' ')+' returned '+v.status+' '+v.stdout+v.stderr);
 }
});
