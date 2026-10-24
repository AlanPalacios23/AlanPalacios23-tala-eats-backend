// CLI smoke for PM2 v6.0.14; uses disposable files, a private PM2_HOME
// and inert synthetic processes. Never connects to databases or Stripe.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const cli=process.argv[2];
if(!cli)throw Error('USAGE: node tests/rc813-pm2-cli-smoke.mjs ABSOLUTE_PM2_CLI');
const source=readFileSync(new URL('../rc813/ecosystem.config.cjs',import.meta.url),'utf8');
assert.match(source,/name:'tala-rc813-parallel-worker'/);
assert.match(source,/name:'tala-rc813-parallel-api'/);
assert.match(source,/cwd:path.resolve\(__dirname,'\.\.'\)/);

const root=mkdtempSync(path.join(tmpdir(),'tala-rc813-pm2-'));
const home=path.join(root,'only-synthetic-pm2-home');
const eco=path.join(root,'ecosystem.config.cjs');
const paths=[
{name:'tala-rc813-parallel-worker',script:'./worker.cjs'},
{name:'tala-rc813-parallel-api',script:'./api.cjs'}
];
for(const file of ['worker.cjs','api.cjs'])writeFileSync(path.join(root,file),
  'setInterval(()=>{},60000);\n',{mode:0o600});
writeFileSync(eco,`module.exports={apps:${JSON.stringify(paths.map(x=>({
 ...x,cwd:root,instances:1,exec_mode:'fork',autorestart:false
})))}};\n`,{mode:0o600});
mkdirSync(home,{recursive:true,mode:0o700});
const env={...process.env,PM2_HOME:home,NODE_ENV:'staging'};
function pm2(...args){
 const a=spawnSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',timeout:30000});
 if(a.status!==0)throw Error('RC813_PM2_CLI_FAILED '+args.join(' ')+' '+a.stderr.slice(-1200));
 return a.stdout;
}
try{
 pm2('start',eco,'--only','tala-rc813-parallel-worker','--update-env');
 let procs=JSON.parse(pm2('jlist'));
 assert.deepEqual(procs.map(x=>x.name),['tala-rc813-parallel-worker'],
 'PM2 MUST parse config and start requested worker only');
 assert.equal(procs[0].pm2_env?.status,'online');
 assert.equal(path.resolve(procs[0].pm2_env?.pm_exec_path),path.join(root,'worker.cjs'));
 console.log('RC813_PM2_CANONICAL_ECOSYSTEM_WORKER_ONLY=PASS');

 pm2('start',eco,'--only','tala-rc813-parallel-api','--update-env');
 procs=JSON.parse(pm2('jlist'));
 assert.deepEqual(procs.map(x=>x.name).sort(),
 ['tala-rc813-parallel-api','tala-rc813-parallel-worker']);
 assert.equal(procs.every(x=>x.pm2_env?.status==='online'),true);
 assert.equal(procs.find(x=>x.name==='tala-rc813-parallel-api')?.pm2_env?.pm_exec_path,
 path.join(root,'api.cjs'));
 console.log('RC813_PM2_CANONICAL_ECOSYSTEM_API_WORKER=PASS');
}finally{
 try{pm2('kill')}catch{}
 rmSync(root,{recursive:true,force:true});
}
