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
 const {user,mfaVerified}=await current(req);
 if(roles&&!roles.includes(user.role))return bad(403,'Sin acceso');
 // Protected ADMIN operations require an enrolled TOTP on the SERVER.
 // Authenticated enrollment remains possible via v9 setup/confirm only.
 const route=req.originalUrl.split('?')[0];
 const mfaEnrollment=route==='/api/v1/v9/security/2fa/setup'||
  route==='/api/v1/v9/security/2fa/confirm';
 if(user.role==='admin'&&roles?.includes('admin')&&!mfaEnrollment){
  if(!user.twoFactorEnabled)
    return bad(403,'Activa 2FA para acceder a funciones ADMIN');
  if(!mfaVerified)
    return bad(403,'Vuelve a iniciar sesión con tu código 2FA para administrar');
 }
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
  db.platformSupportTicket.count({where:{status:{in:['open','in_progress']}}}),
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
  output[key]=(o[field as keyof typeof o] as {toFixed:(n:number)=>string}).toFixed(2);
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
  db.platformSupportTicket.count({where:{status:{in:['open','in_progress']}}}),
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

// G1 operational write/list parity. All DB mutations target CI/stage private
// containers; payout generation, real refunds and LIVE billing are not mounted.
const payload=<T extends z.ZodTypeAny>(s:T,b:unknown):z.output<T>=>{
 const result=s.safeParse(b);
 if(!result.success)return bad(422,'Datos inválidos');
 return result.data;
};
const centsDecimal=z.union([z.string(),z.number()]).transform(String)
 .refine(v=>/^\d{1,8}(?:\.\d{1,2})?$/.test(v));
const boardUser=async(who:number,fn:(tx:any)=>Promise<any>)=>db.$transaction(async tx=>{
 const rows=await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE',who);
 if(!Array.isArray(rows)||!rows.length)return bad(404,'Cuenta no disponible');
 return fn(tx);
},{maxWait:10000,timeout:20000});
const stageSafe=(key:string)=>key.startsWith('stage.')||key==='v11.canary_percent';
const onboardPublic=(o:any)=>({id:o.id,user_id:o.userId,entity_type:o.entityType,
 business_name:o.businessName,tax_id:o.taxId,vehicle:o.vehicle,
 plate:o.plate,
 payout_account_ref:o.payoutAccountRef,status:o.status,notes:o.notes,
 created_at:o.createdAt.toISOString(),updated_at:o.updatedAt.toISOString()});
