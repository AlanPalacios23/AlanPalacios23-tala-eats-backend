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
    where:{id:{in:favorites.map(v=>v.restaurantId)}},
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
export function platformErrors(error:unknown,_req:Request,res:Response,_next:NextFunction){
  if(error && typeof error==='object' && 'code' in error &&
    typeof (error as {code:unknown}).code==='number'){
    const e=error as {code:number,message?:string};
    res.status(e.code).json({detail:e.message??'Error'});return;
  }
  console.error('NODE_PLATFORM_STAGE_ERROR',error instanceof Error?error.name:'unknown');
  res.status(503).json({detail:'Servicios de usuario no disponibles temporalmente'});
}
