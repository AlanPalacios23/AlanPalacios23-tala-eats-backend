// D2: Isolated functional driver flow. Python reference: app/routes/driver.py.
// Merchant-generated delivery/online PSP unsupported; ONLY CI fixture cash
// deliveries with a recorded stage_driver_fixture marker can be mutated.
import { timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { db } from '../db.js';
import { config } from '../config.js';
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
  try{return JSON.parse(receipt?.metadataJson??'{}').stage_driver_fixture===true;}
  catch{return false;}
}
const profileByUser=async(userId:number)=>db.marketplaceDriverProfile.upsert({
  where:{userId},create:{userId},update:{},
});
async function redisLocation(driverId:number):Promise<{lat:number;lng:number}|null>{
  const redis=redisClient();
  try{
    await redis.connect();
    const str=await redis.get('tala:node:stage:driver:'+driverId+':location');
    if(!str)return null;
    const p=JSON.parse(str) as {lat:number;lng:number};
    return typeof p.lat==='number'&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&
      typeof p.lng==='number'&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180?p:null;
  }catch{return null;}finally{redis.disconnect();}
}
// All driver claims use profile-row lock FIRST (same driver) then SKIP LOCKED
// on each order. Different drivers never both claim a single order.
async function assign(tx:any,driverId:number,forcedOrderId?:number):Promise<number|null>{
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
      paymentMethod:'cash',paymentStatus:'pending',
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
    const lock=await tx.$queryRawUnsafe<{id:number}[]>(
      'SELECT id FROM orders WHERE id=$1 AND status=$2 AND driver_id IS NULL FOR UPDATE SKIP LOCKED',
      row.id,'ready',
    );
    if(!lock.length)continue;
    if(!await fixture(tx,row.id))continue;
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
    const locked=await tx.$queryRawUnsafe<{id:number}[]>(
      'SELECT id FROM driver_profiles WHERE user_id=$1 FOR UPDATE',driverId,
    );
    if(!locked.length)return fail(503,'Perfil del repartidor no disponible');
    return perform(tx);
  },{maxWait:10000,timeout:20000});
}
export async function driverAvailability(actor:AuthUser,isOnline:boolean){
  stage();
  return withProfileLock(actor.id,async tx=>{
    const profile=await tx.marketplaceDriverProfile.findUnique({where:{userId:actor.id}});
    if(!profile)return fail(503,'Perfil del repartidor no disponible');
    if(!isOnline){
      const active=await tx.marketOrder.count({where:{driverId:actor.id,status:{in:ACTIVE}}});
      if(active>0)fail(409,'Finaliza la entrega activa antes de desconectarte');
    }
    await tx.marketplaceDriverProfile.update({
      where:{userId:actor.id},data:{isOnline},
    });
    if(isOnline)await assign(tx,actor.id);
    return profilePublic({...profile,isOnline});
  });
}
export async function driverAccept(actor:AuthUser,orderId:number){
  stage();
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
  stage();
  return db.$transaction(async tx=>{
    const locked=await tx.$queryRawUnsafe<{id:number}[]>(
      'SELECT id FROM orders WHERE id=$1 FOR UPDATE',orderId,
    );
    if(!locked.length)fail(404,'Pedido no encontrado');
    const o=await tx.marketOrder.findUnique({where:{id:orderId}});
    if(!o)fail(404,'Pedido no encontrado');
    if(o.driverId!==actor.id)fail(403,'Pedido no asignado');
    const allowed:{[k:string]:string}={assigned:'picked_up',picked_up:'on_the_way'};
    if(allowed[o.status]!==next)fail(409,'Transición inválida: '+o.status+' → '+next);
    if(o.paymentMethod!=='cash'||o.orderType!=='delivery'||!await fixture(tx,orderId))
      fail(503,'Pedido fuera de los contratos del laboratorio');
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
  stage();
  await profileByUser(actor.id);
  const redis=redisClient();
  let persist=false;
  try{
    await redis.connect();
    const payload=JSON.stringify({lat,lng,reported_at:new Date().toISOString()});
    const keys=['tala:node:stage:driver:'+actor.id+':location',
      'tala:node:stage:driver:'+actor.id+':persist'];
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
  if(!profile)fail(503,'Perfil del repartidor no encontrado');
  return {...profilePublic(profile),current_lat:lat,current_lng:lng};
}
function deliveryPayload(o:any){
  const r=o.restaurant,u=o.customer;
  return {
    id:o.id,code:'TE-'+String(o.id).padStart(4,'0'),status:o.status,
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
    const a='tala:node:stage:delivery:pin:'+orderId+':'+actorId;
    const b='tala:node:stage:delivery:pin:order:'+orderId;
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
  stage();
  const candidate=await db.marketOrder.findUnique({
    where:{id:orderId},select:{driverId:true,orderType:true,paymentMethod:true},
  });
  if(!candidate)fail(404,'Pedido no encontrado');
  if(candidate.driverId!==actor.id)fail(403,'Pedido no asignado');
  if(candidate.paymentMethod!=='cash'||candidate.orderType!=='delivery')
    fail(503,'Sólo entregas cash sintéticas en staging');
  await throttlePin(orderId,actor.id);
  const id=await db.$transaction(async tx=>{
    const locked=await tx.$queryRawUnsafe<{id:number}[]>(
      'SELECT id FROM orders WHERE id=$1 FOR UPDATE',orderId,
    );
    if(!locked.length)fail(404,'Pedido no encontrado');
    const o=await tx.marketOrder.findUnique({where:{id:orderId}});
    if(!o)fail(404,'Pedido no encontrado');
    if(o.driverId!==actor.id)fail(403,'Pedido no asignado');
    if(o.status==='delivered'){
      const existing=await tx.stageDeliveryProof.findUnique({where:{orderId}});
      if(!existing?.pinVerified)fail(409,'Pedido sin prueba de entrega');
      return orderId;
    }
    if(o.status!=='on_the_way')fail(409,'Primero marca el pedido como en camino');
    if(!await fixture(tx,orderId))fail(503,'Entrega fuera de contrato de staging');
    if(!/^\d{4}$/.test(o.deliveryPin)||!/^\d{4}$/.test(proof.pin)||
      !timingSafeEqual(Buffer.from(o.deliveryPin),Buffer.from(proof.pin)))
      fail(400,'PIN incorrecto');
    // Concurrency-safe exactly-once wallet points and driver metrics.
    const wallet=await tx.$queryRawUnsafe<{id:number}[]>(
      'SELECT id FROM loyalty_accounts WHERE user_id=$1 FOR UPDATE',o.userId,
    );
    if(!wallet.length)fail(503,'Cuenta de puntos no disponible');
    const account=await tx.authLoyaltyAccount.findUnique({where:{userId:o.userId}});
    if(!account)fail(503,'Cuenta de puntos no disponible');
    const profileLocks=await tx.$queryRawUnsafe<{id:number}[]>(
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
      status:'delivered',deliveredAt:now,paymentStatus:'paid',cashCollected:o.total,
    }});
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
      metadataJson:JSON.stringify({source:'delivery_pin',stage_only:true}),
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
  },{maxWait:10000,timeout:20000});
  // Consistent with Python: claim another ready order, without failing a
  // delivery that has already committed if the next claim is unavailable.
  try{await withProfileLock(actor.id,async tx=>assign(tx,actor.id));}catch{/* next assignment best effort */}
  return id;
}
