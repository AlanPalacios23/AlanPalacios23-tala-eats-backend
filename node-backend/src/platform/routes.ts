// Python platform.py E1: useful customer endpoints, isolated Node staging.
// No wallet credits, promotions, gift card or LIVE payment mutations.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { current } from '../auth/routes.js';
import { restaurantPublic } from '../marketplace/routes.js';

export const platformRouter=Router();
class PlatformError extends Error {
  constructor(public readonly code:number,message:string){super(message);}
}
const fail=(code:number,message:string):never=>{throw new PlatformError(code,message);};
async function user(req:Request, roles?:string[]){
  const {user:account}=await current(req);
  if(roles && !roles.includes(account.role))fail(403,'No tienes permisos');
  return account;
}
function idParam(req:Request,key:string):number{
  const arg=req.params[key];
  const val=Array.isArray(arg)?arg[0]:arg;
  if(!val||!/^[1-9]\d*$/.test(val)||!Number.isSafeInteger(Number(val)))
    return fail(422,'Identificador inválido');
  return Number(val);
}
function validate<T extends z.ZodTypeAny>(schema:T,raw:unknown):z.output<T>{
  const p=schema.safeParse(raw);
  if(!p.success)return fail(422,'Datos inválidos');
  return p.data;
}
const locationFields={
  lat:z.number().finite().min(-90).max(90).nullable().optional(),
  lng:z.number().finite().min(-180).max(180).nullable().optional(),
};
const createAddress=z.strictObject({
  label:z.string().max(60).default('Casa'),
  address:z.string().trim().min(5).max(300),
  ...locationFields,
  is_default:z.boolean().default(false),
});
const updateAddress=z.strictObject({
  label:z.string().max(60).optional(),
  address:z.string().trim().min(5).max(300).optional(),
  ...locationFields,
  is_default:z.boolean().optional(),
});
function addressPublic(row:{
  id:number;label:string;address:string;lat:number|null;lng:number|null;isDefault:boolean;
}){
  return {id:row.id,label:row.label,address:row.address,
    lat:row.lat,lng:row.lng,is_default:row.isDefault};
}
// Serialize per-customer defaults and favorites. The partial unique index is
// a second line of defense against accidentally duplicated defaults.
async function withUserLock<T>(id:number,fn:(tx:any)=>Promise<T>):Promise<T>{
  return db.$transaction(async tx=>{
    const locks=await tx.$queryRawUnsafe<{id:number}[]>(
      'SELECT id FROM users WHERE id=$1 FOR UPDATE',id
    );
    if(locks.length!==1)fail(401,'Cuenta no disponible');
    return fn(tx);
  },{maxWait:10000,timeout:15000});
}
platformRouter.get('/addresses',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const rows=await db.platformAddress.findMany({
    where:{userId:account.id},orderBy:[{isDefault:'desc'},{id:'asc'}],
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(rows.map(addressPublic));
});
platformRouter.post('/addresses',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const input=validate(createAddress,req.body);
  const row=await withUserLock(account.id,async tx=>{
    if(input.is_default)await tx.platformAddress.updateMany({
      where:{userId:account.id,isDefault:true},data:{isDefault:false},
    });
    return tx.platformAddress.create({data:{
      userId:account.id,label:input.label,address:input.address,
      lat:input.lat??null,lng:input.lng??null,isDefault:input.is_default,
    }});
  });
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json(addressPublic(row));
});
platformRouter.patch('/addresses/:addressId',async(req,res)=>{
  const account=await user(req); // Python update_address: all authenticated roles
  const id=idParam(req,'addressId');
  const input=validate(updateAddress,req.body);
  const changed=await withUserLock(account.id,async tx=>{
    const prior=await tx.platformAddress.findFirst({where:{id,userId:account.id}});
    if(!prior)return fail(404,'Dirección no encontrada');
    if(input.is_default===true)await tx.platformAddress.updateMany({
      where:{userId:account.id,isDefault:true},data:{isDefault:false},
    });
    return tx.platformAddress.update({where:{id},data:{
      ...(input.label!==undefined?{label:input.label}:{}),
      ...(input.address!==undefined?{address:input.address}:{}),
      ...(input.lat!==undefined?{lat:input.lat}:{}),
      ...(input.lng!==undefined?{lng:input.lng}:{}),
      ...(input.is_default!==undefined?{isDefault:input.is_default}:{}),
    }});
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(addressPublic(changed));
});
platformRouter.delete('/addresses/:addressId',async(req,res)=>{
  const account=await user(req);
  const id=idParam(req,'addressId');
  await withUserLock(account.id,async tx=>{
    const row=await tx.platformAddress.findFirst({where:{id,userId:account.id}});
    if(!row)return fail(404,'Dirección no encontrada');
    await tx.platformAddress.delete({where:{id}});
    if(row.isDefault){
      const next=await tx.platformAddress.findFirst({
        where:{userId:account.id},orderBy:{id:'asc'},
      });
      if(next)await tx.platformAddress.update({
        where:{id:next.id},data:{isDefault:true},
      });
    }
  });
  res.status(204).end();
});
platformRouter.get('/favorites',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const favorites=await db.platformFavorite.findMany({
    where:{userId:account.id},select:{restaurantId:true},orderBy:{id:'asc'},
  });
  const found=favorites.length?await db.marketplaceRestaurant.findMany({
    where:{id:{in:favorites.map(v=>v.restaurantId)},verificationStatus:{not:'archived'}},
  }):[];
  const byId=new Map(found.map(row=>[row.id,row]));
  res.setHeader('Cache-Control','private, no-store');
  res.json(favorites.flatMap(f=>{
    const row=byId.get(f.restaurantId);
    return row?[restaurantPublic(row)]:[];
  }));
});
platformRouter.post('/favorites/:restaurantId',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const restaurantId=idParam(req,'restaurantId');
  const state=await withUserLock(account.id,async tx=>{
    const restaurant=await tx.marketplaceRestaurant.findUnique({
      where:{id:restaurantId},select:{id:true},
    });
    if(!restaurant)return fail(404,'Restaurante no encontrado');
    const where={userId_restaurantId:{userId:account.id,restaurantId}};
    const prior=await tx.platformFavorite.findUnique({where});
    if(prior){
      await tx.platformFavorite.delete({where:{id:prior.id}});
      return false;
    }
    await tx.platformFavorite.create({data:{userId:account.id,restaurantId}});
    return true;
  });
  res.json({favorite:state});
});
function notificationPublic(row:{
  id:number;kind:string;title:string;message:string;isRead:boolean;createdAt:Date;
}){
  return {id:row.id,kind:row.kind,title:row.title,message:row.message,
    is_read:row.isRead,created_at:row.createdAt.toISOString()};
}
platformRouter.get('/notifications',async(req,res)=>{
  const account=await user(req);
  const rows=await db.authNotification.findMany({
    where:{userId:account.id},
    orderBy:[{createdAt:'desc'},{id:'desc'}],take:50,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(rows.map(notificationPublic));
});
platformRouter.patch('/notifications/:notificationId/read',async(req,res)=>{
  const account=await user(req);
  const id=idParam(req,'notificationId');
  const done=await db.authNotification.updateMany({
    where:{id,userId:account.id},data:{isRead:true},
  });
  if(done.count!==1)return fail(404,'Notificación no encontrada');
  const row=await db.authNotification.findUnique({where:{id}});
  if(!row)return fail(404,'Notificación no encontrada');
  res.setHeader('Cache-Control','private, no-store');
  res.json(notificationPublic(row));
});
platformRouter.post('/notifications/read-all',async(req,res)=>{
  const account=await user(req);
  const done=await db.authNotification.updateMany({
    where:{userId:account.id,isRead:false},data:{isRead:true},
  });
  res.json({updated:done.count});
});
function loyaltyPublic(a:{
  points:number;tier:string;streakDays:number;plusSavings:{toString():string};
  walletBalance:{toString():string};plusMember:boolean;referralCode:string;
}){
  return {points:a.points,tier:a.tier,streak_days:a.streakDays,
    plus_savings:a.plusSavings.toString(),wallet_balance:a.walletBalance.toString(),
    plus_member:a.plusMember,referral_code:a.referralCode};
}
platformRouter.get('/loyalty',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const loyalty=await db.authLoyaltyAccount.findUnique({where:{userId:account.id}});
  if(!loyalty)return fail(503,'Cuenta de fidelidad no disponible');
  res.setHeader('Cache-Control','private, no-store');
  res.json(loyaltyPublic(loyalty));
});
platformRouter.get('/bootstrap',async(req,res)=>{
  const account=await user(req);
  const [loyalty,unread]=await Promise.all([
    db.authLoyaltyAccount.findUnique({where:{userId:account.id}}),
    db.authNotification.count({where:{userId:account.id,isRead:false}}),
  ]);
  if(!loyalty)return fail(503,'Cuenta de fidelidad no disponible');
  const publicUser={
    id:account.id,name:account.name,email:account.email,role:account.role,
    auth_provider:account.authProvider,avatar_url:account.avatarUrl,
    phone:account.phone,is_active:account.isActive,
    two_factor_enabled:account.twoFactorEnabled,
    marketing_opt_in:account.marketingOptIn,
    analytics_opt_in:account.analyticsOptIn,
    personalization_opt_in:account.personalizationOptIn,
    birth_date:account.birthDate,
  };
  res.setHeader('Cache-Control','private, no-store');
  res.json({
    user:publicUser,
    wallet:{balance:loyalty.walletBalance.toString(),points:loyalty.points,
      plus_member:loyalty.plusMember,referral_code:loyalty.referralCode},
    unread_notifications:unread,
    support_email:config.STAGE_SUPPORT_EMAIL??'',
    online_payments:false,google_signin:false,
  });
});
// Python platform.py: public promotions/coupons (discovery only). Applying
// discounts in checkout remains disabled until monetary policy v1.6.2 parity.
platformRouter.get('/promotions',async(_req,res)=>{
  const rows=await db.platformPromotion.findMany({
    where:{active:true},orderBy:[{sponsored:'desc'},{id:'asc'}],take:200,
  });
  res.json(rows.map(x=>({
    id:x.id,restaurant_id:x.restaurantId,title:x.title,
    description:x.description,discount_percent:x.discountPercent,
    active:x.active,sponsored:x.sponsored,
  })));
});
platformRouter.get('/coupons',async(_req,res)=>{
  const rows=await db.platformCoupon.findMany({
    where:{active:true},orderBy:{id:'asc'},take:200,
  });
  res.json(rows.map(x=>({
    code:x.code,discount_type:x.discountType,value:x.value.toString(),
    min_order:x.minOrder.toString(),active:x.active,description:x.description,
  })));
});
// Python platform.py: only customer reviews of their own DELIVERED orders.
// Unique order/customer constraint plus INSERT ... ON CONFLICT DO NOTHING
// guarantees one review even when the app retries concurrently.
const reviewInput=z.object({
  order_id:z.number().int().positive().safe(),
  restaurant_rating:z.number().int().min(1).max(5),
  driver_rating:z.number().int().min(1).max(5).nullable().default(null),
  comment:z.string().max(1000).default(''),
});
platformRouter.post('/reviews',async(req,res)=>{
  const actor=await user(req,['customer']);
  const input=validate(reviewInput,req.body);
  const created=await db.$transaction(async tx=>{
    const order=await tx.marketOrder.findUnique({
      where:{id:input.order_id},select:{
        id:true,userId:true,restaurantId:true,driverId:true,status:true,
      },
    });
    // Match Python's 400 for missing, foreign or unfinished orders;
    // never reveal a different user's order existence.
    if(!order||order.userId!==actor.id||order.status!=='delivered')
      return fail(400,'Solo puedes calificar pedidos entregados propios');
    const inserted=await tx.$queryRawUnsafe<{id:number}[]>(
      'INSERT INTO reviews(order_id,user_id,restaurant_id,driver_id,'+
      'restaurant_rating,driver_rating,comment) VALUES($1,$2,$3,$4,$5,$6,$7)'+
      ' ON CONFLICT(order_id,user_id) DO NOTHING RETURNING id',
      order.id,actor.id,order.restaurantId,order.driverId,
      input.restaurant_rating,input.driver_rating,input.comment,
    );
    if(inserted.length!==1)return fail(409,'Este pedido ya fue calificado');
    const record=await tx.platformReview.findUnique({where:{id:inserted[0]!.id}});
    if(!record)return fail(503,'Reseña no disponible después de guardar');
    return record;
  },{maxWait:10000,timeout:20000});
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json({
    id:created.id,order_id:created.orderId,restaurant_id:created.restaurantId,
    restaurant_rating:created.restaurantRating,driver_rating:created.driverRating,
    comment:created.comment,created_at:created.createdAt.toISOString(),
  });
});

async function authorizeOrderChat(orderId:number,account:{
  id:number;role:string;
}){
  const order=await db.marketOrder.findUnique({
    where:{id:orderId},
    include:{restaurant:{select:{ownerId:true}}},
  });
  if(!order)return fail(404,'Pedido no encontrado');
  const allowed=account.role==='admin'||order.userId===account.id||
    order.driverId===account.id||
    (account.role==='restaurant'&&order.restaurant.ownerId===account.id);
  if(!allowed)return fail(403,'Sin acceso');
  return order;
}
const chatCreate=z.strictObject({
  message:z.string().max(1000).default(''),
  message_type:z.enum(['text','photo','location','quick']).default('text'),
  media_url:z.string().max(600).default(''),
  lat:z.number().finite().min(-90).max(90).nullable().default(null),
  lng:z.number().finite().min(-180).max(180).nullable().default(null),
});
function chatPublic(row:{
  id:number;orderId:number;senderId:number;message:string;messageType:string;
  mediaUrl:string;lat:number|null;lng:number|null;createdAt:Date;
}){
  return {id:row.id,order_id:row.orderId,sender_id:row.senderId,
    message:row.message,message_type:row.messageType,media_url:row.mediaUrl,
    lat:row.lat,lng:row.lng,created_at:row.createdAt.toISOString()};
}
platformRouter.get('/orders/:orderId/chat',async(req,res)=>{
  const account=await user(req);
  const orderId=idParam(req,'orderId');
  await authorizeOrderChat(orderId,account);
  const rows=await db.platformChatMessage.findMany({
    where:{orderId},orderBy:[{createdAt:'desc'},{id:'desc'}],take:500,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(rows.reverse().map(chatPublic));
});
platformRouter.post('/orders/:orderId/chat',async(req,res)=>{
  const account=await user(req);
  const orderId=idParam(req,'orderId');
  const p=validate(chatCreate,req.body);
  await authorizeOrderChat(orderId,account);
  // Commit message and durable outbox atomically; the publisher is intentionally
  // not running, so this does NOT claim realtime parity with Python WebSocket.
  const row=await db.$transaction(async tx=>{
    const created=await tx.platformChatMessage.create({data:{
      orderId,senderId:account.id,message:p.message,messageType:p.message_type,
      mediaUrl:p.media_url,lat:p.lat,lng:p.lng,
    }});
    await tx.stageEventOutbox.create({data:{
      eventKey:'order:'+orderId+':chat:'+created.id,
      aggregateType:'order',aggregateId:String(orderId),
      eventType:'chat.message',
      payloadJson:JSON.stringify({order_id:orderId,message_id:created.id,
        sender_id:account.id}),
    }});
    return created;
  },{maxWait:10000,timeout:20000});
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json(chatPublic(row));
});
const supportCreate=z.strictObject({
  order_id:z.number().int().positive().nullable().default(null),
  category:z.string().min(1).max(80),
  message:z.string().min(5).max(3000),
});
function supportPublic(row:{
  id:number;orderId:number|null;category:string;message:string;
  status:string;adminReply:string;respondedAt:Date|null;createdAt:Date;
}){
  return {id:row.id,order_id:row.orderId,category:row.category,
    message:row.message,status:row.status,admin_reply:row.adminReply,
    responded_at:row.respondedAt?.toISOString()??null,
    created_at:row.createdAt.toISOString()};
}
platformRouter.get('/support',async(req,res)=>{
  const account=await user(req);
  const rows=await db.platformSupportTicket.findMany({
    where:account.role==='admin'?{}:{userId:account.id},
    orderBy:[{createdAt:'desc'},{id:'desc'}],take:200,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(rows.map(supportPublic));
});
platformRouter.post('/support',async(req,res)=>{
  const account=await user(req);
  const p=validate(supportCreate,req.body);
  if(p.order_id!==null){
    const order=await db.marketOrder.findUnique({
      where:{id:p.order_id},select:{userId:true},
    });
    if(!order||(account.role!=='admin'&&order.userId!==account.id))
      return fail(404,'Pedido no encontrado');
  }
  const row=await db.platformSupportTicket.create({data:{
    userId:account.id,orderId:p.order_id,category:p.category,message:p.message,
  }});
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json(supportPublic(row));
});



// E4: Python platform.py read-only Wallet, recommendations, group orders,
// referral. No checkout credits, gift redemption, Plus charge or payouts.
function walletTransactionPublic(v:{
  id:number;kind:string;amount:{toFixed:(digits:number)=>string};
  balanceAfter:{toFixed:(digits:number)=>string};referenceType:string;
  referenceId:string;description:string;createdAt:Date;
}){
  return {id:v.id,kind:v.kind,amount:v.amount.toFixed(2),
    balance_after:v.balanceAfter.toFixed(2),
    reference_type:v.referenceType,reference_id:v.referenceId,
    description:v.description,created_at:v.createdAt.toISOString()};
}
platformRouter.get('/wallet',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const [wallet,transactions]=await db.$transaction([
    db.authLoyaltyAccount.findUnique({where:{userId:account.id}}),
    db.stageWalletTransaction.findMany({
      where:{userId:account.id},
      orderBy:[{createdAt:'desc'},{id:'desc'}],take:20,
    }),
  ]);
  if(!wallet)return fail(503,'Cuenta de fidelidad no disponible');
  res.setHeader('Cache-Control','private, no-store');
  res.json({balance:wallet.walletBalance.toFixed(2),
    points:wallet.points,plus_member:wallet.plusMember,
    referral_code:wallet.referralCode,
    transactions:transactions.map(walletTransactionPublic)});
});
platformRouter.get('/wallet/transactions',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const transactions=await db.stageWalletTransaction.findMany({
    where:{userId:account.id},
    orderBy:[{createdAt:'desc'},{id:'desc'}],take:100,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(transactions.map(walletTransactionPublic));
});
platformRouter.get('/recommendations',async(req,res)=>{
  await user(req,['customer','admin']);
  // Python reference is a rule engine: open + sponsored then rating, limit 6.
  // This is NOT a personalized LLM and does not call any external provider.
  const restaurants=await db.marketplaceRestaurant.findMany({
    where:{isOpen:true,verificationStatus:{not:'archived'}},
    orderBy:[{sponsored:'desc'},{rating:'desc'},{id:'asc'}],take:6,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json({
    engine:'rules',
    message:'Recomendaciones basadas en patrocinio, rating y disponibilidad; AI_PROVIDER puede sustituir el motor de reglas.',
    restaurants:restaurants.map(restaurantPublic),
  });
});
platformRouter.get('/groups/:groupCode',async(req,res)=>{
  const account=await user(req);
  const raw=req.params.groupCode;
  const code=(Array.isArray(raw)?raw[0]:raw)?.trim()??'';
  if(!code||code.length>12)return fail(422,'Código de grupo inválido');
  const orders=await db.marketOrder.findMany({
    where:{
      groupCode:code,
      ...(account.role==='admin'?{}:{userId:account.id}),
    },
    select:{id:true,status:true,total:true,scheduledFor:true},
    orderBy:[{createdAt:'asc'},{id:'asc'}],take:200,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(orders.map(o=>({id:o.id,status:o.status,
    total:o.total.toFixed(2),
    scheduled_for:o.scheduledFor?.toISOString()??null})));
});
platformRouter.get('/referral',async(req,res)=>{
  const account=await user(req,['customer']);
  const wallet=await db.authLoyaltyAccount.findUnique({
    where:{userId:account.id},select:{referralCode:true},
  });
  if(!wallet)return fail(503,'Cuenta de fidelidad no disponible');
  res.setHeader('Cache-Control','private, no-store');
  res.json({code:wallet.referralCode,
    reward_rule:'Código persistente listo; la política de recompensa se configura en la capa comercial.'});
});

export function platformErrors(error:unknown,_req:Request,res:Response,_next:NextFunction){
  if(error && typeof error==='object' && 'code' in error &&
    typeof (error as {code:unknown}).code==='number'){
    const e=error as {code:number,message?:string};
    res.status(e.code).json({detail:e.message??'Error'});return;
  }
  console.error('NODE_PLATFORM_STAGE_ERROR',error instanceof Error?error.name:'unknown');
  res.status(503).json({detail:'Servicios de usuario no disponibles temporalmente'});
}