const onboardingSchema=z.strictObject({
 entity_type:z.enum(['restaurant','driver']),
 business_name:z.string().max(160).default(''),
 tax_id:z.string().max(60).default(''),
 vehicle:z.string().max(100).default(''),
 plate:z.string().trim().max(30).regex(/^[A-Za-z0-9 -]*$/,'Formato de placas inválido').default(''),
 payout_account_ref:z.string().max(180).default(''),
 documents:z.array(z.string().max(250)).max(15).default([]),
});
// Public, read-only compatibility handshake: an older LIVE backend must
// never silently discard registration plates from the new Driver PWA.
operationsRouter.get('/onboarding-capabilities',(_req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.json({driver_plate_supported:true,driver_documents_supported:true,
   driver_admin_approval_required:true});
});
operationsRouter.post('/onboarding',async(req,res)=>{
 const who=await account(req);
 const p=payload(onboardingSchema,req.body);
 // Only attach an exact private onboarding upload belonging to this account.
 // Match Python's /api/v1/uploads/onboarding-document/u<ID>-<random>.<ext>.
 const prefix='/api/v1/uploads/onboarding-document/';
 const fileNames:string[]=[];
 for(const url of p.documents){
  const fileName=url.startsWith(prefix)?url.slice(prefix.length):'';
  const matched=/^u([1-9][0-9]*)-[A-Za-z0-9_-]{32}[.](jpg|png|webp|pdf)$/.exec(fileName);
  if(!matched||Number(matched[1])!==who.id)
   return bad(403,'Documento ajeno o referencia no permitida');
  fileNames.push(fileName);
 }
 if(new Set(fileNames).size!==fileNames.length)
  return bad(422,'Lista de documentos duplicados');
 if(fileNames.length){
  const ownedAssets=await db.stageMediaAsset.findMany({
   where:{filename:{in:fileNames},category:'onboarding',userId:who.id},
   select:{filename:true},
  });
  if(ownedAssets.length!==fileNames.length)
   return bad(403,'Documento de alta inexistente o ajeno');
 }
 const result=await boardUser(who.id,async tx=>{
  const old=await tx.opsOnboarding.findFirst({where:{
   userId:who.id,entityType:p.entity_type,
   status:{in:['pending','needs_info','approved']},
  },orderBy:{createdAt:'desc'}});
  if(old?.status==='approved')return bad(409,'Solicitud aprobada previamente');
  // Plate belongs to the pending admin-reviewed application; never create
  // a verified driver profile just because a public account submitted it.
  const data={businessName:p.business_name,taxId:p.tax_id,vehicle:p.vehicle,
   plate:p.entity_type==='driver'?p.plate.toUpperCase():'',
   payoutAccountRef:p.payout_account_ref,documentsJson:JSON.stringify(p.documents),
   status:'pending'};
  const row=old?await tx.opsOnboarding.update({where:{id:old.id},data}):
   await tx.opsOnboarding.create({data:{...data,userId:who.id,entityType:p.entity_type}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'onboarding.submit',
   entityType:p.entity_type,entityId:String(row.id),
   detail:'Submission pending administrative review'}});
  return row;
 });
 res.setHeader('Cache-Control','private, no-store');
 res.status(201).json(onboardPublic(result));
});
operationsRouter.get('/onboarding/mine',async(req,res)=>{
 const who=await account(req);
 const rows=await db.opsOnboarding.findMany({where:{userId:who.id},
  orderBy:{createdAt:'desc'},take:200});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(onboardPublic));
});
operationsRouter.get('/admin/onboarding',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.opsOnboarding.findMany({orderBy:{createdAt:'desc'},take:500});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(onboardPublic));
});
operationsRouter.patch('/admin/onboarding/:applicationId',async(req,res)=>{
 const admin=await account(req,['admin']);
 const id=param(req,'applicationId');
 const p=payload(z.strictObject({status:z.enum(['approved','rejected','needs_info','suspended']),
  notes:z.string().max(2000).default('')}),req.body);
 const row=await db.$transaction(async tx=>{
  const locks=await tx.$queryRawUnsafe(
   'SELECT id FROM onboarding_applications WHERE id=$1 FOR UPDATE',id);
  if(!Array.isArray(locks)||!locks.length)return bad(404,'Solicitud no encontrada');
  const old=await tx.opsOnboarding.findUnique({where:{id}});
  if(!old)return bad(404,'Solicitud no encontrada');
  const account=await tx.authUser.findUnique({where:{id:old.userId}});
  if(!account)return bad(404,'Cuenta de solicitante no encontrada');
  if(p.status==='approved'){
   if(old.entityType==='driver'){
    await tx.marketplaceDriverProfile.upsert({
     where:{userId:account.id},
     create:{userId:account.id,vehicle:old.vehicle||'Motocicleta',plate:old.plate,isVerified:true},
     update:{vehicle:old.vehicle||'Motocicleta',plate:old.plate,isVerified:true}});
   }else{
    const existing=await tx.marketplaceRestaurant.findFirst({where:{ownerId:account.id}});
    if(existing?.verificationStatus==='archived')
     return bad(409,'Comercio archivado: requiere revisión administrativa');
    if(!existing)await tx.marketplaceRestaurant.create({data:{
     ownerId:account.id,name:old.businessName||'Restaurante de '+account.name,
     taxId:old.taxId,isOpen:false,onboardingStatus:'approved',
     verificationStatus:'verified'}});
    else await tx.marketplaceRestaurant.update({where:{id:existing.id},
     data:{onboardingStatus:'approved',verificationStatus:'verified',
      taxId:old.taxId||existing.taxId}});
   }
   await tx.authUser.update({where:{id:account.id},data:{
    role:old.entityType==='driver'?'driver':'restaurant'}});
   // Password/session refresh required: role change invalidates existing JWT.
  }else{
   // A negative onboarding decision must revoke the previously granted
   // marketplace capability as part of the SAME transaction. Leaving an old
   // verified restaurant or driver active creates a business authorization gap.
   if(old.entityType==='restaurant'){
    const status=p.status==='needs_info'?'pending':p.status;
    await tx.marketplaceRestaurant.updateMany({
     where:{ownerId:account.id,verificationStatus:{not:'archived'}},
     data:{verificationStatus:status,isOpen:false,sponsored:false,
      ...(status==='suspended'?{pickupEnabled:false}:{})},
    });
   }else{
    await tx.marketplaceDriverProfile.updateMany({
     where:{userId:account.id},data:{isVerified:false,isOnline:false},
    });
   }
  }
  const changed=await tx.opsOnboarding.update({where:{id},
   data:{status:p.status,notes:p.notes}});
  await tx.authAuditEvent.create({data:{userId:admin.id,
   action:'onboarding.decision',entityType:old.entityType,
   entityId:String(id),detail:p.status}});
  return changed;
 },{maxWait:10000,timeout:20000});
 res.setHeader('Cache-Control','private, no-store');res.json(onboardPublic(row));
});
operationsRouter.post('/admin/zones',async(req,res)=>{
 const who=await account(req,['admin']);
 const p=payload(z.strictObject({
  name:z.string().trim().min(2).max(120),
  center_lat:z.number().finite().min(-90).max(90),
  center_lng:z.number().finite().min(-180).max(180),
  radius_km:z.number().finite().gt(0).max(150),
  surcharge:centsDecimal.default('0'),min_order:centsDecimal.default('0'),
  active:z.boolean().default(true),
 }),req.body);
 const row=await db.$transaction(async tx=>{
  const old=await tx.opsServiceZone.findUnique({where:{name:p.name}});
  if(old)return bad(409,'Ya existe una zona con ese nombre');
  const created=await tx.opsServiceZone.create({data:{name:p.name,centerLat:p.center_lat,
   centerLng:p.center_lng,radiusKm:p.radius_km,surcharge:p.surcharge,
   minOrder:p.min_order,active:p.active}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'zone.create',
   entityType:'service_zone',entityId:String(created.id),detail:p.name}});
  return created;
 });
 res.status(201).json(zonePublic(row));
});
operationsRouter.put('/admin/settings',async(req,res)=>{
 const who=await account(req,['admin']);
 const p=payload(z.strictObject({
  key:z.string().regex(/^[a-z0-9_.-]{2,100}$/),
  value:z.string().max(500),value_type:z.enum(['string','decimal','integer','boolean']).default('string'),
  description:z.string().max(300).default('')}),req.body);
 if(!stageSafe(p.key))return bad(403,'Configuración productiva fuera del laboratorio');
 const row=await db.$transaction(async tx=>{
  const updated=await tx.stageSystemSetting.upsert({where:{key:p.key},
   create:{key:p.key,value:p.value,valueType:p.value_type,
    description:p.description,updatedByUserId:who.id},
   update:{value:p.value,valueType:p.value_type,
    description:p.description,updatedByUserId:who.id}});
  await tx.authAuditEvent.create({data:{userId:who.id,
   action:'setting.write',entityType:'setting',entityId:p.key,detail:p.value}});
  return updated;
 });
 res.json({id:row.id,key:row.key,value:row.value,value_type:row.valueType,
  description:row.description,updated_by_user_id:row.updatedByUserId,
  updated_at:row.updatedAt.toISOString()});
});
operationsRouter.put('/admin/flags',async(req,res)=>{
 const who=await account(req,['admin']);
 const p=payload(z.strictObject({
  key:z.string().regex(/^[a-z0-9_.-]{2,100}$/),
  description:z.string().max(300).default(''),
  enabled:z.boolean().default(false),rollout_percent:z.number().int().min(0).max(100).default(100),
  audience_role:z.enum(['all','customer','restaurant','driver','admin']).default('all'),
 }),req.body);
 // Never enable payment, payout, auth or other privileged feature via the
 // Python-compatibility flag table. Staging experimental keys only.
 if(!p.key.startsWith('stage.'))return bad(403,'Sólo banderas stage.*');
 const row=await db.$transaction(async tx=>{
  const updated=await tx.opsFeatureFlag.upsert({where:{key:p.key},
   create:{key:p.key,description:p.description,enabled:p.enabled,
    rolloutPercent:p.rollout_percent,audienceRole:p.audience_role},
   update:{description:p.description,enabled:p.enabled,
    rolloutPercent:p.rollout_percent,audienceRole:p.audience_role}});
  await tx.authAuditEvent.create({data:{userId:who.id,
   action:'feature_flag.write',entityType:'feature_flag',entityId:p.key,
   detail:String(p.enabled)}});
  return updated;
 });
 res.json(flagPublic(row));
});
const disputePublic=(o:any)=>({
 id:o.id,order_id:o.orderId,opened_by_user_id:o.openedByUserId,
 category:o.category,description:o.description,status:o.status,
 resolution:o.resolution,refund_amount:money(o.refundAmount),
 assigned_to_user_id:o.assignedToUserId,
 created_at:o.createdAt.toISOString(),resolved_at:o.resolvedAt?.toISOString()??null});
