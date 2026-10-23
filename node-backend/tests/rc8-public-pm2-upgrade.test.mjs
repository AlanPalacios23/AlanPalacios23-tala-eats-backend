import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const path=new URL('../scripts/rc8-kali-public-pm2-upgrade.sh',import.meta.url);
const source=readFileSync(path,'utf8');
test('RC8 public rollout uses the existing PM2 backed-up rollback promoter',()=>{
  assert.match(source,/kali-stage-first-pm2-promote\.sh --apply/);
  assert.match(source,/kali-stage-postdeploy-smoke\.sh/);
  assert.match(source,/I_APPROVE_RC8_PUBLIC_PM2_STAGE_ONLY/);
  assert.match(source,/RC8_EXISTING_PUBLIC_DOMAIN=PASS/);
  assert.match(source,/RC8_FINANCIAL_WRITES=OFF/);
  assert.match(source,/productionReady===false/);
  assert.match(source,/onlinePaymentsEnabled===false/);
  assert.doesNotMatch(source,/\bdocker\s+(?:compose|run|exec|stop)\b/i);
  assert.doesNotMatch(source,/pm2\s+(?:start|delete|restart|reload)\b/);
  assert.doesNotMatch(source,/\bmigrate\s+deploy\b/);
  assert.doesNotMatch(source,/STRIPE_FINANCIAL_WRITES_ENABLED=true/);
});
test('RC8 PM2 upgrade validates Bash and refuses unknown or short SHA',()=>{
  const syntax=spawnSync('bash',['-n',path.pathname]);
  assert.equal(syntax.status,0,syntax.stderr?.toString());
  for(const args of [
    ['--production','a'.repeat(40)],
    ['--apply','fake'],
    ['--apply','a'.repeat(40)]
  ]){
    const got=spawnSync('bash',[path.pathname,...args]);
    assert.notEqual(got.status,0);
  }
});
