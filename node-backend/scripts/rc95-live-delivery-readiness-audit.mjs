#!/usr/bin/env node
/**
 * RC9.5 LIVE DELIVERY RELEASE AUDIT — READ-ONLY and fail-closed.
 * Run as the existing tala-node-stage user from the exact deployed
 * node-backend cwd. Never changes PM2/Stripe/Redis/Postgres or env.
 *
 * --source : static guard review, no database/network/credentials
 * --live   : requires attested production env, checks worker, API and
 *            counts only. Exit 2 means NO-GO, not a broken server.
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const mode=process.argv[2];
if(process.argv.length!==3||!['--source','--live'].includes(mode)){
 console.error('USAGE: node scripts/rc95-live-delivery-readiness-audit.mjs --source|--live');
 process.exit(64);
}
const root=resolve(process.cwd());
const read=(path)=>readFileSync(resolve(root,path),'utf8');
const findings=[];
const record=(name,ok,detail)=>findings.push({name,ok,detail});
const configSrc=read('src/config.ts');
const routeSrc=read('src/marketplace/routes.ts');
const checkoutSrc=read('src/marketplace/checkout.ts');
const driverSrc=read('src/marketplace/driver.ts');
const lifecycleSrc=read('src/marketplace/lifecycle.ts');
const financialSrc=read('src/marketplace/delivery-financial-proof.ts');
const workerSrc=read('src/live/production-worker.ts');

// Each condition below describes an EXISTING production blocker and is
// intentionally negative. Removing the text must trigger a NEW review,
// not produce an automatic GO.
record('PRODUCTION_DELIVERY_FEATURE_FLAG',
 !/STAGE_DRIVER_DELIVERY_ENABLED!=='false'/.test(configSrc) &&
 !/STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='false'/.test(configSrc),
 'Current production config explicitly rejects staging driver/delivery flags');
record('LIVE_DELIVERY_CHECKOUT',
 /liveCard=isStripePickupIntent\(req\.body\)/.test(routeSrc)===false &&
 /const liveStripe=cardStripePickup&&/.test(checkoutSrc)===false,
 'Current LIVE card checkout and order creation accept pickup only');
let gpsRuntimeSrc='';
try{gpsRuntimeSrc=read('src/marketplace/delivery-runtime.ts');}catch{/* RC9.4 deployed source */}
record('LIVE_GPS_NAMESPACE',
 /driverLocationKey\(config\.NODE_ENV/.test(driverSrc)&&
 /driverPersistKey\(config\.NODE_ENV/.test(driverSrc)&&
 /'live'/.test(gpsRuntimeSrc),
 'Driver GPS heartbeat keys are isolated by environment; no LIVE dispatch enabled');
record('LIVE_READY_DISPATCH',
 !/if\(next==='ready'&&config\.NODE_ENV==='staging'/.test(lifecycleSrc),
 'Restaurant READY dispatch is staging-only');
record('LIVE_DRIVER_TENDER_PROOF',
 !/config\.NODE_ENV!=='staging'/.test(financialSrc),
 'Cash and card handoff must use verified LIVE-specific tender and ledger');
record('LIVE_DRIVER_PRESENCE_MOBILE_E2E',false,
 'No verified connected driver or device GPS evidence; LIVE presence opt-in must stay off');
record('LIVE_DISPATCH_WORKER',
 /dispatchStageDeliveryReady|dispatchLiveDeliveryReady|dispatchReadyDelivery/.test(workerSrc),
 'Production worker currently runs finance, mail and web push but no READY recovery');
record('DELIVERY_EXTERNAL_PROVIDER_AND_DEVICE_E2E',false,
 'Needs independently attested real Stripe TEST signed webhook, 3 Android devices, GPS, PIN and incident recovery');
record('LIVE_RECONCILIATION_AND_OPERATOR_RELEASE',false,
 'Requires reviewed refunds/disputes, cash debt handling, delivery pricing, manual authorization and rollback');
for(const f of findings)
 console.log('RC95_'+f.name+'='+(f.ok?'SOURCE_GUARD_CLEARED':'HOLD'));
if(mode==='--source'){
 console.log('RC95_DELIVERY_SOURCE_READINESS=NO_GO');
 console.log('RC95_SOURCE_INSPECTION=PASS_READ_ONLY');
 process.exitCode=2;
}else{
 const expected='0c8d92fa62ae910843b3d4c764da85a852b17085';
 const fail=(name)=>{console.error('RC95_AUDIT_ABORT='+name);process.exit(3);};
 if(process.getuid?.()===0||process.env.HOME!=='/home/tala-node-stage')
  fail('SERVICE_USER_REQUIRED');
 const sha=execFileSync('git',['-C',resolve(root,'..'),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 if(sha!==expected||root!==resolve('/home/tala-node-stage/tala-node-releases',expected,'node-backend'))
  fail('LIVE_SHA_OR_CWD_NOT_ATTESTED');
 const configMod=await import(pathToFileURL(resolve(root,'dist/config.js')).href);
 const config=configMod.config;
 const u=new URL(config.DATABASE_URL);
 if(config.NODE_ENV!=='production'||u.hostname!=='127.0.0.1'||
    u.port!=='15445'||u.pathname!=='/tala_node_live'||
    config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
    config.TREASURY_CONNECT_WEBHOOK_INGEST_ENABLED!=='false')
  fail('LIVE_DB_OR_MONEY_FLAGS');
 const cwdExpected=root;
 const pm2=JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8',timeout:8000}));
 const expectedPM2={
  'tala-node-stage-api':'dist/server.js',
  'tala-node-stage-worker':'dist/live/production-worker.js',
 };
 if(pm2.length!==2)fail('PM2_PROCESS_COUNT');
 for(const [name,rel] of Object.entries(expectedPM2)){
  const matches=pm2.filter(x=>x.name===name);
  if(matches.length!==1||matches[0].pm2_env?.status!=='online'||
    matches[0].pm2_env.pm_cwd!==cwdExpected||
    matches[0].pm2_env.pm_exec_path!==resolve(root,rel))
   fail('PM2_IDENTITY_'+name);
 }
 console.log('RC95_TWO_LIVE_PM2=PASS');
 for(const [name,url] of [
  ['LOCAL','http://127.0.0.1:18190/api/v1/ready'],
  ['PUBLIC','https://talaeats.alan-palacios-dev.com/api/v1/ready']]){
  let res,data;
  try{
   res=await fetch(url,{signal:AbortSignal.timeout(10000)});
   data=await res.json();
  }catch{fail(name+'_READY_UNAVAILABLE');}
  if(!res.ok||data.ready!==true||data.workerOnline!==true||
     data.environment!=='production'||data.onlinePaymentsEnabled!==true)
   fail(name+'_READY_MISMATCH');
  console.log('RC95_EXISTING_'+name+'_PAYMENTS_AND_WORKER=PASS');
 }
 // Read only aggregate counts: never output customer/driver identities,
 // addresses, bank details, live keys, orders or monetary balances.
 const dbMod=await import(pathToFileURL(resolve(root,'dist/db.js')).href);
 const db=dbMod.db;
 try{
  const [stores,drivers,unassigned]=await Promise.all([
   db.marketplaceRestaurant.count({where:{isOpen:true,verificationStatus:'verified'}}),
   db.marketplaceDriverProfile.count({where:{isVerified:true,isOnline:true,
    user:{is:{role:'driver',isActive:true}}}}),
   db.marketOrder.count({where:{orderType:'delivery',status:'ready',driverId:null}}),
  ]);
  console.log('RC95_APPROVED_OPEN_MERCHANT_COUNT='+stores);
  console.log('RC95_VERIFIED_DRIVER_ONLINE_FLAG_COUNT='+drivers);
  // Presence evidence is separate from the PostgreSQL online toggle.
  // LIVE namespace is deliberately empty on unmodified RC9.4 deployment.
  const verifiedOnline=await db.marketplaceDriverProfile.findMany({
    where:{isVerified:true,isOnline:true,user:{is:{role:'driver',isActive:true}}},
    select:{userId:true},orderBy:{userId:'asc'},take:100,
  });
  let fresh=0;
  let gpsRead='PASS';
  const {createRequire}=await import('node:module');
  const requireFromRelease=createRequire(resolve(root,'package.json'));
  const Redis=requireFromRelease('ioredis');
  const redis=new Redis(config.REDIS_URL,{
    lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,retryStrategy:()=>null,
  });
  try{
    await redis.connect();
    for(const row of verifiedOnline){
      const key='tala:node:live:driver:'+row.userId+':location';
      const [raw,ttl]=await Promise.all([redis.get(key),redis.ttl(key)]);
      if(!raw||ttl<1||ttl>120)continue;
      try{
        const p=JSON.parse(raw);
        const age=Date.now()-Date.parse(p.reported_at);
        if(typeof p.lat==='number'&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&
           typeof p.lng==='number'&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180&&
           Number.isFinite(age)&&age>=0&&age<=120000)fresh++;
      }catch{/* unknown/stale GPS is never counted */}
    }
  }catch{gpsRead='UNAVAILABLE';}
  finally{redis.disconnect();}
  console.log('RC95_FRESH_VERIFIED_LIVE_DRIVER_GPS_COUNT='+fresh);
  console.log('RC95_LIVE_GPS_INSPECTION='+gpsRead);

  console.log('RC95_UNASSIGNED_READY_DELIVERIES_COUNT='+unassigned);
  console.log('RC95_ONLINE_DB_FLAG_IS_NOT_FRESH_GPS=YES');
 }finally{await db.$disconnect();}
 console.log('RC95_EXISTING_STRIPE_LIVE_CHECKOUT=UNCHANGED');
 console.log('RC95_CONNECT_PAYOUTS=LOCKED');
 console.log('RC95_DELIVERY_LIVE_RELEASE=HOLD');
 console.log('RC95_LIVE_AUDIT=PASS_READ_ONLY');
 process.exitCode=2;
}
