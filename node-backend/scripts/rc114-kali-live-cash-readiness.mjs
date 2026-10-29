#!/usr/bin/env node
/**
 * RC11.4 production cash-delivery release readiness (READ ONLY).
 * No ability to turn on flags, update payments, create orders, or mutate DB.
 * Works from the exact git-pinned Node release /node-backend folder.
 * Prints counts, never individual coordinates, drivers, phone numbers or secrets.
 */
import {existsSync,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import Redis from 'ioredis';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
import {assertRestaurantDeliveryOrigin} from '../dist/marketplace/delivery-geography.js';
import {hasReachableLiveDriver} from '../dist/marketplace/live-delivery-capacity.js';
import {liveCashDeliveryReleased} from '../dist/marketplace/live-cash-delivery.js';

const sha=process.argv[2];
if(process.argv[1]===undefined||process.argv.length!==3||
   !/^[0-9a-f]{40}$/.test(sha||''))throw Error('RC114_ABORT=PINNED_SHA_REQUIRED');
if(process.getuid?.()===0||process.env.USER!=='tala-node-stage'||
   homedir()!=='/home/tala-node-stage')
 throw Error('RC114_ABORT=SERVICE_USER_ONLY');
const root=resolve('..'),expected=join(homedir(),'tala-node-releases',sha);
if(root!==expected||
   execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==sha)
 throw Error('RC114_ABORT=RELEASE_PATH_OR_HEAD_MISMATCH');
const envFile=join(homedir(),'.config/talaeats-node-live.env');
if(!existsSync(envFile))throw Error('RC114_ABORT=LIVE_ENV_MISSING');
const stat=lstatSync(envFile);
if(!stat.isFile()||stat.isSymbolicLink()||
   (stat.mode&0o777)!==0o600||stat.uid!==process.getuid())
 throw Error('RC114_ABORT=LIVE_ENV_PERMISSIONS');
const url=new URL(config.DATABASE_URL);
if(config.NODE_ENV!=='production'||url.hostname!=='127.0.0.1'||
   url.port!=='15445'||url.pathname!=='/tala_node_live'||
   url.username==='tala_node_stage')
 throw Error('RC114_ABORT=PRODUCTION_IDENTITY');
if(config.LIVE_DRIVER_PRESENCE_ENABLED!=='true'||
   config.COMMERCIAL_PRICING_V162_ENABLED==='true'||
   config.MERCHANT_MANAGED_DELIVERY==='true'||
   config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='false'||
   config.STAGE_DRIVER_DELIVERY_ENABLED!=='false')
 throw Error('RC114_ABORT=LIVE_DRIVER_OR_PRICING_POLICY');
if(['LIVE_DELIVERY_CASH_CHECKOUT_ENABLED',
    'LIVE_DELIVERY_CASH_DISPATCH_ENABLED',
    'LIVE_DELIVERY_CASH_RELEASE_APPROVED'].some(k=>config[k]!=='false')||
   liveCashDeliveryReleased())
 throw Error('RC114_ABORT=DELIVERY_ALREADY_RELEASED');
if(config.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
   config.LIVE_DELIVERY_CARD_CHECKOUT_ENABLED!=='false'||
   config.LIVE_DELIVERY_DISPATCH_ENABLED!=='false'||
   config.LIVE_DELIVERY_RELEASE_APPROVED!=='false')
 throw Error('RC114_ABORT=STRIPE_OR_PAYOUT_RELEASE_CHANGED');
console.log('RC114_LIVE_DATABASE_IDENTITY=PASS');
console.log('RC114_CASH_DELIVERY_FLAGS=OFF');
console.log('RC114_STRIPE_CARD_DELIVERY_AND_PAYOUTS=LOCKED');

const redis=new Redis(config.REDIS_URL,{
 lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,retryStrategy:()=>null,
});
try{
 await redis.connect();
 if(await redis.get('tala:node:live:worker:heartbeat')!=='online')
  throw Error('RC114_ABORT=WORKER_HEARTBEAT_OFFLINE');
 console.log('RC114_LIVE_WORKER_HEARTBEAT=PASS');
 const restaurants=await db.marketplaceRestaurant.findMany({
  where:{verificationStatus:'verified',isOpen:true,
   deliveryRadiusKm:{gt:0}},
  select:{lat:true,lng:true,address:true},take:25,orderBy:{id:'asc'},
 });
 let valid=0,reachable=0;
 for(const r of restaurants){
  try{assertRestaurantDeliveryOrigin({lat:r.lat,lng:r.lng},r.address);}
  catch{continue;}
  valid++;
  if(await hasReachableLiveDriver({lat:r.lat,lng:r.lng}))reachable++;
 }
 console.log('RC114_VERIFIED_OPEN_DELIVERY_RESTAURANTS_SAMPLE='+valid);
 console.log('RC114_RESTAURANTS_WITH_REACHABLE_IDLE_DRIVER_SAMPLE='+reachable);
 console.log('RC114_SAMPLE_LIMIT=25');
 console.log('RC114_DB_WRITES=NONE');
 console.log('RC114_REDIS_WRITES=NONE');
 if(!valid||!reachable){
  console.log('RC114_CASH_RELEASE_READINESS=HOLD_NO_VERIFIED_RESTAURANT_DRIVER_PAIR');
  process.exitCode=2;
 }else{
  console.log('RC114_CASH_RELEASE_READINESS=GPS_AND_CATALOG_CAPACITY_PRESENT');
  console.log('RC114_E2E_ORDER_PAYMENT_PIN=NOT_VERIFIED');
 }
}finally{
 redis.disconnect();
 await db.$disconnect();
}
