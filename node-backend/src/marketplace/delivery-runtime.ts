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
