// E1 Python platform.py contract subset: addresses, favorites and notifications.
// Staging-only user data. No PSP, wallet, cash movement or public deployment.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { current } from '../auth/routes.js';
import { restaurantPublic } from '../marketplace/routes.js';
import type { StageCustomerAddress, AuthNotification } from '../generated/prisma/client.js';
export const platformRouter=Router();
class PlatformError extends Error{
  constructor(public readonly code:number,message:string){super(message);}
}
const fail=(code:number,message:string):never=>{throw new PlatformError(code,message);};
async function user(req:Request,roles?:string[]){
  const session=await current(req);
  if(roles&&!roles.includes(session.user.role))
    return fail(403,'No tienes permiso para esta operación');
  return session.user;
}
function posId(req:Request,name:string){
  const v=req.params[name],raw=Array.isArray(v)?v[0]:v;
  if(typeof raw!=='string'||!/^[1-9]\d*$/.test(raw)||
    !Number.isSafeInteger(Number(raw)))return fail(422,'Identificador inválido');
  return Number(raw);
}
const addressJSON=(v:StageCustomerAddress)=>({
  id:v.id,label:v.label,address:v.address,lat:v.lat,lng:v.lng,is_default:v.isDefault,
});
const notificationJSON=(v:AuthNotification)=>({
  id:v.id,kind:v.kind,title:v.title,message:v.message,
  is_read:v.isRead,created_at:v.createdAt.toISOString(),
});
const optionalLat=z.number().finite().min(-90).max(90).nullable();
const optionalLng=z.number().finite().min(-180).max(180).nullable();
const addressCreate=z.object({
  label:z.string().max(60).default('Casa'),
  address:z.string().min(5).max(300),
  lat:optionalLat.default(null),lng:optionalLng.default(null),
  is_default:z.boolean().default(false),
});
const addressPatch=z.object({
  label:z.string().max(60).optional(),
  address:z.string().min(5).max(300).optional(),
  lat:optionalLat.optional(),lng:optionalLng.optional(),
  is_default:z.boolean().optional(),
});
function parsed<T extends z.ZodTypeAny>(schema:T,raw:unknown):z.output<T>{
  const result=schema.safeParse(raw);
  if(!result.success)return fail(422,'Datos inválidos');
  return result.data;
}
platformRouter.get('/addresses',async(req,res)=>{
  const actor=await user(req,['customer','admin']);
  const rows=await db.stageCustomerAddress.findMany({
    where:{userId:actor.id},orderBy:[{isDefault:'desc'},{id:'asc'}],
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(rows.map(addressJSON));
});
platformRouter.post('/addresses',async(req,res)=>{
  const actor=await user(req,['customer','admin']);
  const input=parsed(addressCreate,req.body);
  const row=await db.$transaction(async tx=>{
    // Per-user row lock serializes multiple devices assigning a default.
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE',actor.id);
    if(input.is_default)await tx.stageCustomerAddress.updateMany({
      where:{userId:actor.id,isDefault:true},data:{isDefault:false},
    });
    return tx.stageCustomerAddress.create({data:{
      userId:actor.id,label:input.label,address:input.address,
      lat:input.lat,lng:input.lng,isDefault:input.is_default,
    }});
  },{maxWait:10000,timeout:20000});
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json(addressJSON(row));
});
platformRouter.patch('/addresses/:addressId',async(req,res)=>{
  const actor=await user(req);
  const id=posId(req,'addressId'),patch=parsed(addressPatch,req.body);
  const row=await db.$transaction(async tx=>{
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE',actor.id);
    const prior=await tx.stageCustomerAddress.findFirst({where:{id,userId:actor.id}});
    if(!prior)return fail(404,'Dirección no encontrada');
    if(patch.is_default===true)await tx.stageCustomerAddress.updateMany({
      where:{userId:actor.id,isDefault:true},data:{isDefault:false},
    });
    return tx.stageCustomerAddress.update({where:{id},data:{
      ...(patch.label!==undefined?{label:patch.label}:{}),
      ...(patch.address!==undefined?{address:patch.address}:{}),
      ...(patch.lat!==undefined?{lat:patch.lat}:{}),
      ...(patch.lng!==undefined?{lng:patch.lng}:{}),
      ...(patch.is_default!==undefined?{isDefault:patch.is_default}:{}),
    }});
  },{maxWait:10000,timeout:20000});
  res.setHeader('Cache-Control','private, no-store');
  res.json(addressJSON(row));
});
platformRouter.delete('/addresses/:addressId',async(req,res)=>{
  const actor=await user(req),id=posId(req,'addressId');
  await db.$transaction(async tx=>{
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE',actor.id);
    const prior=await tx.stageCustomerAddress.findFirst({where:{id,userId:actor.id}});
    if(!prior)return fail(404,'Dirección no encontrada');
    await tx.stageCustomerAddress.delete({where:{id}});
    if(prior.isDefault){
      const next=await tx.stageCustomerAddress.findFirst({
        where:{userId:actor.id},orderBy:{id:'asc'},
      });
      if(next)await tx.stageCustomerAddress.update({
        where:{id:next.id},data:{isDefault:true},
      });
    }
  },{maxWait:10000,timeout:20000});
  res.setHeader('Cache-Control','private, no-store');
  res.status(204).end();
});
platformRouter.get('/favorites',async(req,res)=>{
  const actor=await user(req,['customer','admin']);
  const favorites=await db.stageCustomerFavorite.findMany({
    where:{userId:actor.id},include:{restaurant:true},orderBy:{id:'asc'},
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(favorites.map(x=>restaurantPublic(x.restaurant)));
});
platformRouter.post('/favorites/:restaurantId',async(req,res)=>{
  const actor=await user(req,['customer','admin']);
  const restaurantId=posId(req,'restaurantId');
  const favorite=await db.$transaction(async tx=>{
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE',actor.id);
    const restaurant=await tx.marketplaceRestaurant.findUnique({
      where:{id:restaurantId},select:{id:true},
    });
    if(!restaurant)return fail(404,'Restaurante no encontrado');
    const old=await tx.stageCustomerFavorite.findUnique({
      where:{userId_restaurantId:{userId:actor.id,restaurantId}},
    });
    if(old){
      await tx.stageCustomerFavorite.delete({where:{id:old.id}});
      return false;
    }
    await tx.stageCustomerFavorite.create({data:{userId:actor.id,restaurantId}});
    return true;
  },{maxWait:10000,timeout:20000});
  res.setHeader('Cache-Control','private, no-store');
  res.json({favorite});
});
platformRouter.get('/notifications',async(req,res)=>{
  const actor=await user(req);
  const rows=await db.authNotification.findMany({
    where:{userId:actor.id},orderBy:[{createdAt:'desc'},{id:'desc'}],take:50,
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(rows.map(notificationJSON));
});
platformRouter.patch('/notifications/:notificationId/read',async(req,res)=>{
  const actor=await user(req),id=posId(req,'notificationId');
  const updated=await db.authNotification.updateMany({
    where:{id,userId:actor.id},data:{isRead:true},
  });
  if(!updated.count)return fail(404,'Notificación no encontrada');
  const record=await db.authNotification.findFirst({where:{id,userId:actor.id}});
  if(!record)return fail(404,'Notificación no encontrada');
  res.setHeader('Cache-Control','private, no-store');
  res.json(notificationJSON(record));
});
platformRouter.post('/notifications/read-all',async(req,res)=>{
  const actor=await user(req);
  const changed=await db.authNotification.updateMany({
    where:{userId:actor.id,isRead:false},data:{isRead:true},
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json({updated:changed.count});
});
export function platformErrors(error:unknown,_req:Request,res:Response,_next:NextFunction){
  if(error&&typeof error==='object'&&'code' in error&&
    typeof (error as {code:unknown}).code==='number'){
    const e=error as {code:number,message?:string};
    res.status(e.code).json({detail:e.message??'Error'});
    return;
  }
  console.error('NODE_PLATFORM_STAGE_ERROR',error instanceof Error?error.name:'unknown');
  res.status(503).json({detail:'Servicios del cliente temporalmente no disponibles'});
}