operationsRouter.post('/disputes',async(req,res)=>{
 const who=await account(req);
 const p=payload(z.strictObject({order_id:z.number().int().positive(),
  category:z.string().min(3).max(80),
  description:z.string().min(5).max(3000)}),req.body);
 const order=await db.marketOrder.findUnique({
  where:{id:p.order_id},include:{restaurant:true}});
 if(!order)return bad(404,'Pedido no encontrado');
 if(who.role!=='admin'&&order.userId!==who.id&&order.driverId!==who.id&&
  !(who.role==='restaurant'&&order.restaurant.ownerId===who.id))
  return bad(403,'Sin acceso a ese pedido');
 const row=await db.$transaction(async tx=>{
  const created=await tx.opsDispute.create({data:{orderId:order.id,
   openedByUserId:who.id,category:p.category,description:p.description}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'dispute.open',
   entityType:'order',entityId:String(order.id),detail:p.category}});
  return created;
 });
 res.status(201).json(disputePublic(row));
});
operationsRouter.get('/disputes',async(req,res)=>{
 const who=await account(req);
 const rows=await db.opsDispute.findMany({
  where:who.role==='admin'?{}:{openedByUserId:who.id},
  orderBy:{createdAt:'desc'},take:300});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(disputePublic));
});
operationsRouter.patch('/admin/disputes/:disputeId',async(req,res)=>{
 const who=await account(req,['admin']);
 const p=payload(z.strictObject({
  status:z.enum(['resolved','rejected','needs_info']),
  resolution:z.string().min(3).max(3000),
  refund_amount:centsDecimal.default('0')}),req.body);
 // Prevent a "resolved" request from creating phantom Wallet balances.
 if(Number(p.refund_amount)>0)return bad(503,'Reembolso pendiente de ledger transaccional TEST');
 const id=param(req,'disputeId');
 const row=await db.$transaction(async tx=>{
  const exist=await tx.opsDispute.findUnique({where:{id}});
  if(!exist)return bad(404,'Disputa no encontrada');
  const done=await tx.opsDispute.update({where:{id},
   data:{status:p.status,resolution:p.resolution,refundAmount:'0',
    assignedToUserId:who.id,resolvedAt:p.status==='needs_info'?null:new Date()}});
  await tx.authAuditEvent.create({data:{userId:who.id,
   action:'dispute.resolve',entityType:'dispute',entityId:String(id),
   detail:p.status}});
  return done;
 });
 res.json(disputePublic(row));
});
const campaignPublic=(c:any)=>({id:c.id,restaurant_id:c.restaurantId,
 name:c.name,daily_budget:money(c.dailyBudget),spent:money(c.spent),
 impressions:c.impressions,clicks:c.clicks,attributed_orders:c.attributedOrders,
 active:c.active,starts_at:c.startsAt.toISOString(),
 ends_at:c.endsAt?.toISOString()??null});
