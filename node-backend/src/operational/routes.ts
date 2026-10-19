// Functional read-only v6 operations and ADMIN parity against synthetic PG15.
// Python: backend/app/routes/operations.py and admin.py. NO real settlements.
import { createHash } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { current } from '../auth/routes.js';
export const operationsRouter=Router();
export const adminRouter=Router();
export class OpsError extends Error {
 constructor(public readonly code:number,message:string){super(message);}
}
export const bad=(code:number,message:string):never=>{throw new OpsError(code,message);};
export async function account(req:Request,roles?:string[]){
 const {user}=await current(req);
 if(roles&&!roles.includes(user.role))return bad(403,'Sin acceso');
 return user;
}
export const param=(req:Request,name:string):number=>{
 const p=req.params[name],s=Array.isArray(p)?p[0]:p;
 if(!s||!/^[1-9][0-9]*$/.test(s)||!Number.isSafeInteger(Number(s)))
  return bad(422,'Identificador inválido');
 return Number(s);
};
const query=(req:Request,name:string,defaultValue:number,min:number,max:number)=>{
 const raw=req.query[name];
 if(raw===undefined)return defaultValue;
 if(typeof raw!=='string'||!/^(0|[1-9]\d*)$/.test(raw)||
  Number(raw)<min||Number(raw)>max)return bad(422,'Parámetro inválido');
 return Number(raw);
};
const money=(v:{toFixed:(n:number)=>string})=>v.toFixed(2);
const statCurrencies=[
 'total','subtotal','platformCommission','serviceFee','deliveryFee',
 'driverEarning','restaurantPayout','paymentProcessingFee','promotionSubsidy',
 'platformRevenue','contributionMargin'] as const;
const cents=(v:{toString():string})=>{
 const [a,b='']=v.toString().split('.');
 return BigInt(a!)*100n+BigInt((b+'00').slice(0,2));
};
const cash=(n:bigint)=>((n<0n?'-':'')+(n<0n?-n:n)/100n+'.'+String((n<0n?-n:n)%100n).padStart(2,'0'));
const ACTIVE=['received','confirmed','preparing','ready','assigned','picked_up','on_the_way'];
const userFields=(u:{
 id:number;name:string;email:string;role:string;authProvider:string;avatarUrl:string|null;
 phone:string;isActive:boolean;twoFactorEnabled:boolean;marketingOptIn:boolean;
 analyticsOptIn:boolean;personalizationOptIn:boolean;birthDate:string;
})=>({id:u.id,name:u.name,email:u.email,role:u.role,auth_provider:u.authProvider,
 avatar_url:u.avatarUrl,phone:u.phone,is_active:u.isActive,
 two_factor_enabled:u.twoFactorEnabled,marketing_opt_in:u.marketingOptIn,
 analytics_opt_in:u.analyticsOptIn,personalization_opt_in:u.personalizationOptIn,
 birth_date:u.birthDate});
