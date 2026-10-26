import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const script=readFileSync(fileURLToPath(new URL(
  '../scripts/rc813-redis-db1-meta-recovery.mjs',import.meta.url)),'utf8');

test('staging Redis cleanup requires exact DB1, PG15 and disabled money flags',()=>{
 for(const marker of [
  "rd.port!=='16379'","rd.pathname!=='/1'",
  "pg.port!=='15435'","pg.pathname!=='/tala_node_stage'",
  "env.PORT!=='18192'","env.NODE_ENV!=='staging'",
  "env.STRIPE_SECRET_KEY&&!/^(sk|rk)_test_/",
  "env.WEB_PUSH_ENABLED==='true'",
  "realpathSync(process.cwd())!==cwd",
  "PARALLEL_PM2_HOME_PRESENT",
  "STAGING_PORT_IN_USE",
  "I_APPROVE_RESTORE_SAFE_DB1_META"
 ])assert.ok(script.includes(marker),marker);
});

test('metadata recovery has a read-only plan, private RDB backup, atomic exact match deletion',()=>{
 for(const marker of [
  "await r.dbsize()!==1",
  "await r.exists(key)!==1",
  "await r.type(key)!=='hash'",
  "await r.hlen(key)!==2",
  "await r.pttl(key)!==-1",
  "fields.some(x=>x.toLowerCase()==='paused')",
  "await r.callBuffer('DUMP',key)",
  "RC813_REDIS_DB1_META_PLAN_READ_ONLY=PASS",
  "openSync(file,'wx',0o600)",
  "fsyncSync(fd)",
  "redis.call('DBSIZE')~=1",
  "redis.call('DUMP',KEYS[1])~=ARGV[1]",
  "return redis.call('DEL',KEYS[1])",
  "RC813_REDIS_DB1_NOW_EMPTY=PASS"
 ])assert.ok(script.includes(marker),marker);
 assert.ok(script.indexOf("RC813_REDIS_DB1_META_PLAN_READ_ONLY=PASS")<
  script.indexOf("openSync(file,'wx',0o600)"));
 assert.ok(script.indexOf("fsyncSync(fd)")<
  script.indexOf("await r.eval(lua,1,key,dump)"));
 for(const forbidden of ['FLUSHALL','FLUSHDB','KEYS *','pm2 delete','pm2 kill',
  "redis.call('DEL', 'bull:"]){
   assert.equal(script.includes(forbidden),false,forbidden);
  }
});
