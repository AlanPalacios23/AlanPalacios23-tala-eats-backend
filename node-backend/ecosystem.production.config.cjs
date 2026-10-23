// RC8 LIVE: replaces the TWO existing public PM2 app definitions in-place.
// DO NOT "pm2 start" as a second public stack. Promote/reload only after
// backups, full payment QA and final operator GO/NO-GO approval.
const fs=require('node:fs');
const path=require('node:path');
const file=process.env.TALA_LIVE_ENV_FILE;
if(!file||!path.isAbsolute(file)||
   !file.startsWith('/home/tala-node-stage/.config/')||
   file!=='/home/tala-node-stage/.config/talaeats-node-live.env')
 throw Error('LIVE_PM2_PRIVATE_ENV_PATH_REQUIRED');
const stat=fs.lstatSync(file);
if(!stat.isFile()||stat.isSymbolicLink()||
   (stat.mode&0o777)!==0o600||
   stat.uid!==process.getuid())
 throw Error('LIVE_PM2_PRIVATE_ENV_FILE_MUST_BE_0600_SERVICE_OWNED');
if(process.env.NODE_ENV==='staging'||process.env.TALA_STAGE_ENV_FILE)
 throw Error('LIVE_PM2_STAGE_ENV_MIX_FORBIDDEN');
module.exports={
 apps:[
  {name:'tala-node-stage-api',cwd:__dirname,script:'./dist/server.js',
   node_args:['--env-file='+file],
   exec_mode:'fork',instances:1,autorestart:true,
   max_memory_restart:'350M',kill_timeout:15000,
   env:{NODE_ENV:'production'}},
  {name:'tala-node-stage-worker',cwd:__dirname,
   script:'./dist/live/production-worker.js',
   node_args:['--env-file='+file],
   exec_mode:'fork',instances:1,autorestart:true,
   max_memory_restart:'350M',kill_timeout:15000,
   env:{NODE_ENV:'production'}}
 ]};
