#!/usr/bin/env node
/**
 * RC8.9: POST-PROMOTION READ-ONLY audit for the existing Kali PM2 staging
 * deployment. Run with Node 24 --env-file pointing to the private STAGING
 * file; never accepts production, keys, passwords, tokens or arbitrary URLs.
 *
 * This DOES NOT activate payments or declare a commercial GO.
 * Scope: same installed SHA/PM2, stage API/worker, delivery worker sweep,
 * actual unassigned READY checkout backlog, financial isolation.
 */
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const SHA=/^[0-9a-f]{40}$/;
const LOCAL='http://127.0.0.1:18190/api/v1';
const PUBLIC='https://talaeats.alan-palacios-dev.com/api/v1';
const SWEEP_KEY='tala:node:stage:dispatch:sweep:ok';
const WORKER_KEY='tala:node:stage:worker:heartbeat';

/**
 * Both PM2 processes must import the SAME private 0600 config path as this
 * read-only audit; NODE_ENV alone does not prove feature flag consistency.
 * The ecosystem intentionally uses Node 24's --env-file, not shell 'source'.
 */
export function validatePm2EnvSource(processes,envPath){
  if(!Array.isArray(processes)||processes.length!==2||
     envPath!=='/home/tala-node-stage/.config/talaeats-node-staging.env')
    return false;
  const names=processes.map(p=>p?.name).sort();
  if(JSON.stringify(names)!==JSON.stringify(
     ['tala-node-stage-api','tala-node-stage-worker']))return false;
  return processes.every(p=>{
    const e=p?.pm2_env;
    const args=e?.node_args;
    return e?.NODE_ENV==='staging'&&e.status==='online'&&
      Array.isArray(args)&&args.length===1&&
      args[0]==='--env-file='+envPath;
  });
}

export function validateStageHttp(health,ready,payments,stripe,delivery){
  const stage=health?.status==='ok'&&health.production===false&&
    health.digital_payment_provider==='stripe'&&
    health.online_payment_writes===false&&
    ready?.ready===true&&ready.database===true&&ready.redis===true&&
    ready.workerOnline===true&&ready.productionReady===false&&
    ready.environment==='staging'&&ready.financialWrites===false&&
    ready.onlinePaymentsEnabled===false&&
    payments?.provider==='stripe'&&payments.environment==='staging'&&
    payments.financial_writes_enabled===false&&
    stripe?.provider==='stripe'&&stripe.environment==='staging'&&
    stripe.financial_writes_enabled===false;
  if(!stage)return false;
  for(const key of [payments.publishable_key,stripe.publishable_key]){
    if(key!==null&&key!==undefined&&
       (typeof key!=='string'||!key.startsWith('pk_test_')))return false;
  }
  if(payments.publishable_key!==stripe.publishable_key)return false;
  if(payments.enabled!==stripe.enabled||
     payments.checkout_ready!==stripe.checkout_ready||
     (delivery&&ready.workerOnline!==true))return false;
  return true;
}

