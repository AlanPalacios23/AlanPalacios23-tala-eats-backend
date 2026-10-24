// RC8.13 ONE public LIVE runtime. This is a canonical PM2 ecosystem file.
// Only the two existing LIVE process identities are allowed on port 18190.
const fs=require('node:fs');
const path=require('node:path');
const envFile='/home/tala-node-stage/.config/talaeats-node-live.env';
if(process.env.PM2_HOME!=='/home/tala-node-stage/.pm2'||
   process.env.TALA_LIVE_ENV_FILE!==envFile||
   process.env.NODE_ENV!=='production'||
   process.env.TALA_STAGE_ENV_FILE||
   process.env.STAGE_PARALLEL_ENABLED==='true')throw Error('RC813_LIVE_PM2_ISOLATION_REQUIRED');
const info=fs.lstatSync(envFile);
if(!info.isFile()||info.isSymbolicLink()||
   (info.mode&0o777)!==0o600||info.uid!==process.getuid())
   throw Error('RC813_LIVE_ENV_0600_REQUIRED');
const cwd=path.resolve(__dirname,'..');
module.exports={apps:[
 {name:'tala-node-stage-worker',cwd,script:'./dist/live/production-worker.js',
  node_args:['--env-file='+envFile],instances:1,exec_mode:'fork',
  autorestart:true,max_memory_restart:'350M',kill_timeout:15000,
  env:{NODE_ENV:'production'}},
 {name:'tala-node-stage-api',cwd,script:'./dist/server.js',
  node_args:['--env-file='+envFile],instances:1,exec_mode:'fork',
  autorestart:true,max_memory_restart:'350M',kill_timeout:15000,
  env:{NODE_ENV:'production'}}
]};
