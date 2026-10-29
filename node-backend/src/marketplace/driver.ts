// D2: Isolated functional driver flow. Python reference: app/routes/driver.py.
// Merchant-generated delivery/online PSP unsupported; ONLY CI fixture cash
// deliveries with a recorded stage_driver_fixture marker can be mutated.
import { timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { db } from '../db.js';
import { config } from '../config.js';
import {stageDeliveryTenderAllowed} from './delivery-financial-proof.js';
import {liveDispatchReleased,liveDeliveryTenderAllowed} from './live-delivery-payment.js';
import {liveCashDeliveryReleased,liveCashDeliveryTenderAllowed} from './live-cash-delivery.js';
import {canOperateDriverPresence,driverLocationKey,driverPersistKey,hasFreshVerifiedDriverGps} from './delivery-runtime.js';
import type { AuthUser } from '../generated/prisma/client.js';

const ACTIVE=['assigned','picked_up','on_the_way'];
class DriverError extends Error {
  constructor(public readonly code:number,message:string){super(message);}
}
const fail=(code:number,message:string):never=>{throw new DriverError(code,message);};
const stage=()=>{
  if(config.STAGE_DRIVER_DELIVERY_ENABLED!=='true')
    fail(503,'Entregas Node aún no habilitadas fuera del laboratorio aislado');
};
// The live driver-pilot only permits verified online presence and GPS.
// Accept, pickup, PIN and checkout still use the independent stage() lock.
const deliveryActions=()=>{
 if(config.NODE_ENV==='production'){
  if(!liveDispatchReleased()&&!liveCashDeliveryReleased())fail(503,'Reparto LIVE pendiente de pruebas y autorización financiera');
 }else stage();
};
const presence=()=>{
  if(!canOperateDriverPresence(config.NODE_ENV,
     config.STAGE_DRIVER_DELIVERY_ENABLED==='true',
     config.LIVE_DRIVER_PRESENCE_ENABLED==='true'))
    fail(503,'Presencia de repartidor no habilitada en este entorno');
};
function redisClient() {
  return new Redis(config.REDIS_URL,{
    lazyConnect:true,connectTimeout:2000,maxRetriesPerRequest:1,retryStrategy:()=>null,
  });
}
const profilePublic=(p:{vehicle:string;plate:string;isOnline:boolean;isVerified:boolean;
  rating:{toString():string};totalDeliveries:number;currentLat:number|null;
  currentLng:number|null;earningsToday:{toString():string}})=>({
  vehicle:p.vehicle,plate:p.plate,is_online:p.isOnline,is_verified:p.isVerified,
  rating:p.rating.toString(),total_deliveries:p.totalDeliveries,
  current_lat:p.currentLat,current_lng:p.currentLng,
  earnings_today:p.earningsToday.toString(),
});
const haversine=(lat1:number,lng1:number,lat2:number,lng2:number)=>{
  const rad=Math.PI/180;
  const x=(lat2-lat1)*rad, y=(lng2-lng1)*rad;
  const z=Math.sin(x/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(y/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(z),Math.sqrt(1-z));
};
async function fixture(tx:{
  stageOrderEvent:{findFirst:(arg:any)=>Promise<any>};
},orderId:number):Promise<boolean>{
  const receipt=await tx.stageOrderEvent.findFirst({
    where:{orderId,status:'received'},orderBy:{id:'asc'},
  });
  try{
    const proof=JSON.parse(receipt?.metadataJson??'{}');
    return proof.stage_driver_fixture===true||
      (config.NODE_ENV==='staging'&&
       config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&
       /^[a-f0-9]{64}$/.test(proof.checkout_intent_hmac??'')&&
       proof.stage_delivery_customer_v1===true);
  }catch{return false;}
}
/**
 * Location heartbeat is Redis TTL-backed (120 seconds). A profile marked
 * online in PostgreSQL is NOT proof the driver is reachable; the app may
 * have been killed without issuing an offline request.
 */
export async function hasReachableStageDriver(
  restaurant:{lat:number;lng:number}):Promise<boolean>{
  if(config.NODE_ENV!=='staging'||
     config.STAGE_DRIVER_DELIVERY_ENABLED!=='true'||
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true'||
     !Number.isFinite(restaurant.lat)||!Number.isFinite(restaurant.lng))return false;
  const profiles=await db.marketplaceDriverProfile.findMany({
    where:{isVerified:true,isOnline:true,
      user:{is:{role:'driver',isActive:true}}},
    select:{userId:true},take:100,orderBy:{userId:'asc'},
  });
  if(!profiles.length)return false;
  const redis=redisClient();
  try{
    await redis.connect();
    // Single bounded MGET instead of N Redis connects while checkout holds
    // PostgreSQL locks; Redis's 120s key expiry is the heartbeat deadline.
    const values=await redis.mget(
      ...profiles.map(p=>driverLocationKey(config.NODE_ENV,p.userId)));
    return values.some(raw=>{
      if(!raw)return false;
      try{
        const p=JSON.parse(raw) as {lat:unknown;lng:unknown};
        return typeof p.lat==='number'&&typeof p.lng==='number'&&
          Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&
          Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180&&
          haversine(p.lat,p.lng,restaurant.lat,restaurant.lng)<=
            config.STAGE_DRIVER_MAX_PICKUP_KM;
      }catch{return false;}
    });
  }catch{return false;}finally{redis.disconnect();}
}
const profileByUser=async(userId:number)=>db.marketplaceDriverProfile.upsert({
  where:{userId},create:{userId,isVerified:false},update:{},
});
/**
 * Authenticated driver-only readiness. Publicly expose neither GPS nor
 * private contact information. Redis TTL proves a recent heartbeat, while
 * PostgreSQL proves ADMIN-approved active status. Does not accept orders.
 */
export async function driverPresenceReadiness(actor:AuthUser){
  const enabled=canOperateDriverPresence(config.NODE_ENV,
    config.STAGE_DRIVER_DELIVERY_ENABLED==='true',
    config.LIVE_DRIVER_PRESENCE_ENABLED==='true');
  const profile=await db.marketplaceDriverProfile.findUnique({
    where:{userId:actor.id},select:{isOnline:true,isVerified:true},
  });
  const verified=profile?.isVerified===true&&actor.isActive===true;
  const online=profile?.isOnline===true;
  let freshGps=false;
  if(enabled&&verified&&online){
    const redis=redisClient();
    try{
      await redis.connect();
      const key=driverLocationKey(config.NODE_ENV,actor.id);
      const [raw,ttl]=await Promise.all([redis.get(key),redis.ttl(key)]);
      freshGps=hasFreshVerifiedDriverGps(raw,ttl,Date.now());
    }catch{/* Availability must fail closed on Redis failures. */}
    finally{redis.disconnect();}
  }
  return {
    environment:config.NODE_ENV,
    presence_enabled:enabled,
    admin_verified:verified,
    online,
    fresh_gps:freshGps,
    ready_for_dispatch:enabled&&verified&&online&&freshGps&&
      // RC9.5 does NOT authorize assignment or LIVE checkout.
      ((config.NODE_ENV==='staging'&&config.STAGE_DRIVER_DELIVERY_ENABLED==='true')||
       (config.NODE_ENV==='production'&&
         (liveCashDeliveryReleased()||liveDispatchReleased()))),
    live_delivery_checkout_enabled:false,
    live_stripe_delivery_enabled:false,
  };
}
export async function canDriverReachPickup(
 driverId:number,origin:{lat:number;lng:number}):Promise<boolean>{
 if(config.NODE_ENV!=='staging'||!Number.isSafeInteger(driverId)||driverId<1||
    !Number.isFinite(origin.lat)||!Number.isFinite(origin.lng))return false;
 const gps=await redisLocation(driverId);
 return Boolean(gps&&haversine(gps!.lat,gps!.lng,origin.lat,origin.lng)<=
    config.STAGE_DRIVER_MAX_PICKUP_KM);
}
async function redisLocation(driverId:number):Promise<{lat:number;lng:number}|null>{
  const redis=redisClient();
  try{
    await redis.connect();
    const key=driverLocationKey(config.NODE_ENV,driverId);
    const [str,ttl]=await Promise.all([redis.get(key),redis.ttl(key)]);
    if(!str||config.NODE_ENV==='production'&&
       !hasFreshVerifiedDriverGps(str,ttl,Date.now()))return null;
    const p=JSON.parse(str) as {lat:number;lng:number};
    return typeof p.lat==='number'&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&
      typeof p.lng==='number'&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180?p:null;
  }catch{return null;}finally{redis.disconnect();}
}
// All driver claims use profile-row lock FIRST (same driver) then SKIP LOCKED
// on each order. Different drivers never both claim a single order.
async function assign(tx:any,driverId:number,forcedOrderId?:number):Promise<number|null>{
  if(config.NODE_ENV==='production'&&!liveDispatchReleased()&&!liveCashDeliveryReleased())return null;
  const p=await tx.marketplaceDriverProfile.findUnique({where:{userId:driverId}});
  if(!p?.isOnline||!p.isVerified)return null;
  const active=await tx.marketOrder.findFirst({where:{
    driverId,status:{in:ACTIVE}},select:{id:true},
  });
  if(active)return null;
  const fresh=await redisLocation(driverId);
  const lat=fresh?.lat??p.currentLat,lng=fresh?.lng??p.currentLng;
  const candidates=await tx.marketOrder.findMany({
    where:{status:'ready',driverId:null,orderType:'delivery',
      OR:config.NODE_ENV==='production'?
        [...(liveCashDeliveryReleased()?
          [{paymentMethod:'cash',paymentStatus:'pending'}]:[]),
         ...(liveDispatchReleased()?
           [{paymentMethod:'stripe',paymentStatus:'paid'}]:[])]:
        [{paymentMethod:'cash',paymentStatus:'pending'},
         {paymentMethod:'stripe',paymentStatus:'paid'}],
      ...(forcedOrderId?{id:forcedOrderId}:{})},
    include:{restaurant:true},take:forcedOrderId?1:25,
    orderBy:[{readyAt:'asc'},{updatedAt:'asc'},{id:'asc'}],
  });
  const scored=candidates.map((x:any)=>({
    row:x,score:lat!==null&&lng!==null?
      haversine(lat,lng,x.restaurant.lat,x.restaurant.lng):9999,
  })).sort((a:any,b:any)=>a.score-b.score||
    (a.row.readyAt?.getTime()??a.row.updatedAt.getTime())-
      (b.row.readyAt?.getTime()??b.row.updatedAt.getTime())||
    a.row.id-b.row.id);
  for(const {row} of scored){
    const lock=await tx.$queryRawUnsafe(
      'SELECT id FROM orders WHERE id=$1 AND status=$2 AND driver_id IS NULL FOR UPDATE SKIP LOCKED',
      row.id,'ready',
    );
    if(!lock.length)continue;
    if(config.NODE_ENV==='production'){
      if(!(row.paymentMethod==='cash'?
        await liveCashDeliveryTenderAllowed(tx,row):
        await liveDeliveryTenderAllowed(tx,row)))continue;
    }else{
      if(!await fixture(tx,row.id))continue;
      if(!await stageDeliveryTenderAllowed(tx,row))continue;
    }
    // Prevent dispatch to a stale online flag. Synthetic D2 fixtures retain
    // their older isolated test behavior, but real customer orders must have
    // a fresh Redis location heartbeat from the driver app.
    const received=await tx.stageOrderEvent.findFirst({
      where:{orderId:row.id,status:'received'},orderBy:{id:'asc'},
      select:{metadataJson:true},
    });
    let actualCustomerDelivery=false;
    try{actualCustomerDelivery=JSON.parse(received?.metadataJson??'{}')
      .stage_delivery_customer_v1===true;}catch{}
    if(config.NODE_ENV==='production')actualCustomerDelivery=true;
    if(actualCustomerDelivery&&(!fresh||
       haversine(fresh.lat,fresh.lng,row.restaurant.lat,row.restaurant.lng)>
          config.STAGE_DRIVER_MAX_PICKUP_KM))continue;
    const changed=await tx.marketOrder.updateMany({
      where:{id:row.id,status:'ready',driverId:null,orderType:'delivery'},
      data:{driverId,status:'assigned'},
    });
    if(changed.count!==1)continue;
    await tx.stageOrderEvent.create({data:{
      orderId:row.id,status:'assigned',actorUserId:driverId,
      metadataJson:JSON.stringify({source:forcedOrderId?'driver_accept':'driver_online_auto_claim'}),
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+row.id+':assigned',aggregateType:'order',
      aggregateId:String(row.id),eventType:'order.assigned',
      payloadJson:JSON.stringify({driver_id:driverId,status:'assigned'}),
    }});
    await tx.authNotification.createMany({data:[
      {userId:driverId,kind:'delivery',title:'Nueva entrega asignada',
        message:'Pedido #'+row.id+' listo para recoger.'},
      {userId:row.userId,kind:'delivery',title:'Repartidor asignado',
        message:'Ya asignamos repartidor a tu pedido #'+row.id+'.'},
    ]});
    return row.id;
  }
  return null;
}
async function withProfileLock<T>(driverId:number,perform:(tx:any)=>Promise<T>):Promise<T>{
  await profileByUser(driverId);
  return db.$transaction(async tx=>{
    const locked=await tx.$queryRawUnsafe(
      'SELECT id FROM driver_profiles WHERE user_id=$1 FOR UPDATE',driverId,
    );
    if(!Array.isArray(locked)||!locked.length)return fail(503,'Perfil del repartidor no disponible');
    return perform(tx);
  },{maxWait:10000,timeout:20000});
}
export async function driverAvailability(actor:AuthUser,isOnline:boolean){
  presence();
  const result=await withProfileLock(actor.id,async tx=>{
    const profile=await tx.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
    if(!profile)return fail(503,'Perfil del repartidor no disponible');
    if(isOnline&&!profile.isVerified)
      return fail(403,'Se requiere verificación del repartidor');
    if(!isOnline){
      const active=await tx.marketOrder.count({where:{driverId:actor.id,status:{in:ACTIVE}}});
      if(active>0)fail(409,'Finaliza la entrega activa antes de desconectarte');
    }
    await tx.marketplaceDriverProfile.update({
      where:{userId:actor.id},data:{isOnline},
    });
    // LIVE check-in never claims or creates an order. Dispatch remains locked.
    if(isOnline&&config.NODE_ENV==='staging')await assign(tx,actor.id);
    return profilePublic({...profile,isOnline});
  });
  // On offline, retire fresh GPS presence immediately; a Redis outage does
  // not change the committed DB offline state, which also gates eligibility.
  if(!isOnline&&config.NODE_ENV==='production'){
    const redis=redisClient();
    try{
      await redis.connect();
      await redis.del(driverLocationKey(config.NODE_ENV,actor.id),
        driverPersistKey(config.NODE_ENV,actor.id));
    }catch{/* online=false in PostgreSQL is the authoritative exclusion */}
    finally{redis.disconnect();}
  }
  return result;
}
/**
 * Driver offer list in LIVE is read-only and privacy-preserving.
 * Customer address, GPS and PIN are never exposed before the profile has
 * atomically claimed the delivery. The worker may auto-assign first.
 */
export async function liveCashDriverOffers(actor:AuthUser,limit:number){
 if(!liveCashDeliveryReleased())return [];
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail(422,'Límite inválido');
 const profile=await db.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
 if(!profile?.isVerified||!profile.isOnline||!actor.isActive)return [];
 const busy=await db.marketOrder.count({
  where:{driverId:actor.id,status:{in:ACTIVE}},
 });
 if(busy>0)return [];
 const fresh=await redisLocation(actor.id);
 if(!fresh)return [];
 const orders=await db.marketOrder.findMany({
  where:{orderType:'delivery',status:'ready',driverId:null,
   paymentMethod:'cash',paymentStatus:'pending'},
  include:{restaurant:true},take:limit,
  orderBy:[{readyAt:'asc'},{id:'asc'}],
 });
 const offers=[];
 for(const order of orders){
  if(haversine(fresh.lat,fresh.lng,order.restaurant.lat,order.restaurant.lng)>
     config.STAGE_DRIVER_MAX_PICKUP_KM)continue;
  if(!await liveCashDeliveryTenderAllowed(db,order))continue;
  offers.push({
   id:order.id,status:'ready',order_type:'delivery',
   restaurant_id:order.restaurantId,
   restaurant:{id:order.restaurantId,name:order.restaurant.name,
    address:order.restaurant.address,
    lat:order.restaurant.lat,lng:order.restaurant.lng},
   driver_earning:order.driverEarning.toString(),tip:order.tip.toString(),
   distance_km:order.distanceKm,total:order.total.toString(),
  });
 }
 return offers;
}

export async function driverAccept(actor:AuthUser,orderId:number){
  deliveryActions();
  return withProfileLock(actor.id,async tx=>{
    const p=await tx.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
    if(!p?.isOnline||!p.isVerified)fail(400,'Debes estar disponible y verificado');
    const active=await tx.marketOrder.count({where:{driverId:actor.id,status:{in:ACTIVE}}});
    if(active)fail(409,'Ya tienes una entrega activa');
    const claim=await assign(tx,actor.id,orderId);
    if(claim===null){
      const exists=await tx.marketOrder.findUnique({where:{id:orderId}});
      if(!exists)fail(404,'Pedido no encontrado');
      fail(409,'Pedido no disponible');
    }
    return claim!;
  });
}
export async function driverStatus(actor:AuthUser,orderId:number,next:string){
  deliveryActions();
  return db.$transaction(async tx=>{
    const locked=await tx.$queryRawUnsafe(
      'SELECT id FROM orders WHERE id=$1 FOR UPDATE',orderId,
    );
    if(!Array.isArray(locked)||!locked.length)return fail(404,'Pedido no encontrado');
    const o=await tx.marketOrder.findUnique({where:{id:orderId}});
    if(!o)return fail(404,'Pedido no encontrado');
    if(o.driverId!==actor.id)fail(403,'Pedido no asignado');
    const allowed:{[k:string]:string}={assigned:'picked_up',picked_up:'on_the_way'};
    if(allowed[o.status]!==next)fail(409,'Transición inválida: '+o.status+' → '+next);
    if(o.orderType!=='delivery'||!(config.NODE_ENV==='production'?
       (o.paymentMethod==='cash'?
         await liveCashDeliveryTenderAllowed(tx,o):
         await liveDeliveryTenderAllowed(tx,o)):
       await fixture(tx,orderId)&&await stageDeliveryTenderAllowed(tx,o)))
      fail(503,'Pedido sin prueba de pago autorizada para reparto');
    await tx.marketOrder.update({where:{id:orderId},data:{
      status:next,...(next==='picked_up'?{pickedUpAt:new Date()}:{})
    }});
    await tx.stageOrderEvent.create({data:{
      orderId,status:next,actorUserId:actor.id,metadataJson:'{"source":"driver"}',
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+orderId+':status:'+next,
      aggregateType:'order',aggregateId:String(orderId),eventType:'order.status',
      payloadJson:JSON.stringify({status:next,driver_id:actor.id}),
    }});
    await tx.authNotification.create({data:{
      userId:o.userId,kind:'delivery',title:'Tu repartidor avanza',
      message:'Pedido #'+orderId+': '+next+'.',
    }});
    return orderId;
  },{maxWait:10000,timeout:20000});
}
export async function driverGps(actor:AuthUser,lat:number,lng:number){
  presence();
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||
     Math.abs(lat)>90||Math.abs(lng)>180)
    fail(422,'Coordenadas de ubicación inválidas');
  if(config.NODE_ENV==='production'){
    const p=await db.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
    if(!p?.isVerified||!p.isOnline)
      fail(403,'Debes estar aprobado y conectado para enviar GPS');
  }else{
    await profileByUser(actor.id);
  }
  const redis=redisClient();
  let persist=false;
  try{
    await redis.connect();
    const payload=JSON.stringify({lat,lng,reported_at:new Date().toISOString()});
    const keys=[driverLocationKey(config.NODE_ENV,actor.id),
      driverPersistKey(config.NODE_ENV,actor.id)];
    const result=await redis.eval(
      "redis.call('SET',KEYS[1],ARGV[1],'EX',120); "+
      "return redis.call('SET',KEYS[2],'1','NX','EX',15)",
      2,...keys,payload,
    );
    persist=result==='OK';
  }catch{fail(503,'Servicio de ubicación temporalmente no disponible');}
  finally{redis.disconnect();}
  const profile=persist?
    await db.marketplaceDriverProfile.update({where:{userId:actor.id},
      data:{currentLat:lat,currentLng:lng}}):
    await db.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
  if(!profile)return fail(503,'Perfil del repartidor no encontrado');
  if(liveDispatchReleased()||liveCashDeliveryReleased()){
    try{await withProfileLock(actor.id,tx=>assign(tx,actor.id));}
    catch{/* Recovery worker will retry READY. GPS commit remains valid. */}
  }
  return {...profilePublic(profile),current_lat:lat,current_lng:lng};
}
function deliveryPayload(o:any){
  const r=o.restaurant,u=o.customer;
  return {
    id:o.id,code:'TE-'+String(o.id).padStart(4,'0'),status:o.status,
    payment_method:o.paymentMethod,payment_status:o.paymentStatus,
    restaurant:{id:r.id,name:r.name,
      address:r.address.trim()||'Punto del restaurante · '+r.lat.toFixed(5)+', '+r.lng.toFixed(5),
      lat:r.lat,lng:r.lng},
    customer:{id:u.id,name:u.name,phone:u.phone,address:o.address,
      lat:o.deliveryLat,lng:o.deliveryLng},
    total:Number(o.total),earning:Number(o.driverEarning)+Number(o.tip),
    distance_km:o.distanceKm,eta_minutes:o.estimatedMinutes,note:o.notes,
    created_at:o.createdAt.toISOString(),delivered_at:o.deliveredAt?.toISOString()??null,
  };
}
const includes={restaurant:true,customer:true} as const;
export async function driverDashboard(actor:AuthUser){
  const p=await profileByUser(actor.id);
  const now=new Date();
  const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-6));
  const [active,recent,week]=await Promise.all([
    db.marketOrder.findFirst({
      where:{driverId:actor.id,status:{in:ACTIVE}},include:includes,
      orderBy:{updatedAt:'asc'},
    }),
    db.marketOrder.findMany({where:{driverId:actor.id,status:'delivered'},
      include:includes,orderBy:[{deliveredAt:'desc'},{updatedAt:'desc'}],take:20}),
    db.marketOrder.findMany({
      where:{driverId:actor.id,status:'delivered',deliveredAt:{gte:start}},
      select:{deliveredAt:true,driverEarning:true,tip:true,distanceKm:true},
    }),
  ]);
  const days=new Map<string,{earnings:number;deliveries:number;distance_km:number}>();
  for(const row of week){
    if(!row.deliveredAt)continue;
    const date=row.deliveredAt.toISOString().slice(0,10);
    const prev=days.get(date)??{earnings:0,deliveries:0,distance_km:0};
    prev.earnings+=Number(row.driverEarning)+Number(row.tip);
    prev.deliveries++;prev.distance_km+=row.distanceKm;
    days.set(date,prev);
  }
  const dates=Array.from({length:7},(_,i)=>{
    const day=new Date(start.getTime()+i*86400000).toISOString().slice(0,10);
    const point=days.get(day)??{earnings:0,deliveries:0,distance_km:0};
    return {date:day,earnings:Math.round(point.earnings*100)/100,deliveries:point.deliveries};
  });
  const todayKey=now.toISOString().slice(0,10);
  const today=days.get(todayKey)??{earnings:0,deliveries:0,distance_km:0};
  return {
    user:{id:actor.id,name:actor.name,phone:actor.phone,avatar_url:actor.avatarUrl},
    profile:profilePublic(p),
    active:active?deliveryPayload(active):null,
    recent:recent.map(deliveryPayload),
    today:{earnings:Math.round(today.earnings*100)/100,deliveries:today.deliveries,
      distance_km:Math.round(today.distance_km*100)/100,
      average_earning:today.deliveries?today.earnings/today.deliveries:0},
    acceptance_rate:100,last_7_days:dates,
  };
}
async function throttlePin(orderId:number,actorId:number){
  const redis=redisClient();
  try{
    await redis.connect();
    const prefix=config.NODE_ENV==='production'?'tala:node:live':'tala:node:stage';
    const a=prefix+':delivery:pin:'+orderId+':'+actorId;
    const b=prefix+':delivery:pin:order:'+orderId;
    const count=await redis.eval(
      "local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],900) end; "+
      "local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],900) end; "+
      "return {a,b}",2,a,b,
    );
    if(!Array.isArray(count)||count.length!==2||
      Number(count[0])>5||Number(count[1])>12)
      fail(429,'Demasiados intentos de PIN');
  }catch(e){
    if(e instanceof DriverError)throw e;
    fail(503,'Verificación de PIN no disponible');
  }finally{redis.disconnect();}
}
const pointValue=(value:string)=>{
  if(!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value))return fail(503,'Total inválido');
  const [a,b='']=value.split('.');
  return Number(BigInt(a!)*100n+BigInt((b+'00').slice(0,2))) / 100;
};
export async function driverComplete(actor:AuthUser,orderId:number,
  proof:{pin:string;photo_url?:string;lat?:number|null;lng?:number|null}){
  deliveryActions();
  const candidate=await db.marketOrder.findUnique({
    where:{id:orderId},select:{driverId:true,orderType:true,paymentMethod:true},
  });
  if(!candidate)return fail(404,'Pedido no encontrado');
  if(candidate.driverId!==actor.id)fail(403,'Pedido no asignado');
  if(candidate.orderType!=='delivery'||!['cash','stripe'].includes(candidate.paymentMethod))
    fail(503,'Modalidad de entrega no habilitada en staging');
  await throttlePin(orderId,actor.id);
  const id=await withProfileLock(actor.id,async tx=>{
    const locked=await tx.$queryRawUnsafe(
      'SELECT id FROM orders WHERE id=$1 FOR UPDATE',orderId,
    );
    if(!locked.length)fail(404,'Pedido no encontrado');
    const o=await tx.marketOrder.findUnique({where:{id:orderId}});
    if(!o)return fail(404,'Pedido no encontrado');
    if(o.driverId!==actor.id)fail(403,'Pedido no asignado');
    if(o.status==='delivered'){
      const existing=await tx.stageDeliveryProof.findUnique({where:{orderId}});
      if(!existing?.pinVerified||!/^\d{4}$/.test(proof.pin)||
         !timingSafeEqual(Buffer.from(o.deliveryPin),Buffer.from(proof.pin)))
        fail(409,'Pedido sin prueba de entrega válida');
      return orderId;
    }
    if(o.status!=='on_the_way')fail(409,'Primero marca el pedido como en camino');
    if(config.NODE_ENV==='production'){
      const valid=o.paymentMethod==='cash'?
        await liveCashDeliveryTenderAllowed(tx,o):
        await liveDeliveryTenderAllowed(tx,o);
      if(!valid)
        fail(503,'Entrega LIVE sin autorización financiera o con riesgo abierto');
    }else{
      if(!await fixture(tx,orderId))fail(503,'Entrega fuera de contrato de staging');
      if(!await stageDeliveryTenderAllowed(tx,o))
        fail(503,'Pago digital sin recibo Stripe TEST firmado o efectivo inválido');
    }
    if(!/^\d{4}$/.test(o.deliveryPin)||!/^\d{4}$/.test(proof.pin)||
      !timingSafeEqual(Buffer.from(o.deliveryPin),Buffer.from(proof.pin)))
      fail(400,'PIN incorrecto');
    // Concurrency-safe exactly-once wallet points and driver metrics.
    const wallet=await tx.$queryRawUnsafe(
      'SELECT id FROM loyalty_accounts WHERE user_id=$1 FOR UPDATE',o.userId,
    );
    if(!wallet.length)fail(503,'Cuenta de puntos no disponible');
    const account=await tx.authLoyaltyAccount.findUnique({where:{userId:o.userId}});
    if(!account)fail(503,'Cuenta de puntos no disponible');
    const profileLocks=await tx.$queryRawUnsafe(
      'SELECT id FROM driver_profiles WHERE user_id=$1 FOR UPDATE',actor.id,
    );
    if(!profileLocks.length)fail(503,'Perfil de repartidor no disponible');
    const p=await tx.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
    if(!p)fail(503,'Perfil de repartidor no disponible');
    const previous=await tx.marketOrder.findFirst({where:{
      userId:o.userId,status:'delivered',id:{not:orderId},deliveredAt:{not:null},
    },orderBy:{deliveredAt:'desc'}});
    const now=new Date();
    const pointsEarned=Math.max(1,Math.floor(pointValue(o.total.toString())/10));
    const points=account.points+pointsEarned;
    if(points>2_000_000_000)fail(503,'Puntos fuera de rango');
    const gap=previous?.deliveredAt?
      Math.floor((Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())-
        Date.UTC(previous.deliveredAt.getUTCFullYear(),
          previous.deliveredAt.getUTCMonth(),previous.deliveredAt.getUTCDate()))/86400000):null;
    const streak=gap!==null&&gap<=7?account.streakDays+1:Math.max(1,account.streakDays);
    const tier=points>=3000?'BLACK':points>=1500?'GOLD':points>=600?'SILVER':'BRONZE';
    await tx.marketOrder.update({where:{id:orderId},data:{
      status:'delivered',deliveredAt:now,
      ...(o.paymentMethod==='cash'?
        {paymentStatus:'paid',cashCollected:o.total}:{}),
    }});
    // The driver physically collects cash at PIN delivery, never Stripe.
    // Atomic, idempotent and held for manual reconciliation; not withdrawable.
    if(o.paymentMethod==='cash'){
      await tx.stageFinancialLedgerEntry.create({data:{
        orderId,userId:o.userId,restaurantId:o.restaurantId,
        account:'cash_collected_by_driver',direction:'credit',amount:o.total,
        kind:'cash_delivery_collection',
        description:'Efectivo recibido por repartidor en entrega; conciliación pendiente',
        idempotencyKey:'order:'+orderId+':cash-delivery:collected',
      }});
    }
    await tx.stageDeliveryProof.create({data:{
      orderId,driverId:actor.id,pinVerified:true,
      photoUrl:proof.photo_url??'',lat:proof.lat??null,lng:proof.lng??null,
    }});
    await tx.marketplaceDriverProfile.update({where:{userId:actor.id},data:{
      totalDeliveries:{increment:1},
      earningsToday:p.earningsToday.add(o.driverEarning).add(o.tip),
    }});
    await tx.authLoyaltyAccount.update({where:{userId:o.userId},data:{points,tier,streakDays:streak}});
    await tx.stageOrderEvent.create({data:{
      orderId,status:'delivered',actorUserId:actor.id,
      metadataJson:JSON.stringify({source:'delivery_pin',
        stage_only:config.NODE_ENV==='staging'}),
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+orderId+':delivered',aggregateType:'order',
      aggregateId:String(orderId),eventType:'order.status',
      payloadJson:JSON.stringify({status:'delivered',driver_id:actor.id}),
    }});
    await tx.stageProductEvent.create({data:{
      userId:o.userId,sessionId:'server',eventName:'order_delivered',
      route:'/pedido/'+orderId,propertiesJson:JSON.stringify({order_id:orderId}),
    }});
    await tx.authNotification.createMany({data:[
      {userId:o.userId,kind:'reward',title:'Puntos acreditados',
        message:'Ganaste '+pointsEarned+' puntos por el pedido #'+orderId+'. Racha: '+streak+'.'},
      {userId:o.userId,kind:'delivery',title:'Pedido entregado',
        message:'Pedido #'+orderId+' entregado. ¡Buen provecho!'},
    ]});
    return orderId;
  });
  // Consistent with Python: claim another ready order, without failing a
  // delivery that has already committed if the next claim is unavailable.
  try{await withProfileLock(actor.id,async tx=>assign(tx,actor.id));}catch{/* next assignment best effort */}
  return id;
}

/**
 * RC8.7: merchant READY event attempts immediate non-duplicating dispatch.
 * Row locks use exactly the same claim protocol as driver availability.
 * A missing driver leaves READY pending; future login/complete will retry.
 * Never called for test fixtures or production while the new flag is off.
 */
export async function dispatchStageDeliveryReady(orderId:number):Promise<boolean>{
  if(!((config.NODE_ENV==='staging'&&
        config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&
        config.STAGE_DRIVER_DELIVERY_ENABLED==='true')||
       (config.NODE_ENV==='production'&&liveDispatchReleased())))
    return false;
  if(!Number.isSafeInteger(orderId)||orderId<=0)return false;
  const profiles=await db.marketplaceDriverProfile.findMany({
    where:{isVerified:true,isOnline:true,
      user:{is:{role:'driver',isActive:true}}},
    select:{userId:true},orderBy:{userId:'asc'},take:100,
  });
  for(const p of profiles){
    try{
      const id=await withProfileLock(p.userId,tx=>assign(tx,p.userId,orderId));
      if(id===orderId)return true;
    }catch{
      // Failed driver must never fail merchant READY transaction or
      // duplicate an assignment to a second driver.
    }
  }
  return false;
}
