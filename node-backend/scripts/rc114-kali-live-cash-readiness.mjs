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
import Stripe from 'stripe';
import {config} from '../dist/config.js';
import {db} from '../dist/db.js';
import {assertRestaurantDeliveryOrigin} from '../dist/marketplace/delivery-geography.js';
import {hasReachableLiveDriver} from '../dist/marketplace/live-delivery-capacity.js';
import {liveCashDeliveryReleased} from '../dist/marketplace/live-cash-delivery.js';
import {pickupCapability} from '../dist/live/pickup-readiness.js';

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
 // A reachable driver and an open restaurant are NOT enough: customer checkout
 // requires a verified owner-mapped Stripe Connect account even for CASH.
 const restaurants=await db.marketplaceRestaurant.findMany({
  where:{verificationStatus:'verified',onboardingStatus:'approved',isOpen:true,
   pickupEnabled:true,deliveryRadiusKm:{gt:0},ownerId:{not:null}},
  select:{id:true,lat:true,lng:true,address:true,ownerId:true,isOpen:true,
   pickupEnabled:true,verificationStatus:true,onboardingStatus:true,
   owner:{select:{isActive:true,email:true}}},
  take:25,orderBy:{id:'asc'},
 });
 let valid=0,approvedLocal=0,verifiedConnect=0,reachable=0;
 const ids=restaurants.map(r=>r.id);
 const mappingRows=ids.length?await db.$queryRawUnsafe(
  'SELECT restaurant_id,stripe_account_id,owner_approved_at FROM tala_live_merchant_accounts WHERE restaurant_id IN ('+
   ids.map((_,i)=>'$'+(i+1)).join(',')+')',...ids):[];
 const mappings=new Map(mappingRows.map(r=>[r.restaurant_id,r]));
 const stripe=new Stripe(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0,timeout:5000});
 const platformReady=['STRIPE_LIVE_ENABLED','STRIPE_LIVE_RELEASE_APPROVED',
  'STRIPE_FINANCIAL_WRITES_ENABLED','STRIPE_REFUNDS_ENABLED',
  'STRIPE_MANUAL_SETTLEMENT_APPROVED'].every(k=>config[k]==='true');
 for(const r of restaurants){
  try{assertRestaurantDeliveryOrigin({lat:r.lat,lng:r.lng},r.address);}
  catch{continue;}
  valid++;
  const m=mappings.get(r.id);
  if(!m?.stripe_account_id||!m?.owner_approved_at||
    !r.owner?.isActive||!r.owner.email)continue;
  approvedLocal++;
  try{
   const seller=await stripe.accounts.retrieve(m.stripe_account_id);
   const projected=pickupCapability({
    id:r.id,is_open:r.isOpen,pickup_enabled:r.pickupEnabled,
    verification_status:r.verificationStatus,
    onboarding_status:r.onboardingStatus,owner_id:r.ownerId,
    owner_email:r.owner.email,owner_active:r.owner.isActive,
    stripe_account_id:m.stripe_account_id,owner_approved_at:m.owner_approved_at,
   },seller,platformReady,config.STRIPE_PLATFORM_ACCOUNT_ID,true);
   if(!projected.ready||seller.charges_enabled!==true)continue;
   verifiedConnect++;
  }catch{continue;}
  if(await hasReachableLiveDriver({lat:r.lat,lng:r.lng}))reachable++;
 }
 console.log('RC114_VERIFIED_OPEN_DELIVERY_RESTAURANTS_SAMPLE='+valid);
 console.log('RC114_OWNER_APPROVED_CONNECT_MAPPINGS_SAMPLE='+approvedLocal);
 console.log('RC114_STRIPE_LIVE_SELLERS_ELIGIBLE_SAMPLE='+verifiedConnect);
 console.log('RC114_SELLERS_WITH_REACHABLE_IDLE_DRIVER_SAMPLE='+reachable);
 console.log('RC114_SAMPLE_LIMIT=25');
 console.log('RC114_STRIPE_OPERATIONS=GET_ONLY');
 console.log('RC114_DB_WRITES=NONE');
 console.log('RC114_REDIS_WRITES=NONE');
 if(!valid||!approvedLocal||!verifiedConnect||!reachable){
  console.log('RC114_CASH_RELEASE_READINESS=HOLD_NO_APPROVED_STRIPE_SELLER_AND_DRIVER_PAIR');
  process.exitCode=2;
 }else{
  console.log('RC114_CASH_RELEASE_READINESS=SELLER_CONNECT_AND_DRIVER_CAPACITY_PRESENT');
  console.log('RC114_E2E_ORDER_PAYMENT_PIN=NOT_VERIFIED');
 }
}finally{
 redis.disconnect();
 await db.$disconnect();
}