const jsonOrder=(o:any)=>{
 const permit=[
 'id','userId','restaurantId','driverId','status','paymentMethod','paymentStatus',
 'subtotal','deliveryFee','discount','tip','total','platformCommission','serviceFee',
 'paymentProcessingFee','refundedAmount','promotionSubsidy','platformRevenue',
 'contributionMargin','cashCollected','cancellationFee','restaurantPayout',
 'driverEarning','paymentProvider','paymentProviderId','paymentPreferenceId',
 'address','notes','orderType','scheduledFor','couponCode','groupCode',
 'recipientName','recipientPhone','giftMessage','corporateAccountId','distanceKm',
 'deliveryLat','deliveryLng','estimatedMinutes','invoiceRequested','invoiceTaxId',
 'clientReference','createdAt','updatedAt','acceptedAt','preparingAt','readyAt',
 'pickedUpAt','deliveredAt'];
 const result:Record<string,unknown>={};
 for(const key of permit){
  const val=o[key];
  const snake=key.replace(/[A-Z]/g,(c:string)=>'_'+c.toLowerCase());
  result[snake]=val instanceof Date?val.toISOString():val!==null&&
   typeof val==='object'&&typeof val.toFixed==='function'?val.toFixed(2):val;
 }
 result.items=(o.items??[]).map((i:any)=>({
   id:i.id,menu_item_id:i.menuItemId,name_snapshot:i.nameSnapshot,
   quantity:i.quantity,unit_price:i.unitPrice.toFixed(2),
   options_snapshot:i.optionsSnapshot,
 }));
 result.driver_info=o.driver?{
   id:o.driver.id,name:o.driver.name,phone:o.driver.phone,
   vehicle:o.driver.driverProfile?.vehicle??'',
   rating:o.driver.driverProfile?.rating.toFixed(2)??'5.00',
 }:null;
 return result;
};
const zonePublic=(q:any)=>({
 id:q.id,name:q.name,center_lat:q.centerLat,center_lng:q.centerLng,
 radius_km:q.radiusKm,surcharge:money(q.surcharge),min_order:money(q.minOrder),active:q.active,
});
const flagPublic=(q:any)=>({
 id:q.id,key:q.key,description:q.description,enabled:q.enabled,
 rollout_percent:q.rolloutPercent,audience_role:q.audienceRole,
 updated_at:q.updatedAt.toISOString(),
});
function haversine(a:number,b:number,c:number,d:number){
 const rad=Math.PI/180,p=(c-a)*rad,g=(d-b)*rad;
 const x=Math.sin(p/2)**2+Math.cos(a*rad)*Math.cos(c*rad)*Math.sin(g/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
operationsRouter.get('/zones',async(_req,res)=>{
 const rows=await db.opsServiceZone.findMany({where:{active:true},orderBy:{name:'asc'}});
 res.json(rows.map(zonePublic));
});
operationsRouter.get('/coverage',async(req,res)=>{
 const a=z.coerce.number().min(-90).max(90).safeParse(req.query.lat);
 const b=z.coerce.number().min(-180).max(180).safeParse(req.query.lng);
 if(!a.success||!b.success||req.query.lat===undefined||req.query.lng===undefined)
  return bad(422,'Coordenadas inválidas');
 const rows=await db.opsServiceZone.findMany({where:{active:true}});
 const matches=rows.flatMap(x=>{
  const d=haversine(a.data,b.data,x.centerLat,x.centerLng);
  return d<=x.radiusKm?[{id:x.id,name:x.name,distance_to_center_km:Math.round(d*100)/100,
   surcharge:money(x.surcharge),min_order:money(x.minOrder)}]:[];
 });
 res.json({covered:matches.length>0,zones:matches});
});
operationsRouter.get('/flags',async(req,res)=>{
 const who=await account(req);
 const rows=await db.opsFeatureFlag.findMany({where:{enabled:true}});
 const selected=rows.filter(flag=>{
  if(flag.audienceRole!=='all'&&flag.audienceRole!==who.role)return false;
  const digest=awaitHash(flag.key+':'+who.id);
  return digest%100<flag.rolloutPercent;
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json(selected.map(flagPublic));
});
function awaitHash(v:string):number{
 return Number.parseInt(createHash('sha256').update(v).digest('hex').slice(0,8),16);
}
operationsRouter.get('/admin/flags',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.opsFeatureFlag.findMany({orderBy:{key:'asc'}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(flagPublic));
});
operationsRouter.get('/admin/settings',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.stageSystemSetting.findMany({orderBy:{key:'asc'}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(r=>({id:r.id,key:r.key,value:r.value,value_type:r.valueType,
 description:r.description,updated_by_user_id:r.updatedByUserId,
 updated_at:r.updatedAt.toISOString()})));
});
operationsRouter.get('/admin/command-center',async(req,res)=>{
 await account(req,['admin']);
 const now=new Date(),today=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
 const cutoff=new Date(now.getTime()-20*60000);
 const [active,unassigned,delayed,delivered,openRest,onlineDrivers,incidents,support]=await Promise.all([
  db.marketOrder.count({where:{status:{in:ACTIVE}}}),
  db.marketOrder.count({where:{status:'ready',driverId:null}}),
  db.marketOrder.findMany({where:{status:{in:ACTIVE},updatedAt:{lt:cutoff}},select:{id:true,status:true,updatedAt:true},orderBy:{updatedAt:'asc'}}),
  db.marketOrder.findMany({where:{status:'delivered',updatedAt:{gte:today}},select:{total:true,platformRevenue:true,contributionMargin:true}}),
  db.marketplaceRestaurant.count({where:{isOpen:true}}),
  db.marketplaceDriverProfile.count({where:{isOnline:true}}),
  db.opsIncident.count({where:{status:'open'}}),
  db.platformSupportTicket.count({where:{status:'open'}}),
 ]);
 const sum=(key:'total'|'platformRevenue'|'contributionMargin')=>cash(delivered.reduce((p,q)=>p+cents(q[key]),0n));
 res.setHeader('Cache-Control','private, no-store');
 res.json({timestamp:now.toISOString(),
  live:{active_orders:active,open_restaurants:openRest,online_drivers:onlineDrivers,
   delayed_orders:delayed.length,unassigned_ready:unassigned,
   open_incidents:incidents,open_support:support},
  today:{gmv:sum('total'),platform_revenue:sum('platformRevenue'),
   contribution_margin:sum('contributionMargin'),delivered_orders:delivered.length},
  alerts:delayed.slice(0,20).map(o=>({order_id:o.id,status:o.status,
   minutes_since_update:Math.floor((now.getTime()-o.updatedAt.getTime())/60000)}))});
});
operationsRouter.get('/admin/finance/summary',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.marketOrder.findMany({
  where:{status:'delivered'},select:{
   total:true,subtotal:true,platformCommission:true,serviceFee:true,deliveryFee:true,
   driverEarning:true,restaurantPayout:true,paymentProcessingFee:true,
   promotionSubsidy:true,platformRevenue:true,contributionMargin:true,
  },
 });
 const sum=(key:typeof statCurrencies[number])=>cash(rows.reduce((v,x)=>v+cents(x[key]),0n));
 res.setHeader('Cache-Control','private, no-store');
 res.json({gmv:sum('total'),food_subtotal:sum('subtotal'),
  platform_commission:sum('platformCommission'),service_fees:sum('serviceFee'),
  delivery_fees:sum('deliveryFee'),driver_payables:sum('driverEarning'),
  restaurant_payables:sum('restaurantPayout'),processing_cost:sum('paymentProcessingFee'),
  promotion_subsidy:sum('promotionSubsidy'),platform_revenue:sum('platformRevenue'),
  contribution_margin:sum('contributionMargin'),orders:rows.length});
});
operationsRouter.get('/admin/finance/orders/:orderId',async(req,res)=>{
 await account(req,['admin']);
 const id=param(req,'orderId'),o=await db.marketOrder.findUnique({where:{id}});
 if(!o)return bad(404,'Pedido no encontrado');
 const output:Record<string,number|string>={order_id:o.id};
 const fields={subtotal:'subtotal',discount:'discount',service_fee:'serviceFee',
  delivery_fee:'deliveryFee',tip:'tip',total:'total',
  restaurant_payout:'restaurantPayout',driver_earning:'driverEarning',
  commission:'platformCommission',processing_fee:'paymentProcessingFee',
  promotion_subsidy:'promotionSubsidy',platform_revenue:'platformRevenue',
  contribution_margin:'contributionMargin',cash_collected:'cashCollected',
  cancellation_fee:'cancellationFee'} as const;
 for(const [key,field] of Object.entries(fields))
  output[key]=o[field as keyof typeof o] && (o[field as keyof typeof o] as {toFixed:(n:number)=>string}).toFixed(2);
 res.setHeader('Cache-Control','private, no-store');
 res.json(output);
});
operationsRouter.get('/admin/ledger',async(req,res)=>{
 await account(req,['admin']);
 const limit=query(req,'limit',200,1,500);
 const rows=await db.stageFinancialLedgerEntry.findMany({
  orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,order_id:x.orderId,restaurant_id:x.restaurantId,
  user_id:x.userId,account:x.account,direction:x.direction,
  amount:money(x.amount),kind:x.kind,description:x.description,
  created_at:x.createdAt.toISOString()})));
});
adminRouter.get('/stats',async(req,res)=>{
 await account(req,['admin']);
 const [users,customers,restaurants,drivers,online,items,orders,active,uncancelled,support,
  fraud,plus]=await Promise.all([
  db.authUser.count(),db.authUser.count({where:{role:'customer'}}),
  db.marketplaceRestaurant.count(),db.authUser.count({where:{role:'driver'}}),
  db.marketplaceDriverProfile.count({where:{isOnline:true}}),
  db.marketplaceMenuItem.count(),db.marketOrder.count(),
  db.marketOrder.count({where:{status:{in:ACTIVE}}}),
  db.marketOrder.findMany({where:{status:{not:'cancelled'}},
   select:{total:true,platformCommission:true}}),
  db.platformSupportTicket.count({where:{status:'open'}}),
  db.opsFraudFlag.count({where:{resolved:false}}),
  db.authLoyaltyAccount.count({where:{plusMember:true}}),
 ]);
 res.setHeader('Cache-Control','private, no-store');
 res.json({users,customers,restaurants,drivers,online_drivers:online,
  menu_items:items,orders,active_orders:active,
  gross_sales:cash(uncancelled.reduce((p,x)=>p+cents(x.total),0n)),
  commissions:cash(uncancelled.reduce((p,x)=>p+cents(x.platformCommission),0n)),
  support_open:support,fraud_flags:fraud,plus_members:plus});
});
adminRouter.get('/users',async(req,res)=>{
 await account(req,['admin']);
 const limit=query(req,'limit',100,1,200),offset=query(req,'offset',0,0,1_000_000);
 const users=await db.authUser.findMany({
  orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,skip:offset,
 });
 res.setHeader('Cache-Control','private, no-store');res.json(users.map(userFields));
});
adminRouter.get('/orders',async(req,res)=>{
 await account(req,['admin']);
 const limit=query(req,'limit',100,1,250),offset=query(req,'offset',0,0,1_000_000);
 const orders=await db.marketOrder.findMany({
  include:{items:true,driver:{include:{driverProfile:true}}},
  orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,skip:offset,
 });
 res.setHeader('Cache-Control','private, no-store');res.json(orders.map(jsonOrder));
});
adminRouter.get('/fraud',async(req,res)=>{
 await account(req,['admin']);
 const limit=query(req,'limit',100,1,250);
 const x=await db.opsFraudFlag.findMany({take:limit,orderBy:{createdAt:'desc'}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(x.map(q=>({id:q.id,user_id:q.userId,order_id:q.orderId,reason:q.reason,
  severity:q.severity,resolved:q.resolved})));
});
adminRouter.get('/verifications',async(req,res)=>{
 await account(req,['admin']);
 const limit=query(req,'limit',100,1,250);
 const x=await db.opsVerificationRecord.findMany({take:limit,orderBy:{id:'asc'}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(x.map(q=>({id:q.id,entity_type:q.entityType,entity_id:q.entityId,
  status:q.status,notes:q.notes})));
});
adminRouter.get('/wallet/:userId',async(req,res)=>{
 await account(req,['admin']);
 const id=param(req,'userId'),who=await db.authUser.findUnique({where:{id}});
 if(!who)return bad(404,'Usuario no encontrado');
 const [loyalty,history]=await Promise.all([
  db.authLoyaltyAccount.findUnique({where:{userId:id}}),
  db.stageWalletTransaction.findMany({
   where:{userId:id},orderBy:[{createdAt:'desc'},{id:'desc'}],take:50,
  }),
 ]);
 if(!loyalty)return bad(503,'Cuenta Wallet no disponible');
 res.setHeader('Cache-Control','private, no-store');
 res.json({balance:money(loyalty.walletBalance),points:loyalty.points,
  plus_member:loyalty.plusMember,referral_code:loyalty.referralCode,
  transactions:history.map(x=>({id:x.id,kind:x.kind,amount:money(x.amount),
   balance_after:money(x.balanceAfter),reference_type:x.referenceType,
   reference_id:x.referenceId,description:x.description,
   created_at:x.createdAt.toISOString()}))});
});
export function opsErrors(err:unknown,_req:Request,res:Response,next:NextFunction){
 if(err instanceof OpsError){res.status(err.code).json({detail:err.message});return;}
 next(err);
}
