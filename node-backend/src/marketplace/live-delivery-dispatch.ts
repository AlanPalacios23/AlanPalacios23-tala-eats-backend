/**
 * RC9.6 dispatch recovery for signed, reconciled LIVE delivery orders only.
 * The production admission flag remains hard-locked OFF by config.ts.
 * The actual claim uses profile+order row locks and signed-Stripe checks.
 */
import {db} from '../db.js';
import {liveDispatchReleased} from './live-delivery-payment.js';
import {dispatchStageDeliveryReady} from './driver.js';

export type DispatchRecovery={enabled:boolean;scanned:number;assigned:number;held:number};
export async function sweepLiveDeliveryReady():Promise<DispatchRecovery>{
 if(!liveDispatchReleased())return {enabled:false,scanned:0,assigned:0,held:0};
 const rows=await db.marketOrder.findMany({
  where:{orderType:'delivery',status:'ready',driverId:null,
    paymentMethod:'stripe',paymentStatus:'paid',refundedAmount:0},
  select:{id:true},orderBy:[{readyAt:'asc'},{id:'asc'}],take:10,
 });
 let assigned=0,held=0;
 for(const row of rows){
  try{
   if(await dispatchStageDeliveryReady(row.id))assigned++;
   else held++;
  }catch{held++;/* durable READY order remains; next sweep retries */}
 }
 return {enabled:true,scanned:rows.length,assigned,held};
}
