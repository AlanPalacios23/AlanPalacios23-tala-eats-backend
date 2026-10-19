// C3: synthetic cash pickup close-out, based on Python delivery_lifecycle.py.
// No external capture, settlement, payouts, referrals, or driver dispatch.
// Explicitly disabled unless C1 isolated cash/pickup feature flag is enabled.
import { timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { db } from '../db.js';
import { config } from '../config.js';
import type { AuthUser } from '../generated/prisma/client.js';

class PickupError extends Error {
  constructor(public readonly code:number,message:string){super(message);}
}
const reject=(code:number,message:string):never=>{throw new PickupError(code,message);};
const secureCompare=(a:string,b:string):boolean=>{
  if(!/^\d{4}$/.test(a)||!/^\d{4}$/.test(b))return false;
  return timingSafeEqual(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));
};
// Redis is required, not optional: limits attempts at 4-digit PIN guessing
// before any DB row locks. This key is per order/actor, TTL 15 minutes.
async function limitPickupPin(orderId:number,userId:number):Promise<void>{
  const redis=new Redis(config.REDIS_URL,{
    lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,
    retryStrategy:()=>null,
  });
  try{
    await redis.connect();
    const key='tala:node:stage:pickup:pin:'+orderId+':'+userId;
    const count=await redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
      1,key,
    );
    if(Number(count)>5)reject(429,'Demasiados intentos de PIN. Inténtalo más tarde.');
  }catch(error){
    if(error instanceof PickupError)throw error;
    reject(503,'Validación de PIN temporalmente no disponible');
  }finally{
    redis.disconnect();
  }
}
function earnedPoints(total:string):number{
  if(!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(total))
    return reject(503,'Total de pedido inválido en staging');
  const [whole,fraction='']=total.split('.');
  const centavos=BigInt(whole!)*100n+BigInt((fraction+'00').slice(0,2));
  const result=centavos/1000n; // Python int(Decimal(order.total) // 10)
  return Number(result>=1n?result:1n);
}
const dayNumber=(when:Date):number=>Math.floor(Date.UTC(
  when.getUTCFullYear(),when.getUTCMonth(),when.getUTCDate(),
)/86_400_000);
export type PickupProof = {
  pin:string;
  photo_url?:string;
  lat?:number|null;
  lng?:number|null;
};
export async function completeCashPickupStage(
  orderId:number, actor:AuthUser, payload:PickupProof,
):Promise<number>{
  if(config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true')
    reject(503,'Entrega de staging deshabilitada');
  if(!['restaurant','admin'].includes(actor.role))
    reject(403,'No autorizado');
  await limitPickupPin(orderId,actor.id);
  return db.$transaction(async tx=>{
    const found=await tx.$queryRaw<{id:number}[]>`
      SELECT id FROM orders WHERE id=${orderId} FOR UPDATE
    `;
    if(!found.length)reject(404,'Pedido no encontrado');
    const order=await tx.marketOrder.findUnique({
      where:{id:orderId},include:{restaurant:true},
    });
    if(!order)return reject(404,'Pedido no encontrado');
    if(actor.role!=='admin' && order.restaurant.ownerId!==actor.id)
      reject(403,'Ese pedido no pertenece a tu restaurante');
    if(order.orderType!=='pickup'||order.paymentMethod!=='cash')
      reject(503,'Solamente recogida en efectivo de staging');
    // Replay is idempotent only if a valid proof exists.
    if(order.status==='delivered'){
      const saved=await tx.stageDeliveryProof.findUnique({where:{orderId:order.id}});
      if(!saved?.pinVerified || !secureCompare(payload.pin,order.deliveryPin))
        reject(409,'Pedido ya cerrado; comprobación inválida');
      return order.id;
    }
    if(order.status!=='ready'||order.paymentStatus!=='pending')
      reject(409,'El pedido para recoger debe estar listo antes de entregarse');
    // Exclude legacy/imported records that did not originate in isolated C1.
    const initial=await tx.stageOrderEvent.findFirst({
      where:{orderId:order.id,status:'received'},orderBy:{id:'asc'},
    });
    let mac:unknown;
    try{mac=JSON.parse(initial?.metadataJson??'{}').checkout_intent_hmac;}catch{}
    if(typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac))
      reject(503,'Este pedido no tiene evidencia de checkout de staging');
    if(!secureCompare(payload.pin,order.deliveryPin))
      reject(400,'PIN incorrecto');
    // Serialize points/streak adjustments for a customer's simultaneous orders.
    const wallets=await tx.$queryRaw<{id:number}[]>`
      SELECT id FROM loyalty_accounts WHERE user_id=${order.userId} FOR UPDATE
    `;
    if(!wallets.length)reject(503,'Cuenta de fidelidad no disponible');
    const loyalty=await tx.authLoyaltyAccount.findUnique({where:{userId:order.userId}});
    if(!loyalty)return reject(503,'Cuenta de fidelidad no disponible');
    const last=await tx.marketOrder.findFirst({
      where:{userId:order.userId,status:'delivered',id:{not:order.id},deliveredAt:{not:null}},
      orderBy:[{deliveredAt:'desc'},{id:'desc'}],
    });
    const now=new Date();
    const add=earnedPoints(order.total.toString());
    const points=loyalty.points+add;
    if(points>2_000_000_000)reject(503,'Tope de puntos de staging excedido');
    const streak=last?.deliveredAt?
      (dayNumber(now)-dayNumber(last.deliveredAt)<=7?loyalty.streakDays+1:1):
      Math.max(1,loyalty.streakDays);
    const tier=points>=3000?'BLACK':points>=1500?'GOLD':points>=600?'SILVER':'BRONZE';
    await tx.marketOrder.update({
      where:{id:order.id},data:{
        status:'delivered',deliveredAt:now,paymentStatus:'paid',
        cashCollected:order.total, // synthetic only: does NOT imply real capture
      },
    });
    await tx.stageDeliveryProof.create({data:{
      orderId:order.id,driverId:actor.id,pinVerified:true,
      photoUrl:payload.photo_url??'',lat:payload.lat??null,lng:payload.lng??null,
    }});
    await tx.authLoyaltyAccount.update({
      where:{userId:order.userId},data:{points,tier,streakDays:streak},
    });
    await tx.stageOrderEvent.create({data:{
      orderId:order.id,status:'delivered',actorUserId:actor.id,
      metadataJson:JSON.stringify({source:'merchant_delivery_pin',stage_only:true}),
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+order.id+':delivered',
      aggregateType:'order',aggregateId:String(order.id),eventType:'order.status',
      payloadJson:JSON.stringify({order_id:order.id,status:'delivered'}),
    }});
    await tx.stageProductEvent.create({data:{
      userId:order.userId,sessionId:'server',eventName:'order_delivered',
      route:'/pedido/'+order.id,propertiesJson:JSON.stringify({order_id:order.id}),
    }});
    await tx.authNotification.createMany({data:[
      {userId:order.userId,kind:'reward',title:'Puntos acreditados',
        message:'Ganaste '+add+' puntos por el pedido #'+order.id+'. Racha: '+streak+'.'},
      {userId:order.userId,kind:'delivery',title:'Pedido entregado',
        message:'Pedido #'+order.id+' entregado. ¡Buen provecho!'},
    ]});
    return order.id;
  },{maxWait:10_000,timeout:20_000});
}