async function ownedShop(who:{id:number;role:string}){
 const shop=await db.marketplaceRestaurant.findFirst({where:{ownerId:who.id}});
 if(!shop)return bad(404,'No tienes un restaurante asignado');
 return shop;
}
operationsRouter.get('/owner/campaigns',async(req,res)=>{
 const who=await account(req,['restaurant','admin']);
 const shop=await ownedShop(who);
 const rows=await db.opsSponsoredCampaign.findMany({
  where:{restaurantId:shop.id},orderBy:{startsAt:'desc'},take:200});
 res.json(rows.map(campaignPublic));
});
operationsRouter.post('/owner/campaigns',async(req,res)=>{
 const who=await account(req,['restaurant','admin']);
 const shop=await ownedShop(who);
 const p=payload(z.strictObject({restaurant_id:z.number().int().positive(),
  name:z.string().min(2).max(150),daily_budget:centsDecimal,
  active:z.boolean().default(true)}),req.body);
 if(p.restaurant_id!==shop.id)return bad(403,'Sólo puedes anunciar tu restaurante');
 if(Number(p.daily_budget)<=0||Number(p.daily_budget)>100000)return bad(422,'Presupuesto inválido');
 const row=await db.$transaction(async tx=>{
  const created=await tx.opsSponsoredCampaign.create({data:{
   restaurantId:shop.id,name:p.name,dailyBudget:p.daily_budget,
   active:p.active}});
  await tx.authAuditEvent.create({data:{userId:who.id,
   action:'ads.campaign.create',entityType:'restaurant',entityId:String(shop.id),
   detail:'Campaign pending ad-delivery engine'}});
  return created;
 });
 res.status(201).json(campaignPublic(row));
});
const scenario=z.strictObject({scenario:z.enum([
 'happy_path','cash_delivery','cancel_before_prep','no_driver']).default('happy_path')});
const steps=['customer_order','restaurant_confirm','preparing','ready',
 'driver_assigned','picked_up','on_the_way','delivered','settled'];
const simPublic=(x:any)=>({id:x.id,created_by_user_id:x.createdByUserId,
 scenario:x.scenario,status:x.status,current_step:x.currentStep,
 state_json:x.stateJson,created_at:x.createdAt.toISOString(),updated_at:x.updatedAt.toISOString()});
