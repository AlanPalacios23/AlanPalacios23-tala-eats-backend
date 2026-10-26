// RC8.13 Redis DB1 recovery: archive exactly one inactive BullMQ metadata key.
// No FLUSH, no access to production Redis, no PM2 operations.
// Run from the prebuilt pinned Node release with stage-only --env-file.
import {Redis} from 'ioredis';
import {createHash} from 'node:crypto';
import {openSync,writeSync,fsyncSync,closeSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {userInfo} from 'node:os';
import {execFileSync} from 'node:child_process';

const SHA='398b531c4778a03975f30470f6979a38b9c8bb62';
const cwd='/home/tala-node-stage/tala-node-releases/'+SHA+'/node-backend';
const pm2home='/home/tala-node-stage/.pm2-tala-rc813-parallel';
const backups='/home/tala-node-stage/tala-node-stage-backups';
const key='bull:tala-node-staging-webhooks:meta';
const mode=process.argv[2];
const approve=process.argv[3];
const isApply=mode==='--apply'&&approve==='I_APPROVE_RESTORE_SAFE_DB1_META';
const stop=(reason)=>{throw new Error('RC813_REDIS_META_HOLD_'+reason)};
if(!((mode==='--plan'&&process.argv.length===3)||
       (isApply&&process.argv.length===4)))stop('MODE_OR_APPROVAL');
if(userInfo().username!=='tala-node-stage'||process.getuid()===0||
   realpathSync(process.cwd())!==cwd)stop('STAGE_USER_OR_RELEASE_CWD');
const env=process.env;
const rd=new URL(env.REDIS_URL||'http://invalid');
const pg=new URL(env.DATABASE_URL||'http://invalid');
const disabled=['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
  'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_CONNECT_TRANSFERS_ENABLED',
  'STRIPE_REFUNDS_ENABLED','STRIPE_MANUAL_SETTLEMENT_APPROVED',
  'STAGE_STRIPE_TEST_CHECKOUT_ENABLED','STAGE_DELIVERY_STRIPE_TEST_ENABLED'];
if(env.NODE_ENV!=='staging'||env.HOST!=='127.0.0.1'||
   env.STAGE_PARALLEL_ENABLED!=='true'||env.PORT!=='18192'||
   !['redis:','rediss:'].includes(rd.protocol)||rd.hostname!=='127.0.0.1'||
   rd.port!=='16379'||rd.pathname!=='/1'||!rd.password||
   !['postgres:','postgresql:'].includes(pg.protocol)||pg.hostname!=='127.0.0.1'||
   pg.port!=='15435'||pg.pathname!=='/tala_node_stage'||
   pg.username!=='tala_node_stage'||!pg.password||
   disabled.some(k=>env[k]==='true')||
   (env.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY))||
   env.WEB_PUSH_ENABLED==='true')stop('ISOLATION_FLAGS');
try{lstatSync(pm2home);stop('PARALLEL_PM2_HOME_PRESENT')}catch(e){
 if(e?.code!=='ENOENT')throw e;
}
const sockets=execFileSync('ss',['-lntH'],{encoding:'utf8',timeout:5000});
if(sockets.split('\n').some(x=>x.trim().split(/\s+/)[3]?.match(/(?:^|:)18192$/)))
 stop('STAGING_PORT_IN_USE');
const r=new Redis(env.REDIS_URL,{lazyConnect:true,connectTimeout:2000,
 maxRetriesPerRequest:1,retryStrategy:()=>null});
try{
 await r.connect();
 if(await r.dbsize()!==1||await r.exists(key)!==1||
    await r.type(key)!=='hash'||await r.hlen(key)!==2||
    await r.pttl(key)!==-1)stop('EXPECTED_ONE_PERSISTENT_META_HASH');
 const fields=await r.hkeys(key);
 if(fields.length!==2||fields.some(x=>x.toLowerCase()==='paused'))
  stop('PAUSED_OR_UNEXPECTED_META');
 const dump=await r.callBuffer('DUMP',key);
 if(!Buffer.isBuffer(dump)||dump.length===0||dump.length>100000)
  stop('UNEXPECTED_RDB_SIZE');
 console.log('RC813_REDIS_DB1_META_EXACTLY_ONE=PASS');
 console.log('RC813_REDIS_DB1_META_NOT_PAUSED=PASS');
 console.log('RC813_REDIS_DB1_BACKUP_REQUIRED=YES');
 if(!isApply){
  console.log('RC813_REDIS_DB1_META_PLAN_READ_ONLY=PASS');
 }else{
  const dir=lstatSync(backups);
  if(!dir.isDirectory()||dir.isSymbolicLink()||
     dir.uid!==process.getuid()||(dir.mode&0o777)!==0o700)
   stop('PRIVATE_BACKUP_DIR_PERMISSIONS');
  const file=join(backups,'redis-db1-bullmq-meta-'+
    new Date().toISOString().replace(/[-:.]/g,'')+'-'+process.pid+'.json');
  const payload=JSON.stringify({format:'redis-dump',db:1,key,ttlMs:-1,
    sha256:createHash('sha256').update(dump).digest('hex'),
    dumpBase64:dump.toString('base64')})+'\n';
  const fd=openSync(file,'wx',0o600);
  try{writeSync(fd,payload);fsyncSync(fd)}finally{closeSync(fd)}
  console.log('RC813_REDIS_DB1_META_BACKUP_SAVED=PASS');
  console.log('RC813_REDIS_DB1_META_BACKUP='+file);
  const lua=`
   if redis.call('DBSIZE')~=1 or redis.call('EXISTS',KEYS[1])~=1 or
      redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('HLEN',KEYS[1])~=2 or
      redis.call('PTTL',KEYS[1])~=-1 or
      redis.call('HEXISTS',KEYS[1],'paused')~=0 or
      redis.call('DUMP',KEYS[1])~=ARGV[1]
   then return 0 end
   return redis.call('DEL',KEYS[1])
  `;
  if(await r.eval(lua,1,key,dump)!==1)stop('STATE_CHANGED_NO_DELETION');
  if(await r.dbsize()!==0)stop('AFTER_REMOVAL_NOT_EMPTY_REVIEW');
  console.log('RC813_REDIS_DB1_EXACT_META_REMOVED=PASS');
  console.log('RC813_REDIS_DB1_NOW_EMPTY=PASS');
 }
 console.log('RC813_REDIS_DB0_AND_LIVE_UNTOUCHED=YES');
}catch(e){
 console.error(String(e?.message).startsWith('RC813_REDIS_META_HOLD_')?
  e.message:'RC813_REDIS_META_HOLD_UNEXPECTED_ERROR');
 process.exitCode=1;
}finally{r.disconnect()}
