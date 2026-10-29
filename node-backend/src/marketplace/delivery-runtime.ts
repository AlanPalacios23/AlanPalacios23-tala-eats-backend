/**
 * Redis isolation for delivery presence. A staging GPS heartbeat must never
 * make a LIVE driver appear reachable. No order, money or dispatch side effects.
 */
export type DeliveryRuntimeEnvironment='staging'|'production';
export const driverLocationKey=(env:DeliveryRuntimeEnvironment,id:number):string=>{
 if(!Number.isSafeInteger(id)||id<=0)throw new Error('INVALID_DRIVER_ID');
 return 'tala:node:'+(env==='production'?'live':'stage')+':driver:'+id+':location';
};
export const driverPersistKey=(env:DeliveryRuntimeEnvironment,id:number):string=>{
 if(!Number.isSafeInteger(id)||id<=0)throw new Error('INVALID_DRIVER_ID');
 return 'tala:node:'+(env==='production'?'live':'stage')+':driver:'+id+':persist';
};
export const canOperateDriverPresence=(
 env:DeliveryRuntimeEnvironment,stageEnabled:boolean,livePresenceEnabled:boolean,
):boolean=>env==='production'?livePresenceEnabled:stageEnabled;

/**
 * Strict parse of a recent authenticated GPS heartbeat. Redis TTL plus
 * monotonic-ish recorded_at freshness is checked; no location is returned.
 */
export const hasFreshVerifiedDriverGps=(raw:string|null,ttlSeconds:number,nowMs:number):boolean=>{
 if(!raw||!Number.isInteger(ttlSeconds)||ttlSeconds<=0||ttlSeconds>120||
    !Number.isFinite(nowMs))return false;
 try{
  const p=JSON.parse(raw) as {lat?:unknown;lng?:unknown;reported_at?:unknown};
  if(typeof p.lat!=='number'||!Number.isFinite(p.lat)||Math.abs(p.lat)>90||
     typeof p.lng!=='number'||!Number.isFinite(p.lng)||Math.abs(p.lng)>180||
     typeof p.reported_at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(p.reported_at))
   return false;
  const age=nowMs-Date.parse(p.reported_at);
  return Number.isFinite(age)&&age>=0&&age<=120000;
 }catch{return false;}
};

/**
 * LIVE distance check must use the signed-in driver's fresh Redis heartbeat,
 * not the last persisted PostgreSQL latitude/longitude.
 */
export const freshDriverNearPickup=(
 raw:string|null,origin:{lat:number;lng:number},nowMs:number,pickupRadiusKm:number,
):boolean=>{
 if(!Number.isFinite(origin.lat)||!Number.isFinite(origin.lng)||
    Math.abs(origin.lat)>90||Math.abs(origin.lng)>180||
    !Number.isFinite(pickupRadiusKm)||pickupRadiusKm<1||pickupRadiusKm>30||
    !hasFreshVerifiedDriverGps(raw,120,nowMs))return false;
 try{
  const loc=JSON.parse(raw!) as {lat:number;lng:number};
  const radians=Math.PI/180;
  const dLat=(loc.lat-origin.lat)*radians;
  const dLng=(loc.lng-origin.lng)*radians;
  const a=Math.sin(dLat/2)**2+
   Math.cos(loc.lat*radians)*Math.cos(origin.lat*radians)*Math.sin(dLng/2)**2;
  const km=6371.0088*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
  return km<=pickupRadiusKm;
 }catch{return false;}
};

/** Order LIVE couriers by the closest fresh reported GPS, like Python
 * owner._assign_best_available_driver. This ranking never reserves an order:
 * assign() MUST revalidate Redis TTL and locks before actual dispatch.
 */
export function rankFreshLiveDrivers(
 ids:readonly number[],locations:readonly (string|null)[],
 origin:{lat:number;lng:number},nowMs:number,radiusKm:number,
):{userId:number;distance:number}[]{
 if(ids.length!==locations.length||ids.length>100||
   !Number.isFinite(origin.lat)||Math.abs(origin.lat)>90||
   !Number.isFinite(origin.lng)||Math.abs(origin.lng)>180||
   !Number.isFinite(radiusKm)||radiusKm<1||radiusKm>30)return [];
 const ranked:{userId:number;distance:number}[]=[];
 for(let i=0;i<ids.length;i++){
  const userId=ids[i]!,raw=locations[i]??null;
  if(!Number.isSafeInteger(userId)||userId<=0||
     !hasFreshVerifiedDriverGps(raw,120,nowMs))continue;
  const gps=JSON.parse(raw!) as {lat:number;lng:number};
  const radians=Math.PI/180;
  const deltaLat=(gps.lat-origin.lat)*radians;
  const deltaLng=(gps.lng-origin.lng)*radians;
  const a=Math.sin(deltaLat/2)**2+
    Math.cos(gps.lat*radians)*Math.cos(origin.lat*radians)*
    Math.sin(deltaLng/2)**2;
  const distance=6371.0088*2*Math.atan2(
    Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
  if(distance<=radiusKm)ranked.push({userId,distance});
 }
 return ranked.sort((a,b)=>a.distance-b.distance||a.userId-b.userId);
}