operationsRouter.post('/admin/simulations',async(req,res)=>{
 const who=await account(req,['admin']);
 const p=payload(scenario,req.body);
 const state={steps:[],money_real:false,inventory_real:false,
  description:'Simulación aislada; no cobra, no descuenta stock, no genera pagos.'};
 const x=await db.opsSimulation.create({data:{scenario:p.scenario,
  createdByUserId:who.id,stateJson:JSON.stringify(state)}});
 res.status(201).json(simPublic(x));
});
operationsRouter.get('/admin/simulations',async(req,res)=>{
 await account(req,['admin']);
 const x=await db.opsSimulation.findMany({orderBy:{createdAt:'desc'},take:100});
 res.json(x.map(simPublic));
});
const advance=async(id:number,all:boolean)=>{
 return db.$transaction(async tx=>{
  const locks=await tx.$queryRawUnsafe(
   'SELECT id FROM simulation_runs WHERE id=$1 FOR UPDATE',id);
  if(!Array.isArray(locks)||!locks.length)return bad(404,'Simulación no encontrada');
  const row=await tx.opsSimulation.findUnique({where:{id}});
  if(!row)return bad(404,'Simulación no encontrada');
  if(row.status==='completed')return row;
  const state=JSON.parse(row.stateJson) as {steps:{step:string;at:string}[];result?:string};
  const idx=steps.indexOf(row.currentStep),finish=all||idx>=steps.length-1;
  if(all){state.steps=steps.map(step=>({step,at:new Date().toISOString()}));}
  else state.steps.push({step:row.currentStep,at:new Date().toISOString()});
  let next=steps[Math.min(Math.max(idx,0)+1,steps.length-1)]!,
   status='created';
  if(row.scenario==='cancel_before_prep'&&(all||row.currentStep==='restaurant_confirm')){
   next='cancelled';status='completed';state.result='cancelled_without_real_charge';
  }else if(row.scenario==='no_driver'&&(all||row.currentStep==='ready')){
   next='dispatch_alert';status='completed';state.result='manual_dispatch_required';
  }else if(finish){
   next='settled';status='completed';state.result='success';
  }
  return tx.opsSimulation.update({where:{id},data:{
   currentStep:next,status,stateJson:JSON.stringify(state)}});
 },{maxWait:10000,timeout:20000});
};
operationsRouter.post('/admin/simulations/:simulationId/advance',async(req,res)=>{
 await account(req,['admin']);
 const x=await advance(param(req,'simulationId'),false);
 res.json(simPublic(x));
});
operationsRouter.post('/admin/simulations/:simulationId/run-all',async(req,res)=>{
 await account(req,['admin']);
 const x=await advance(param(req,'simulationId'),true);
 res.json(simPublic(x));
});
operationsRouter.get('/admin/payouts',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.opsPayout.findMany({orderBy:{createdAt:'desc'},take:500});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,payee_type:x.payeeType,payee_id:x.payeeId,
  amount:money(x.amount),currency:x.currency,period_start:x.periodStart.toISOString(),
  period_end:x.periodEnd.toISOString(),status:x.status,provider_ref:x.providerRef,
  provider:x.provider,attempts:x.attempts,failure_reason:x.failureReason,
  created_at:x.createdAt.toISOString(),paid_at:x.paidAt?.toISOString()??null})));
});
operationsRouter.get('/admin/cash-settlements',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.opsCashSettlement.findMany({orderBy:{createdAt:'desc'},take:500});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,driver_id:x.driverId,period_label:x.periodLabel,
  cash_collected:money(x.cashCollected),driver_earnings:money(x.driverEarnings),
  amount_due_platform:money(x.amountDuePlatform),status:x.status,notes:x.notes,
  created_at:x.createdAt.toISOString(),settled_at:x.settledAt?.toISOString()??null})));
});
operationsRouter.get('/owner/finance',async(req,res)=>{
 const who=await account(req,['restaurant','admin']),shop=await ownedShop(who);
 const orders=await db.marketOrder.findMany({where:{
  restaurantId:shop.id,status:'delivered'},select:{
   subtotal:true,platformCommission:true,restaurantPayout:true}});
 const totals=(key:'subtotal'|'platformCommission'|'restaurantPayout')=>cash(
  orders.reduce((s,q)=>s+cents(q[key]),0n));
 const payouts=await db.opsPayout.findMany({where:{
  payeeType:'restaurant',payeeId:shop.id},orderBy:{createdAt:'desc'},take:20});
 res.setHeader('Cache-Control','private, no-store');
 res.json({restaurant_id:shop.id,commercial_plan:shop.commercialPlan,
  commission_rate:shop.commissionRate.toFixed(4),
  gross_food_sales:totals('subtotal'),commission:totals('platformCommission'),
  net_payable:totals('restaurantPayout'),orders:orders.length,
  payouts:payouts.map(p=>({id:p.id,amount:money(p.amount),status:p.status,
   period_start:p.periodStart.toISOString(),period_end:p.periodEnd.toISOString()}))});
});
operationsRouter.get('/driver/finance',async(req,res)=>{
 const who=await account(req,['driver']);
 const orders=await db.marketOrder.findMany({where:{driverId:who.id,status:'delivered'},
  select:{driverEarning:true,tip:true,cashCollected:true,paymentMethod:true}});
 const payouts=await db.opsPayout.findMany({where:{payeeType:'driver',payeeId:who.id},
  orderBy:{createdAt:'desc'},take:20});
 res.setHeader('Cache-Control','private, no-store');
 res.json({driver_id:who.id,deliveries:orders.length,
  gross_earnings:cash(orders.reduce((s,x)=>s+cents(x.driverEarning)+cents(x.tip),0n)),
  cash_collected:cash(orders.reduce((s,x)=>s+(x.paymentMethod==='cash'?cents(x.cashCollected):0n),0n)),
  payouts:payouts.map(p=>({id:p.id,amount:money(p.amount),status:p.status}))});
});


