import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const src=new URL('../src/config.ts',import.meta.url);
const source=readFileSync(src,'utf8');
const sh=new URL('../scripts/rc813-parallel-stage.sh',import.meta.url);
const installer=new URL('../scripts/rc813-create-parallel-stage-env.py',import.meta.url);
const eco=new URL('../ecosystem.rc813-parallel.cjs',import.meta.url);
const stageSh=readFileSync(sh,'utf8');
const stageEnv=readFileSync(installer,'utf8');
const stagePM=readFileSync(eco,'utf8');

test('RC813 parallel staging port and Redis DB1 require opt-in',()=>{
 assert.match(source,/STAGE_PARALLEL_ENABLED: z\.enum/);
 assert.match(source,/config\.PORT!==\(config\.STAGE_PARALLEL_ENABLED==='true'\?18192:18190\)/);
 assert.match(source,/redis\.pathname!==\(config\.STAGE_PARALLEL_ENABLED==='true'\?'\/1':'\/0'\)/);
 assert.match(source,/PARALLEL_STAGE_MODE_FORBIDDEN_IN_LIVE/);
});

test('RC813 launch code does not touch public PM2 or Cloudflared',()=>{
 const r=spawnSync('bash',['-n',sh.pathname],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.equal(spawnSync('python3',['-m','py_compile',installer.pathname],
    {encoding:'utf8'}).status,0);
 const failed=spawnSync('bash',[sh.pathname],{encoding:'utf8'});
 assert.equal(failed.status,2);
 assert.match(stageSh,/I_APPROVE_RC813_PARALLEL_STAGE_ONLY/);
 assert.match(stageSh,/STAGE_PM2_HOME="\$HOME\/\.pm2-tala-rc813-parallel"/);
 assert.match(stageSh,/ROLLOUT_STARTED=yes/);
 assert.match(stageSh,/--only tala-rc813-parallel-worker/);
 assert.match(stageSh,/--only tala-rc813-parallel-api/);
 assert.ok(stageSh.indexOf('pm2 start "$ECO" --only tala-rc813-parallel-worker') <
    stageSh.indexOf('pm2 start "$ECO" --only tala-rc813-parallel-api'));
 assert.doesNotMatch(stageSh,/prisma\/build\/index\.js migrate deploy|migrate deploy/);
 assert.doesNotMatch(stageSh,/systemctl restart|cloudflared.*restart|pm2 delete tala-node-stage/);
});

test('RC813 plan is isolated and never dumps finance secrets',()=>{
 assert.match(stageSh,/pgUrl\.pathname!=='\/tala_node_stage'/);
 assert.match(stageSh,/rdUrl\.pathname!=='\/1'/);
 assert.match(stageSh,/STRIPE_FINANCIAL_WRITES_ENABLED/);
 assert.match(stageSh,/STRIPE_CONNECT_TRANSFERS_ENABLED/);
 assert.match(stageSh,/RC813_EXISTING_LIVE_PORT_18190_PRESENT/);
 assert.match(stageSh,/RC813_PARALLEL_STAGE_PLAN=PASS/);
 assert.match(stageSh,/STAGE_PM2_HOME/);
 assert.match(stageEnv,/TARGET_EXISTS_NEVER_OVERWRITE/);
 assert.match(stageEnv,/TARGET=ROOT\/"talaeats-node-rc813-parallel.env"/);
 assert.match(stageEnv,/SOURCE=ROOT\/"talaeats-node-staging.env"/);
 assert.match(stageEnv,/stat\.S_IMODE\(SOURCE\.stat\(\)\.st_mode\)!=0o600/);
 assert.match(stageEnv,/values\["STAGE_PARALLEL_ENABLED"\]="true"/);
 assert.match(stageEnv,/urlunsplit\(\(u\.scheme,u\.netloc,"\/1"/);
 assert.doesNotMatch(stageEnv,/print\(.*(?:password|STRIPE_SECRET_KEY|DATABASE_URL)/);
});

test('RC813 PM2 daemon and child process names are intentionally different',()=>{
 assert.match(stagePM,/\.pm2-tala-rc813-parallel/);
 assert.match(stagePM,/tala-rc813-parallel-worker/);
 assert.match(stagePM,/tala-rc813-parallel-api/);
 assert.doesNotMatch(stagePM,/name: 'tala-node-stage-api'|name: 'tala-node-stage-worker'/);
 assert.match(stagePM,/NODE_ENV:'staging'/);
});
