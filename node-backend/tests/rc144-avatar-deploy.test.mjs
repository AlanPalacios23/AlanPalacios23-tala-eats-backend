import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const scripts=[
 'scripts/rc144-kali-avatar-storage.sh',
 'scripts/rc144-kali-avatar-live-preflight.sh',
 'scripts/rc144-kali-avatar-candidate-build.sh',
];
test('RC144 deployment scripts are parseable and fail closed',()=>{
 for(const path of scripts){
  const source=read(path);
  const run=spawnSync('bash',['-n'],{input:source,encoding:'utf8'});
  assert.equal(run.status,0,path+' :: '+run.stderr);
  assert.match(source,/set -Eeuo pipefail/);
  assert.match(source,/set \+x/);
 }
});
test('avatar-only backend release is pinned to exact live commit and enumerated files',()=>{
 const s=read('scripts/rc144-kali-avatar-live-preflight.sh');
 assert.match(s,/f92f5d9a52856f24e155dcbc140dcff0e266056a/);
 assert.match(s,/merge-base --is-ancestor/);
 assert.match(s,/HOLD_UNRELATED_FILE/);
 assert.match(s,/export GIT_OPTIONAL_LOCKS=0/);
 assert.match(s,/pm2 jlist/);
 assert.match(s,/RC144_LIVE_PM2_IDENTITIES=PASS/);
 assert.match(s,/HOLD_PERSISTENT_MEDIA_NOT_PROVISIONED/);
 assert.match(s,/RC144_THREE_API_PROXIES=PASS/);
 assert.doesNotMatch(s,/pm2 (?:delete|restart|start|stop)/);
 assert.doesNotMatch(s,/pg_dump|psql|ALTER TABLE|STRIPE_SECRET_KEY/);
});
test('storage only provisions a new isolated media directory with approval',()=>{
 const s=read('scripts/rc144-kali-avatar-storage.sh');
 assert.match(s,/--plan/);assert.match(s,/--provision/);
 assert.match(s,/I_APPROVE_RC144_AVATAR_STORAGE_ONLY/);
 assert.match(s,/\/srv\/talaeats-media/);
 assert.match(s,/driver-avatars/);
 assert.match(s,/install -d -m 0700 -o tala-node-stage -g tala-node-stage/);
 assert.doesNotMatch(s,/chown -R|chmod -R|rm -rf|pm2 restart/);
});
test('candidate compilation never inherits live payment secrets and does not switch PM2',()=>{
 const s=read('scripts/rc144-kali-avatar-candidate-build.sh');
 assert.match(s,/env -i HOME=/);
 assert.match(s,/NODE_ENV=staging/);
 assert.match(s,/postgresql:\/\/tala_node_stage:NoRealAccess@127\.0\.0\.1:15435\/tala_node_stage/);
 assert.doesNotMatch(s,/postgresql:\/\/synthetic:/);
 assert.match(s,/npm ci --no-audit --no-fund/);
 assert.match(s,/npm audit --omit=dev --audit-level=high/);
 assert.match(s,/npm run verify/);
 assert.match(s,/PASS_NOT_DEPLOYED/);
 assert.doesNotMatch(s,/pm2 (?:delete|restart|start|stop)|--env-file/);
});