adminRouter.post('/restaurants',async(req,res)=>{
 const admin=await account(req,['admin']);
 const p=payload(z.strictObject({
  name:z.string().min(2).max(150),description:z.string().default(''),
  cuisine:z.string().default('Comida local'),emoji:z.string().default('🍽️'),
  eta_min:z.number().int().min(5).max(180).default(30),
  delivery_fee:centsDecimal.default('0'),is_open:z.boolean().default(true),
  owner_email:z.email().nullable().default(null),
  lat:z.number().finite().min(-90).max(90).default(20.6534),
  lng:z.number().finite().min(-180).max(180).default(-103.704),
  address:z.string().max(300).default(''),
  delivery_radius_km:z.number().finite().gt(0).max(150).default(8),
  per_km_fee:centsDecimal.default('4'),pickup_enabled:z.boolean().default(true),
  sponsored:z.boolean().default(false),
 }),req.body);
 const created=await db.$transaction(async tx=>{
  let ownerId:number|null=null;
  if(p.owner_email){
   const owner=await tx.authUser.findUnique({where:{email:p.owner_email.toLowerCase()}});
   if(!owner)return bad(404,'Usuario no encontrado');
   ownerId=owner.id;
   await tx.authUser.update({where:{id:owner.id},data:{role:'restaurant'}});
  }
  const row=await tx.marketplaceRestaurant.create({data:{
   ownerId,name:p.name,description:p.description,cuisine:p.cuisine,emoji:p.emoji,
   etaMin:p.eta_min,deliveryFee:p.delivery_fee,isOpen:p.is_open,
   lat:p.lat,lng:p.lng,address:p.address,deliveryRadiusKm:p.delivery_radius_km,
   perKmFee:p.per_km_fee,pickupEnabled:p.pickup_enabled,sponsored:p.sponsored}});
  await tx.authAuditEvent.create({data:{userId:admin.id,
   action:'restaurant.create',entityType:'restaurant',entityId:String(row.id),
   detail:'admin onboarding'}});
  return row;
 });
 res.status(201).json({id:created.id,name:created.name,description:created.description,
  cuisine:created.cuisine,emoji:created.emoji,eta_min:created.etaMin,
  delivery_fee:money(created.deliveryFee),is_open:created.isOpen,owner_id:created.ownerId,
  lat:created.lat,lng:created.lng,address:created.address,
  delivery_radius_km:created.deliveryRadiusKm,per_km_fee:money(created.perKmFee),
  pickup_enabled:created.pickupEnabled,sponsored:created.sponsored,
  rating:created.rating.toFixed(2)});
});
const boolQuery=(req:Request,key:string,base:boolean)=>{
 const raw=req.query[key];
 if(raw===undefined)return base;
 if(raw==='true')return true;if(raw==='false')return false;
 return bad(422,'Parámetro booleano inválido');
};
adminRouter.patch('/users/:userId/active',async(req,res)=>{
 const admin=await account(req,['admin']);
 const id=param(req,'userId'),enabled=boolQuery(req,'active',true);
 if(admin.id===id&&!enabled)return bad(400,'No puedes desactivar tu propia cuenta');
 const row=await db.$transaction(async tx=>{
  const user=await tx.authUser.findUnique({where:{id}});
  if(!user)return bad(404,'Usuario no encontrado');
  const updated=await tx.authUser.update({where:{id},data:{isActive:enabled}});
  if(!enabled)await tx.authDeviceSession.updateMany({
   where:{userId:id,active:true},data:{active:false}});
  await tx.authAuditEvent.create({data:{userId:admin.id,action:'user.active',
   entityType:'user',entityId:String(id),detail:String(enabled)}});
  return updated;
 });
 res.json(userFields(row));
});
adminRouter.patch('/fraud/:flagId/resolved',async(req,res)=>{
 const who=await account(req,['admin']);
 const id=param(req,'flagId'),resolved=boolQuery(req,'resolved',true);
 const prior=await db.opsFraudFlag.findUnique({where:{id}});
 if(!prior)return bad(404,'Señal no encontrada');
 const row=await db.$transaction(async tx=>{
  const updated=await tx.opsFraudFlag.update({where:{id},data:{resolved}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'fraud.resolve',
   entityType:'fraud_flag',entityId:String(id),detail:String(resolved)}});
  return updated;
 });
 res.json({id:row.id,resolved:row.resolved});
});
adminRouter.patch('/restaurants/:restaurantId/verification',async(req,res)=>{
 const who=await account(req,['admin']);
 const id=param(req,'restaurantId');
 const status=req.query.status??'verified';
 if(typeof status!=='string'||!['pending','verified','rejected','suspended'].includes(status))
  return bad(400,'Estado inválido');
 const row=await db.marketplaceRestaurant.findUnique({where:{id}});
 if(!row)return bad(404,'Restaurante no encontrado');
 if(row.verificationStatus==='archived')return bad(409,'Restaurante archivado');
 const updated=await db.$transaction(async tx=>{
  const result=await tx.marketplaceRestaurant.update({where:{id},data:{
   verificationStatus:status,
   ...(status!=='verified'?{isOpen:false,sponsored:false,
     ...(status==='suspended'?{pickupEnabled:false}:{})}:{})}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'restaurant.verify',
   entityType:'restaurant',entityId:String(id),detail:status}});
  return result;
 });
 res.json({id:updated.id,verification_status:updated.verificationStatus});
});
adminRouter.patch('/drivers/:userId/verified',async(req,res)=>{
 const who=await account(req,['admin']);
 const id=param(req,'userId'),verified=boolQuery(req,'verified',true);
 const existing=await db.marketplaceDriverProfile.findUnique({where:{userId:id}});
 if(!existing)return bad(404,'Perfil de repartidor no encontrado');
 const updated=await db.$transaction(async tx=>{
  const result=await tx.marketplaceDriverProfile.update({where:{userId:id},
   data:{isVerified:verified,...(!verified?{isOnline:false}:{})}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'driver.verify',
   entityType:'driver',entityId:String(id),detail:String(verified)}});
  return result;
 });
 res.json({user_id:id,is_verified:updated.isVerified});
});
adminRouter.patch('/verifications/:recordId',async(req,res)=>{
 const who=await account(req,['admin']);
 const id=param(req,'recordId');
 const raw=req.query.status;
 if(typeof raw!=='string'||!['pending','approved','rejected','needs_info'].includes(raw))
  return bad(400,'Estado inválido');
 const notes=typeof req.query.notes==='string'?req.query.notes.slice(0,500):'';
 const existing=await db.opsVerificationRecord.findUnique({where:{id}});
 if(!existing)return bad(404,'Verificación no encontrada');
 const result=await db.$transaction(async tx=>{
  const row=await tx.opsVerificationRecord.update({where:{id},
   data:{status:raw,notes}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'verification.update',
   entityType:'verification',entityId:String(id),detail:raw}});
  return row;
 });
 res.json({id:result.id,status:result.status,notes:result.notes});
});