export function reviewReadyBacklog(orders,events,nowMs,limit=200,ageMs=120000){
  if(!Array.isArray(orders)||!Array.isArray(events)||
     !Number.isSafeInteger(nowMs)||nowMs<=0||
     !Number.isSafeInteger(limit)||limit<1||orders.length>limit||
     orders.length===limit)return {pass:false,reason:'BACKLOG_SCAN_INCOMPLETE',
       eligible:0,overdue:0};
  const markers=new Set(events.filter(e=>{
    if(!e||typeof e.orderId!=='number')return false;
    try{
      const v=JSON.parse(e.metadataJson??'{}');
      return v.stage_delivery_customer_v1===true&&
        /^[a-f0-9]{64}$/.test(v.checkout_intent_hmac??'');
    }catch{return false;}
  }).map(e=>e.orderId));
  let eligible=0,overdue=0;
  for(const o of orders){
    if(!markers.has(o.id))continue;
    const when=o.readyAt instanceof Date?o.readyAt.getTime():NaN;
    if(!Number.isFinite(when)||when>nowMs+5000)
      return {pass:false,reason:'READY_TIMESTAMP_INVALID',eligible,overdue};
    eligible++;
    if(nowMs-when>ageMs)overdue++;
  }
  return {pass:overdue===0,reason:overdue?'READY_BACKLOG_OVERDUE':'OK',
    eligible,overdue};
}
async function getJson(base,path){
  const r=await fetch(base+path,{
    method:'GET',redirect:'error',
    headers:{accept:'application/json','cache-control':'no-store'},
    signal:AbortSignal.timeout(base===LOCAL?5000:10000),
  });
  if(!r.ok||!r.headers.get('content-type')?.includes('application/json'))
    throw Error('READONLY_HTTP_CONTRACT');
  const body=await r.text();
  if(body.length>12000)throw Error('READONLY_RESPONSE_LIMIT');
  return JSON.parse(body);
}
async function getDeny(base){
  const r=await fetch(base+'/orders/payment-methods',{
    method:'GET',redirect:'error',
    headers:{accept:'application/json'},signal:AbortSignal.timeout(8000),
  });
  // No bearer token: do not leak private payment choices or customer data.
  return r.status===401||r.status===403;
}
export async function main(args=process.argv.slice(2)){
  if(args.length!==2||args[0]!=='--stage-sha'||!SHA.test(args[1]??'')){
    console.log('USAGE: node --env-file=<PRIVATE_STAGE_ENV> scripts/rc89-postdeploy-dispatch-audit.mjs --stage-sha <40_CHAR_SHA>');
    return 2;
  }
  const sha=args[1];
  if(process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
     homedir()!=='/home/tala-node-stage'||process.env.NODE_ENV!=='staging'){
    console.log('RC89_REQUIRES_EXACT_STAGE_USER_AND_RUNTIME=FAIL');
    return 1;
  }
  let redis,db;
  try{
    const root=join('/home/tala-node-stage/tala-node-releases',sha,'node-backend');
    // Existing RC8 audit is the source of truth for PM2 exact two-process
    // identity, clean release SHA, 0600 env, local+public health, rollback.
    const parent=execFileSync(process.execPath,
      [join(root,'scripts','rc8-postdeploy-audit.mjs'),'--mode','stage',sha],
      {cwd:root,env:process.env,timeout:65000,maxBuffer:65536,encoding:'utf8'});
    if(!parent.includes('POSTDEPLOY_READ_ONLY=PASS')||
       !parent.includes('POSTDEPLOY_STAGE_CONTRACT=PASS'))
      throw Error('PARENT_SHA_AND_PM2_AUDIT');
    // PM2's node_args must source only the exact, private staging file.
    // Keep full jlist exclusively in memory: it can contain credentials.
    const processSnapshot=JSON.parse(execFileSync('pm2',['jlist'],{
      encoding:'utf8',timeout:10_000,maxBuffer:4*1024*1024,
      env:{...process.env,PM2_HOME:join(homedir(),'.pm2')},
    }));
    if(!validatePm2EnvSource(processSnapshot,
       '/home/tala-node-stage/.config/talaeats-node-staging.env'))
      throw Error('PM2_STAGE_ENV_SOURCE_MISMATCH');
    const {config}=await import('../dist/config.js');
    const {db:client}=await import('../dist/db.js');
    const {Redis}=await import('ioredis');
    db=client;
    if(config.NODE_ENV!=='staging'||
       config.STRIPE_LIVE_ENABLED!=='false'||
       config.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
       config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false')
      throw Error('STAGING_FINANCIAL_ISOLATION');
    const active=config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true';
    if(active&&(config.STAGE_DRIVER_DELIVERY_ENABLED!=='true'||
        config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'))
      throw Error('STAGE_DISPATCH_FLAGS');
    const [h,r,p,s,ph,pr,pp,ps,privateLocal,privatePublic]=await Promise.all([
      getJson(LOCAL,'/health'),getJson(LOCAL,'/ready'),
      getJson(LOCAL,'/payments/config'),getJson(LOCAL,'/payments/stripe/config'),
      getJson(PUBLIC,'/health'),getJson(PUBLIC,'/ready'),
      getJson(PUBLIC,'/payments/config'),getJson(PUBLIC,'/payments/stripe/config'),
      getDeny(LOCAL),getDeny(PUBLIC),
    ]);
    if(!validateStageHttp(h,r,p,s,active)||
       !validateStageHttp(ph,pr,pp,ps,active)||
       h.version!==ph.version||r.environment!==pr.environment||
       p.enabled!==pp.enabled||s.enabled!==ps.enabled||
       !privateLocal||!privatePublic)
      throw Error('API_CONTRACT_OR_ACCESS');
    redis=new Redis(config.REDIS_URL,{
      lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,
      retryStrategy:()=>null,
    });
    await redis.connect();
    if(await redis.get(WORKER_KEY)!=='online')
      throw Error('WORKER_HEARTBEAT_ABSENT');
    if(active){
      if(await redis.get(SWEEP_KEY)!=='1')
        throw Error('READY_SWEEP_NOT_PROVEN');
      // Bound scanning work and avoid printing IDs, addresses or geodata.
      const orders=await db.marketOrder.findMany({
        where:{orderType:'delivery',paymentMethod:'cash',
          paymentStatus:'pending',status:'ready',driverId:null},
        select:{id:true,readyAt:true},
        orderBy:[{readyAt:'asc'},{id:'asc'}],take:200,
      });
      const events=orders.length?await db.stageOrderEvent.findMany({
        where:{orderId:{in:orders.map(x=>x.id)},status:'received'},
        select:{orderId:true,metadataJson:true},
      }):[];
      const backlog=reviewReadyBacklog(orders,events,Date.now());
      if(!backlog.pass)throw Error('UNASSIGNED_READY_BACKLOG');
      console.log('RC89_DISPATCH_SWEEP_HEARTBEAT=PASS');
      console.log('RC89_READY_BACKLOG_OVERDUE=0');
    }else{
      console.log('RC89_DISPATCH_FEATURE=OFF_BY_DEFAULT');
      console.log('RC89_DISPATCH_COMMERCIAL_READY=NO');
    }
    console.log('RC89_EXACT_PM2_SHA_AND_PUBLIC_API=PASS');
    console.log('RC89_FINANCIAL_ISOLATION=PASS');
    console.log('RC89_AUTHENTICATION_GUARD=PASS');
    console.log(active?'RC89_DISPATCH_STAGING_CHECK=PASS':
      'RC89_STANDBY_CHECK=PASS');
    console.log('RC89_POSTDEPLOY_READ_ONLY=PASS');
    console.log('RC89_PRODUCTION_GO=NO');
    return 0;
  }catch{
    // No exception text (may contain connection details or private env).
    console.log('RC89_POSTDEPLOY=FAIL_CLOSED');
    console.log('ROLLBACK=OPERATOR_REVIEW_REQUIRED');
    return 1;
  }finally{
    await redis?.quit().catch(()=>{redis?.disconnect();});
    await db?.$disconnect().catch(()=>{});
  }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked)process.exitCode=await main();
