#!/usr/bin/env node
/**
 * TALA EATS RC8 POSTDEPLOY — strictly read-only.
 *
 * Confirms two existing PM2 processes, an exact deployed source SHA, bound
 * loopback API and public Cloudflare contract. Does not start, restart, alter,
 * charge, refund, migrate, rotate secrets, or claim commercial release approval.
 * Run under tala-node-stage in Kali AFTER a separately approved promotion.
 */
import {execFileSync} from 'node:child_process';
import {lstatSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

export const LOCAL_BASE='http://127.0.0.1:18190/api/v1';
export const PUBLIC_BASE='https://talaeats.alan-palacios-dev.com/api/v1';
export const PROCESS_NAMES=['tala-node-stage-api','tala-node-stage-worker'];
export const SHA_PATTERN=/^[0-9a-f]{40}$/;

export function validateApiContract(mode,health,ready){
 const common=health?.status==='ok' &&
   health?.digital_payment_provider==='stripe' &&
   ready?.ready===true && ready.database===true && ready.redis===true &&
   ready.workerOnline===true && ready.digitalPaymentProvider==='stripe';
 if(!common) return false;
 if(mode==='stage') return health.production===false &&
   health.online_payment_writes===false &&
   ready.productionReady===false && ready.environment==='staging' &&
   ready.financialWrites===false && ready.onlinePaymentsEnabled===false;
 if(mode==='live') return health.production===true &&
   health.online_payment_writes===true &&
   ready.productionReady===true && ready.environment==='production' &&
   ready.financialWrites===true && ready.onlinePaymentsEnabled===true;
 return false;
}
export function validatePm2Snapshot(processes,sha,mode){
 if(!Array.isArray(processes)||processes.length!==2||!SHA_PATTERN.test(sha)||
   !['stage','live'].includes(mode)) return null;
 const names=processes.map(p=>p.name).sort();
 if(JSON.stringify(names)!==JSON.stringify([...PROCESS_NAMES].sort()))return null;
 const expected=join('/home/tala-node-stage/tala-node-releases',sha,'node-backend');
 for(const p of processes){
   const e=p.pm2_env??{};
   const executable=join(expected,'dist',
     p.name==='tala-node-stage-api'?'server.js':'worker.js');
   if(e.status!=='online'||e.pm_cwd!==expected||
      e.pm_exec_path!==executable||
      e.NODE_ENV!==(mode==='stage'?'staging':'production')||
      !Number.isInteger(p.pid)||p.pid<1)return null;
 }
 if(processes[0].pid===processes[1].pid)return null;
 return expected;
}
export function validatePrivateEnv(meta,uid){
 return Boolean(meta && meta.isFile() &&
   (meta.mode&0o777)===0o600 && meta.uid===uid);
}
const guard=(pass,name)=>{
 console.log(name+'='+(pass?'PASS':'FAIL'));
 if(!pass)throw Error('POSTDEPLOY_'+name+'_FAILED');
};
async function fetchContract(base,path){
 const response=await fetch(base+path,{
   method:'GET',redirect:'error',cache:'no-store',
   signal:AbortSignal.timeout(base===LOCAL_BASE?6000:12000),
   headers:{accept:'application/json'}
 });
 if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))
   throw Error('HTTP_OR_CONTENT_TYPE');
 const raw=await response.text();
 if(raw.length>16384)throw Error('RESPONSE_TOO_LARGE');
 return JSON.parse(raw);
}
export async function main(argv=process.argv.slice(2), deps={}){
 if(argv.length!==3||argv[0]!=='--mode'||!['stage','live'].includes(argv[1])||
   !SHA_PATTERN.test(argv[2])){
   console.log('USAGE: node scripts/rc8-postdeploy-audit.mjs --mode stage|live <EXACT_40_CHAR_SHA>');
   return 2;
 }
 const mode=argv[1],sha=argv[2];
 if(process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
    homedir()!=='/home/tala-node-stage'){
   console.log('ABORT_TALA_NODE_STAGE_USER_REQUIRED');
   return 1;
 }
 const expected=join('/home/tala-node-stage/tala-node-releases',sha,'node-backend');
 try{
   const privateEnv=join(homedir(),'.config',
     mode==='live'?'talaeats-node-live.env':'talaeats-node-staging.env');
   const lst=lstatSync(privateEnv);
   guard(!lst.isSymbolicLink()&&validatePrivateEnv(statSync(privateEnv),process.getuid()),
      'PRIVATE_ENV_PERMISSIONS');
   const releaseRoot=dirname(expected);
   const rootMeta=lstatSync(releaseRoot);
   const releaseMeta=lstatSync(expected);
   guard(rootMeta.isDirectory()&&!rootMeta.isSymbolicLink()&&
     releaseMeta.isDirectory()&&!releaseMeta.isSymbolicLink(),
     'RELEASE_DIRECTORY');
   // PM2 jlist may contain environment secrets: keep completely in memory.
   const raw=execFileSync('pm2',['jlist'],{
     encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,
     env:{...process.env,PM2_HOME:join(homedir(),'.pm2')}
   });
   const dir=validatePm2Snapshot(JSON.parse(raw),sha,mode);
   guard(dir===expected,'PM2_TWO_PROCESSES_AND_SHA');
   const current=execFileSync('git',['-C',dirname(expected),'rev-parse','--verify','HEAD'],{
     encoding:'utf8',timeout:5000
   }).trim();
   guard(current===sha,'ACTIVE_GIT_SHA');
   const clean=execFileSync('git',['-C',dirname(expected),'status','--porcelain','--untracked-files=no'],{
     encoding:'utf8',timeout:5000
   }).trim();
   guard(clean==='','DEPLOYED_SOURCE_UNMODIFIED');
   if(mode==='live'){
     // Read-only audit cannot certify refund/dispute completion on its own.
     guard(process.env.STRIPE_LIVE_RELEASE_APPROVED==='true' &&
       process.env.STRIPE_LIVE_ENABLED==='true' &&
       process.env.STRIPE_FINANCIAL_WRITES_ENABLED==='true',
       'LIVE_RELEASE_FLAGS');
     // Check the connected Stripe LIVE platform, Connect onboarding and event
     // subscription list via GETs only. Never print provider responses/keys.
     const stripeAudit=execFileSync(process.execPath,[
       join(expected,'scripts','stripe-live-account-check.mjs')
     ],{encoding:'utf8',timeout:45000,maxBuffer:65536,
       env:process.env});
     guard(stripeAudit.includes('LIVE_API_READ_ONLY_CHECK=PASS'),
       'LIVE_STRIPE_CONNECT_AND_WEBHOOK_COVERAGE');
   }
   const [localHealth,localReady,publicHealth,publicReady]=await Promise.all([
     fetchContract(LOCAL_BASE,'/health'),
     fetchContract(LOCAL_BASE,'/ready'),
     fetchContract(PUBLIC_BASE,'/health'),
     fetchContract(PUBLIC_BASE,'/ready')
   ]);
   guard(validateApiContract(mode,localHealth,localReady),
      'LOCAL_API_FINANCIAL_CONTRACT');
   guard(validateApiContract(mode,publicHealth,publicReady),
      'PUBLIC_API_FINANCIAL_CONTRACT');
   // Dynamic diagnostic keys may differ between sequential requests.
   // Compare stable release/version and financial flags rather than JSON bytes.
   guard(typeof localHealth.version==='string'&&localHealth.version.length>0&&
     localHealth.version===publicHealth.version&&
     localHealth.digital_payment_provider===publicHealth.digital_payment_provider&&
     localHealth.online_payment_writes===publicHealth.online_payment_writes&&
     localReady.environment===publicReady.environment&&
     localReady.financialWrites===publicReady.financialWrites&&
     localReady.onlinePaymentsEnabled===publicReady.onlinePaymentsEnabled,
      'PUBLIC_LOCAL_ROUTE_CONSISTENCY');
   console.log('POSTDEPLOY_VERSION=RC8-POSTDEPLOY-20261023.1');
   console.log('POSTDEPLOY_RC8_SHA='+sha);
   console.log('POSTDEPLOY_RC8_MODE='+mode);
   console.log('POSTDEPLOY_READ_ONLY=PASS');
   console.log(mode==='stage'?
     'STRIPE_LIVE_CHARGES=OFF':
     'STRIPE_LIVE_WEBHOOK_SETTLEMENT_AND_REFUND=REQUIRE_SEPARATE_SIGNED_PROOF');
   console.log(mode==='stage'?
     'POSTDEPLOY_STAGE_CONTRACT=PASS':
     'POSTDEPLOY_LIVE_API_CONTRACT=PASS_MANUAL_FINANCIAL_SIGNOFF_STILL_REQUIRED');
   return 0;
 }catch{
   // Do not print exception messages: they can contain keys/URLs/PM2 env.
   console.log('POSTDEPLOY_RC8=FAIL_CLOSED');
   console.log('ROLLBACK=OPERATOR_REVIEW_REQUIRED_DO_NOT_AUTO_RESTART');
   return 1;
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked)process.exitCode=await main();