export function opsErrors(err:unknown,_req:Request,res:Response,next:NextFunction){
 if(err instanceof OpsError){res.status(err.code).json({detail:err.message});return;}
 next(err);
}


// ADMIN operations: reuse support_tickets created by Usuarios.
// Replies are immutable after resolution, atomic, audited and sent to
// existing customer notifications (no new messaging infrastructure).
adminRouter.get('/support',async(req,res)=>{
 const who=await account(req,['admin']);
 const limit=query(req,'limit',100,1,200);
 const status=req.query.status;
 if(status!==undefined&&
    (typeof status!=='string'||!['open','in_progress','resolved','all'].includes(status)))
   return bad(422,'Filtro inválido');
 const tickets=await db.platformSupportTicket.findMany({
   where:!status||status==='all'?{}:{status},
   orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,
 });
 const ids=[...new Set(tickets.map(t=>t.userId))];
 const customers=ids.length?await db.authUser.findMany({
   where:{id:{in:ids}},select:{id:true,name:true,email:true}
 }):[];
 const byUser=new Map(customers.map(u=>[u.id,u]));
 res.setHeader('Cache-Control','private, no-store');
 res.json(tickets.map(t=>({
   id:t.id,user_id:t.userId,customer_name:byUser.get(t.userId)?.name??'',
   customer_email:byUser.get(t.userId)?.email??'',
   order_id:t.orderId,category:t.category,message:t.message,
   status:t.status,admin_reply:t.adminReply,
   responded_at:t.respondedAt?.toISOString()??null,
   created_at:t.createdAt.toISOString(),
 })));
});

