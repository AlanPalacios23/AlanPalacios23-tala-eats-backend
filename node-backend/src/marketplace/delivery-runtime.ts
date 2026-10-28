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
