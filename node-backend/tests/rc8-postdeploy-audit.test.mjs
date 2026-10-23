import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validateApiContract,validatePm2Snapshot,validatePrivateEnv,main}
 from '../scripts/rc8-postdeploy-audit.mjs';

const sha='a'.repeat(40);
const cwd='/home/tala-node-stage/tala-node-releases/'+sha+'/node-backend';
const stageHealth={status:'ok',digital_payment_provider:'stripe',production:false,
 online_payment_writes:false,version:'0.1.0-node-stripe-only-stage'};
const stageReady={ready:true,database:true,redis:true,workerOnline:true,
 digitalPaymentProvider:'stripe',productionReady:false,environment:'staging',
 financialWrites:false,onlinePaymentsEnabled:false};
const liveHealth={...stageHealth,production:true,online_payment_writes:true};
const liveReady={...stageReady,productionReady:true,environment:'production',
 financialWrites:true,onlinePaymentsEnabled:true};
function pm2(mode='stage'){
 return [{name:'tala-node-stage-api',pid:101,pm2_env:{status:'online',
  NODE_ENV:mode==='stage'?'staging':'production',pm_cwd:cwd,
  pm_exec_path:cwd+'/dist/server.js'}},
 {name:'tala-node-stage-worker',pid:102,pm2_env:{status:'online',
  NODE_ENV:mode==='stage'?'staging':'production',pm_cwd:cwd,
  pm_exec_path:cwd+'/dist/worker.js'}}];
}
test('postdeploy stage and live contracts distinguish financial modes',()=>{
 assert.equal(validateApiContract('stage',stageHealth,stageReady),true);
 assert.equal(validateApiContract('live',stageHealth,stageReady),false);
 assert.equal(validateApiContract('live',liveHealth,liveReady),true);
 assert.equal(validateApiContract('stage',liveHealth,liveReady),false);
 for(const patch of [
  {workerOnline:false},{redis:false},{database:false},
  {productionReady:true},{financialWrites:true},{onlinePaymentsEnabled:true}
 ])assert.equal(validateApiContract('stage',stageHealth,{...stageReady,...patch}),false);
 assert.equal(validateApiContract('live',liveHealth,{...liveReady,workerOnline:false}),false);
});
test('postdeploy PM2 audit requires two exact processes, mode, cwd and immutable SHA',()=>{
 assert.equal(validatePm2Snapshot(pm2(),sha,'stage'),cwd);
 assert.equal(validatePm2Snapshot(pm2('live'),sha,'live'),cwd);
 assert.equal(validatePm2Snapshot(pm2(),'b'.repeat(40),'stage'),null);
 assert.equal(validatePm2Snapshot(pm2(),sha,'live'),null);
 assert.equal(validatePm2Snapshot([...pm2(),pm2()[0]],sha,'stage'),null);
 assert.equal(validatePm2Snapshot(pm2().map(x=>({...x,pm2_env:{...x.pm2_env,status:'stopped'}})),sha,'stage'),null);
 assert.equal(validatePm2Snapshot(pm2().map(x=>({...x,pid:101})),sha,'stage'),null);
 assert.equal(validatePm2Snapshot(pm2().map(x=>({...x,pm2_env:{...x.pm2_env,pm_cwd:'/tmp/other'}})),sha,'stage'),null);
 assert.equal(validatePm2Snapshot(pm2().map(x=>({...x,pm2_env:{...x.pm2_env,pm_exec_path:'/tmp/wrong.js'}})),sha,'stage'),null);
 assert.equal(validatePm2Snapshot(pm2().map(x=>({...x,name:'other'})),sha,'stage'),null);
});
test('postdeploy rejects nonprivate env modes and foreign ownership',()=>{
 const sample={isFile:()=>true,mode:0o100600,uid:1001};
 assert.equal(validatePrivateEnv(sample,1001),true);
 assert.equal(validatePrivateEnv({...sample,mode:0o100644},1001),false);
 assert.equal(validatePrivateEnv({...sample,uid:0},1001),false);
});
test('postdeploy script syntax safe, usage fail-closed and only read-only subprocesses',async()=>{
 const file=new URL('../scripts/rc8-postdeploy-audit.mjs',import.meta.url);
 const run=spawnSync(process.execPath,['--check',file.pathname],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 assert.equal(await main(['--apply',sha]),2);
 assert.equal(await main(['--mode','live','badsha']),2);
 const src=readFileSync(file,'utf8');
 assert.match(src,/execFileSync\('pm2',\['jlist'\]/);
 assert.match(src,/POSTDEPLOY_READ_ONLY=PASS/);
 assert.doesNotMatch(src,/pm2\s+(?:restart|reload|start|delete)|docker compose|stripe\.paymentIntents\.create/);
});
