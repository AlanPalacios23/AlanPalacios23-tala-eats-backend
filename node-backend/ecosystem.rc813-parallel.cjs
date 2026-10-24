// RC8.13 independent PM2 names + daemon, NEVER modify the LIVE/default PM2.
const path=require('node:path');
const expected='/home/tala-node-stage/.config/talaeats-node-rc813-parallel.env';
if(process.env.TALA_RC813_ENV_FILE!==expected||
   process.env.PM2_HOME!=='/home/tala-node-stage/.pm2-tala-rc813-parallel')
  throw Error('RC813_EXCLUSIVE_STAGE_PM2_HOME_AND_ENV_REQUIRED');
module.exports={apps:[
 {name:'tala-rc813-parallel-worker',cwd:__dirname,script:'./dist/worker.js',
  node_args:['--env-file='+expected],exec_mode:'fork',instances:1,
  autorestart:true,max_memory_restart:'256M',kill_timeout:10000,
  env:{NODE_ENV:'staging',STAGE_PARALLEL_ENABLED:'true'}},
 {name:'tala-rc813-parallel-api',cwd:__dirname,script:'./dist/server.js',
  node_args:['--env-file='+expected],exec_mode:'fork',instances:1,
  autorestart:true,max_memory_restart:'256M',kill_timeout:10000,
  env:{NODE_ENV:'staging',STAGE_PARALLEL_ENABLED:'true'}},
]};
