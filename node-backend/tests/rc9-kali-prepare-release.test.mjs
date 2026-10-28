import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const path=new URL('../scripts/rc9-kali-prepare-release.sh',import.meta.url);
const script=readFileSync(path,'utf8');

test('RC9 Kali preparation supplies all required local-only config fields to full test suite',()=>{
  for(const fragment of [
    "export NODE_ENV=staging",
    "export HOST='127.0.0.1'",
    "export PORT='18190'",
    "export DATABASE_URL='postgresql://tala_node_stage:rc9-ci-invalid@127.0.0.1:15435/tala_node_stage'",
    "export REDIS_URL='redis://:rc9-ci-invalid@127.0.0.1:16379/0'",
    'npm test'
  ]) assert.ok(script.includes(fragment), 'missing protected test config: '+fragment);
  assert.match(script,/unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PUBLISHABLE_KEY/);
  assert.match(script,/unset STRIPE_CONNECT_WEBHOOK_SECRET STRIPE_PLATFORM_ACCOUNT_ID/);
  assert.doesNotMatch(script,/prisma migrate deploy|pm2 (restart|reload|delete|start)|payouts\.create\(|transfers\.create\(/);
});
test('RC9 Kali prepare is bash-valid and denies non-operator execution',()=>{
  const syntax=spawnSync('bash',['-n',path.pathname],{encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  const refused=spawnSync('bash',[path.pathname,'--prepare','1'.repeat(40)],
    {encoding:'utf8',env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:'/tmp'}});
  assert.notEqual(refused.status,0);
  assert.match(refused.stdout+refused.stderr,/RC9_ABORT/);
});
