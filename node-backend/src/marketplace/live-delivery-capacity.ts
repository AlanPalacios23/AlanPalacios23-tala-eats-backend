/**
 * RC11.2: LIVE-only customer delivery capacity check.
 * This is an honest, read-only availability signal, NOT a driver reservation.
 * The order admission transaction must recheck it before accepting a delivery.
 * Redis locations are never returned to customers or used after their TTL.
 */
import {Redis} from 'ioredis';
import {db} from '../db.js';
import {config} from '../config.js';
import {driverLocationKey,hasFreshVerifiedDriverGps} from './delivery-runtime.js';

const MAX_CANDIDATES=100;
const ACTIVE_STATUSES=['assigned','picked_up','on_the_way'] as const;

export function liveDriverNearPickup(
 raw:string|null,origin:{lat:number;lng:number},nowMs:number,
 pickupRadiusKm:number,
):boolean {
 if(!Number.isFinite(origin.lat)||!Number.isFinite(origin.lng)||
    Math.abs(origin.lat)>90||Math.abs(origin.lng)>180||
    !Number.isFinite(pickupRadiusKm)||pickupRadiusKm<1||pickupRadiusKm>30||
    !hasFreshVerifiedDriverGps(raw,120,nowMs))return false;
 try{
  const loc=JSON.parse(raw!) as {lat:number;lng:number};
  const r=Math.PI/180;
  const dLat=(loc.lat-origin.lat)*r,dLng=(loc.lng-origin.lng)*r;
  const a=Math.sin(dLat/2)**2+
   Math.cos(loc.lat*r)*Math.cos(origin.lat*r)*Math.sin(dLng/2)**2;
  const km=6371.0088*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
  return km<=pickupRadiusKm;
 }catch{return false;}
}

export async function hasReachableLiveDriver(origin:{lat:number;lng:number}):Promise<boolean>{
 if(config.NODE_ENV!=='production'||config.LIVE_DRIVER_PRESENCE_ENABLED!=='true'||
    config.MERCHANT_MANAGED_DELIVERY==='true')return false;
 if(!Number.isFinite(origin.lat)||!Number.isFinite(origin.lng)||
    Math.abs(origin.lat)>90||Math.abs(origin.lng)>180)return false;
 const profiles=await db.marketplaceDriverProfile.findMany({
  where:{isVerified:true,isOnline:true,user:{is:{role:'driver',isActive:true}}},
  select:{userId:true},take:MAX_CANDIDATES,orderBy:{userId:'asc'},
 });
 if(!profiles.length)return false;
 const active=await db.marketOrder.findMany({
  where:{driverId:{in:profiles.map(p=>p.userId)},status:{in:[...ACTIVE_STATUSES]}},
  select:{driverId:true},take:MAX_CANDIDATES,
 });
 const busy=new Set(active.map(o=>o.driverId).filter((id):id is number=>id!==null));
 const eligible=profiles.filter(p=>!busy.has(p.userId));
 if(!eligible.length)return false;
 const redis=new Redis(config.REDIS_URL,{
  lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,
  retryStrategy:()=>null,
 });
 try{
  await redis.connect();
  const values=await redis.mget(...eligible.map(p=>driverLocationKey('production',p.userId)));
  const now=Date.now();
  return values.some(raw=>liveDriverNearPickup(raw,origin,now,config.STAGE_DRIVER_MAX_PICKUP_KM));
 }catch{
  // Never advertise a delivery capacity when Redis/GPS cannot be trusted.
  return false;
 }finally{redis.disconnect();}
}
