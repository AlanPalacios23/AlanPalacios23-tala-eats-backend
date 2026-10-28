/**
 * RC11.2: LIVE-only customer delivery capacity check.
 * This is an honest, read-only availability signal, NOT a driver reservation.
 * The order admission transaction must recheck it before accepting a delivery.
 * Redis locations are never returned to customers or used after their TTL.
 */
import {Redis} from 'ioredis';
import {db} from '../db.js';
import {config} from '../config.js';
import {driverLocationKey,freshDriverNearPickup} from './delivery-runtime.js';

const MAX_CANDIDATES=100;
const ACTIVE_STATUSES=['assigned','picked_up','on_the_way'] as const;

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
 // Group by driver rather than selecting the first N orders: a driver with
 // many inconsistent old active orders must not hide a different busy driver.
 const active=await db.marketOrder.groupBy({
  by:['driverId'],
  where:{driverId:{in:profiles.map(p=>p.userId)},status:{in:[...ACTIVE_STATUSES]}},
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
  return values.some(raw=>freshDriverNearPickup(raw,origin,now,config.STAGE_DRIVER_MAX_PICKUP_KM));
 }catch{
  // Never advertise a delivery capacity when Redis/GPS cannot be trusted.
  return false;
 }finally{redis.disconnect();}
}