// PATCH prevents duplicate replies/notifications and never allows an admin
// to impersonate a customer. Reply is only sent on resolution.
adminRouter.patch('/support/:ticketId',async(req,res)=>{
 const who=await account(req,['admin']);
 const id=param(req,'ticketId');
 const p=payload(z.strictObject({
   status:z.enum(['in_progress','resolved']),
   reply:z.string().trim().min(10).max(3000).optional(),
 }),req.body);
 if(p.status==='resolved'&&!p.reply)
   return bad(422,'Para resolver debes escribir una respuesta de al menos 10 caracteres');
 if(p.status==='in_progress'&&p.reply)
   return bad(422,'La respuesta solo se envía al resolver el ticket');
 const row=await db.$transaction(async tx=>{
   const locks=await tx.$queryRawUnsafe(
     'SELECT id FROM support_tickets WHERE id=$1 FOR UPDATE',id);
   if(!Array.isArray(locks)||!locks.length)return bad(404,'Ticket no encontrado');
   const ticket=await tx.platformSupportTicket.findUnique({where:{id}});
   if(!ticket)return bad(404,'Ticket no encontrado');
   if(ticket.status==='resolved')return bad(409,'Este ticket ya está resuelto');
   const updated=await tx.platformSupportTicket.update({where:{id},data:{
     status:p.status,
     ...(p.status==='resolved'?{adminReply:p.reply!,respondedAt:new Date()}:{})
   }});
   if(p.status==='resolved'){
     await tx.authNotification.create({data:{
       userId:ticket.userId,kind:'support',title:'Respuesta de Tala Eats · Ticket #'+id,
       message:p.reply!.length>400?
         p.reply!.slice(0,397)+'...':p.reply!,
     }});
   }
   await tx.authAuditEvent.create({data:{
     userId:who.id,action:'support.ticket.'+p.status,
     entityType:'support_ticket',entityId:String(id),
     detail:p.status==='resolved'?'Customer notified':'Assigned for review',
   }});
   return updated;
 },{maxWait:10000,timeout:20000});
 res.setHeader('Cache-Control','private, no-store');
 res.json({id:row.id,status:row.status,admin_reply:row.adminReply,
   responded_at:row.respondedAt?.toISOString()??null});
});

// Administrative restaurant roster includes inactive/archived records.
// Historical orders are intentionally never deleted.
adminRouter.get('/restaurants',async(req,res)=>{
 await account(req,['admin']);
 const limit=query(req,'limit',50,1,100),offset=query(req,'offset',0,0,1000000);
 const filter=req.query.filter??'all';
 if(typeof filter!=='string'||!['all','inactive','archived'].includes(filter))
   return bad(422,'Filtro inválido');
 const where=filter==='inactive'?{isOpen:false,verificationStatus:{not:'archived'}}:
   filter==='archived'?{verificationStatus:'archived'}:{};
 const shops=await db.marketplaceRestaurant.findMany({
   where,
   select:{id:true,name:true,ownerId:true,isOpen:true,verificationStatus:true,
     onboardingStatus:true,marketCode:true,createdAt:true,
     orders:{orderBy:{createdAt:'desc'},take:1,select:{createdAt:true}},
     _count:{select:{orders:{where:{status:{notIn:['delivered','cancelled']}}}}},
   },
   orderBy:[{createdAt:'desc'},{id:'desc'}],skip:offset,take:limit,
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json(shops.map(s=>({
   id:s.id,name:s.name,owner_id:s.ownerId,is_open:s.isOpen,
   verification_status:s.verificationStatus,onboarding_status:s.onboardingStatus,
   market_code:s.marketCode,active_orders:s._count.orders,
   last_order_at:s.orders[0]?.createdAt.toISOString()??null,
   can_archive:!s.isOpen&&s.verificationStatus!=='archived'&&s._count.orders===0,
 })));
});

// "Eliminar" from the ADMIN UI = reversible-by-authorized-recovery archive.
// No destructive SQL, no cascade deleting orders, ledger, reviews or media.
adminRouter.patch('/restaurants/:restaurantId/archive',async(req,res)=>{
 const who=await account(req,['admin']),id=param(req,'restaurantId');
 const p=payload(z.strictObject({
   confirm_name:z.string().min(2).max(150),
   reason:z.string().trim().min(10).max(300),
 }),req.body);
 const result=await db.$transaction(async tx=>{
   const locks=await tx.$queryRawUnsafe('SELECT id FROM restaurants WHERE id=$1 FOR UPDATE',id);
   if(!Array.isArray(locks)||!locks.length)return bad(404,'Restaurante no encontrado');
   const shop=await tx.marketplaceRestaurant.findUnique({where:{id}});
   if(!shop)return bad(404,'Restaurante no encontrado');
   if(shop.verificationStatus==='archived')return bad(409,'Restaurante ya archivado');
   if(shop.name!==p.confirm_name)return bad(422,'El nombre de confirmación no coincide');
   if(shop.isOpen)return bad(409,'Primero cierra el restaurante');
   const pending=await tx.marketOrder.count({
     where:{restaurantId:id,status:{notIn:['delivered','cancelled']}}
   });
   if(pending>0)return bad(409,'El restaurante tiene '+pending+' pedidos sin finalizar');
   const saved=await tx.marketplaceRestaurant.update({where:{id},data:{
     isOpen:false,pickupEnabled:false,sponsored:false,
     verificationStatus:'archived',onboardingStatus:'archived',
   }});
   await tx.authAuditEvent.create({data:{
     userId:who.id,action:'restaurant.archive',entityType:'restaurant',
     entityId:String(id),detail:p.reason,
   }});
   return saved;
 },{maxWait:10000,timeout:20000});
 res.setHeader('Cache-Control','private, no-store');
 res.json({id:result.id,name:result.name,archived:true,
   verification_status:result.verificationStatus});
});
