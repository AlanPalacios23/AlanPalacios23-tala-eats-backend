// Python contract sources: restaurants.py, owner.py, orders.py, driver.py,
// models.py/schemas.py at Python main@7cf8ae3f. Stage-only implementation.
// READ-ONLY order views; no checkout, settlement, dispatch or payment writes.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { createCashPickupOnly, isCashPickupIntent } from './checkout.js';
import { previewCancelStage, cancelCashPickupStage, moveCashPickupOwnerStage } from './lifecycle.js';
import { current } from '../auth/routes.js';
import type { AuthUser, MarketplaceRestaurant, MarketplaceMenuItem,
  MarketplaceDriverProfile, MarketOrder, MarketOrderItem } from '../generated/prisma/client.js';

export const marketplaceRouter = Router();
export const ownerRouter = Router();
export const stageOrdersRouter = Router();
export const stageDriverRouter = Router();

class RouteError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}
const notFound = (message: string): never => { throw new RouteError(404,message); };
const posInt = (raw: unknown): number => {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))) throw new RouteError(422,'Identificador inválido');
  return Number(raw);
};
const pagination = z.object({
  limit:z.coerce.number().int().min(1).max(200).default(100),
  offset:z.coerce.number().int().min(0).max(1_000_000).default(0),
});
function page(req:Request) {
  const r=pagination.safeParse(req.query);
  if (!r.success) throw new RouteError(422,'Paginación inválida');
  return r.data;
}
async function user(req:Request, roles?:string[]) {
  const session=await current(req);
  if (roles && !roles.includes(session.user.role))
    throw new RouteError(403,'No tienes permisos para esta operación');
  return session.user;
}
const prop = (obj:object,camel:string):unknown => (obj as Record<string,unknown>)[camel];
const snake = (name:string):string => name.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
function jsonFields(obj:object,fields:readonly string[]) {
  return Object.fromEntries(fields.map(k => {
    const value=prop(obj,k);
    return [snake(k),value instanceof Date?value.toISOString():value?.toString?.() && typeof value==='object' && !Array.isArray(value)?value.toString():value];
  }));
}
const restaurantFields=[
  'id','name','description','cuisine','emoji','etaMin','deliveryFee','isOpen',
  'ownerId','lat','lng','address','deliveryRadiusKm','perKmFee','pickupEnabled',
  'sponsored','rating','verificationStatus','commercialPlan','commissionRate',
  'serviceFeeRate','serviceFeeFixed','branchCode','brandName','marketCode',
  'onboardingStatus','coverImageUrl',
] as const;
const menuFields=[
  'id','restaurantId','name','description','category','price','isAvailable','stock',
  'dietaryTags','allergens','isCombo','optionsJson','availabilityScheduleJson',
  'priceScheduleJson','imageUrl',
] as const;
const orderFields=[
  'id','userId','restaurantId','driverId','status','paymentMethod','paymentStatus',
  'subtotal','deliveryFee','discount','tip','total','platformCommission',
  'serviceFee','paymentProcessingFee','refundedAmount','promotionSubsidy',
  'platformRevenue','contributionMargin','cashCollected','cancellationFee',
  'restaurantPayout','driverEarning','paymentProvider','paymentProviderId',
  'paymentPreferenceId','address','notes','orderType','scheduledFor','couponCode',
  'groupCode','recipientName','recipientPhone','giftMessage','corporateAccountId',
  'distanceKm','deliveryLat','deliveryLng','estimatedMinutes','invoiceRequested',
  'invoiceTaxId','clientReference','createdAt','updatedAt','acceptedAt',
  'preparingAt','readyAt','pickedUpAt','deliveredAt',
] as const;
function menuPublic(i:MarketplaceMenuItem) {return jsonFields(i,menuFields);}
function restaurantPublic(r:MarketplaceRestaurant) {return jsonFields(r,restaurantFields);}
function restaurantDetail(r:MarketplaceRestaurant & {menuItems:MarketplaceMenuItem[]}) {
  return {...restaurantPublic(r),menu_items:r.menuItems.sort((a,b)=>
    a.category.localeCompare(b.category)||a.name.localeCompare(b.name)).map(menuPublic)};
}
const orderInclude={items:true,driver:{include:{driverProfile:true}}} as const;
type LoadedOrder=MarketOrder & {items:MarketOrderItem[],
  driver:(AuthUser & {driverProfile:MarketplaceDriverProfile|null})|null};
function orderView(order:LoadedOrder, customer:boolean) {
  const itemFields=['id','menuItemId','nameSnapshot','quantity','unitPrice','optionsSnapshot'] as const;
  const profile=order.driver?.driverProfile;
  const driver=order.driver ? {
    id:order.driver.id,name:order.driver.name,phone:order.driver.phone,
    avatar_url:order.driver.avatarUrl,vehicle:profile?.vehicle??'Motocicleta',
    rating:(profile?.rating??'5').toString(),current_lat:profile?.currentLat??null,
    current_lng:profile?.currentLng??null,
  }:null;
  return {...jsonFields(order,orderFields),
    items:order.items.map(i=>jsonFields(i,itemFields)),
    driver_info:driver,
    ...(customer?{delivery_pin:order.deliveryPin}:{})};
}
function idParam(req:Request, name:string) {
  const value=req.params[name];
  return posInt(Array.isArray(value)?value[0]:value);
}

// Python restaurants.py: paginated public list + menu detail.
marketplaceRouter.get('/',async(req,res)=>{
  const {limit,offset}=page(req);
  const rows=await db.marketplaceRestaurant.findMany({
    orderBy:[{isOpen:'desc'},{name:'asc'},{id:'asc'}],skip:offset,take:limit,
  });
  res.json(rows.map(restaurantPublic));
});
marketplaceRouter.get('/:restaurantId',async(req,res)=>{
  const row=await db.marketplaceRestaurant.findUnique({
    where:{id:idParam(req,'restaurantId')},include:{menuItems:true},
  });
  if(!row) return notFound('Restaurante no encontrado');
  res.json(restaurantDetail(row));
});

// Python owner.py: ownership and profile/menu; never trust a merchant-supplied owner_id.
async function ownRestaurant(req:Request) {
  const account=await user(req,['restaurant','admin']);
  const row=await db.marketplaceRestaurant.findFirst({where:{ownerId:account.id}});
  if(!row) return notFound('No tienes un restaurante asignado');
  return {account,row};
}
ownerRouter.get('/restaurant',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  const detail=await db.marketplaceRestaurant.findUnique({
    where:{id:row.id},include:{menuItems:true},
  });
  if(!detail) return notFound('No tienes un restaurante asignado');
  res.json(restaurantDetail(detail));
});
const positivePrice=z.union([z.string(),z.number()]).transform(String).pipe(
  z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/).refine(v=>Number(v)>0)
);
const nonnegativePrice=z.union([z.string(),z.number()]).transform(String).pipe(
  z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
);
const menuSchema=z.strictObject({
  name:z.string().min(2).max(150),
  description:z.string().default(''),
  category:z.string().max(100).default('General'),
  price:positivePrice,
  is_available:z.boolean().default(true),
  stock:z.number().int().min(0).default(100),
  dietary_tags:z.string().max(300).default(''),
  allergens:z.string().max(300).default(''),
  is_combo:z.boolean().default(false),
  options_json:z.string().default('[]'),
  availability_schedule_json:z.string().default('{}'),
  price_schedule_json:z.string().default('{}'),
});
const menuPatch=menuSchema.partial().extend({image_url:z.string().max(600).optional()});
function input<T extends z.ZodTypeAny>(schema:T,value:unknown):z.output<T> {
  const parsed=schema.safeParse(value);
  if(!parsed.success) throw new RouteError(422,'Datos inválidos');
  return parsed.data;
}
function itemValues(data:z.output<typeof menuPatch>) {
  return {
    ...(data.name!==undefined?{name:data.name}:{}),
    ...(data.description!==undefined?{description:data.description}:{}),
    ...(data.category!==undefined?{category:data.category}:{}),
    ...(data.price!==undefined?{price:data.price}:{}),
    ...(data.is_available!==undefined?{isAvailable:data.is_available}:{}),
    ...(data.stock!==undefined?{stock:data.stock}:{}),
    ...(data.dietary_tags!==undefined?{dietaryTags:data.dietary_tags}:{}),
    ...(data.allergens!==undefined?{allergens:data.allergens}:{}),
    ...(data.is_combo!==undefined?{isCombo:data.is_combo}:{}),
    ...(data.options_json!==undefined?{optionsJson:data.options_json}:{}),
    ...(data.availability_schedule_json!==undefined?{availabilityScheduleJson:data.availability_schedule_json}:{}),
    ...(data.price_schedule_json!==undefined?{priceScheduleJson:data.price_schedule_json}:{}),
    ...(data.image_url!==undefined?{imageUrl:data.image_url}:{}),
  };
}
ownerRouter.post('/menu',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  const data=input(menuSchema,req.body);
  const created=await db.marketplaceMenuItem.create({
    data:{...itemValues(data),name:data.name,price:data.price,restaurantId:row.id},
  });
  res.status(201).json(menuPublic(created));
});
ownerRouter.patch('/menu/:itemId',async(req,res)=>{
  const account=await user(req,['restaurant','admin']);
  const id=idParam(req,'itemId');
  const patch=input(menuPatch,req.body);
  const entry=await db.marketplaceMenuItem.findUnique({
    where:{id},include:{restaurant:true},
  });
  if(!entry) return notFound('Producto no encontrado');
  if(account.role!=='admin'&&entry.restaurant.ownerId!==account.id)
    throw new RouteError(403,'No puedes modificar ese producto');
  const changed=await db.marketplaceMenuItem.update({
    where:{id},data:itemValues(patch),
  });
  res.json(menuPublic(changed));
});
ownerRouter.delete('/menu/:itemId',async(req,res)=>{
  const account=await user(req,['restaurant','admin']);
  const id=idParam(req,'itemId');
  const entry=await db.marketplaceMenuItem.findUnique({
    where:{id},include:{restaurant:true},
  });
  if(!entry) return notFound('Producto no encontrado');
  if(account.role!=='admin'&&entry.restaurant.ownerId!==account.id)
    throw new RouteError(403,'No puedes eliminar ese producto');
  // Stage order history must keep immutable item snapshots: don't allow deleting
  // an item referenced by an order, even if Python currently allows FK SET NULL.
  const used=await db.marketOrderItem.count({where:{menuItemId:id}});
  if(used) throw new RouteError(409,'Producto vinculado a pedidos históricos');
  await db.marketplaceMenuItem.delete({where:{id}});
  res.status(204).end();
});
const restaurantPatch=z.strictObject({
  name:z.string().min(1).max(150).optional(),
  description:z.string().optional(),
  cuisine:z.string().max(100).optional(),
  emoji:z.string().max(20).optional(),
  eta_min:z.number().int().min(5).max(180).optional(),
  delivery_fee:nonnegativePrice.optional(),
  is_open:z.boolean().optional(),
  delivery_radius_km:z.number().finite().positive().optional(),
  per_km_fee:nonnegativePrice.optional(),
  pickup_enabled:z.boolean().optional(),
  sponsored:z.boolean().optional(),
  pos_webhook_url:z.string().max(600).optional(),
  tax_id:z.string().max(40).optional(),
  address:z.string().trim().min(5).max(300).optional(),
  lat:z.number().finite().min(-90).max(90).optional(),
  lng:z.number().finite().min(-180).max(180).optional(),
}).refine(v=>(v.lat===undefined)===(v.lng===undefined),{message:'lat y lng deben enviarse juntos'});
ownerRouter.patch('/restaurant',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  const data=input(restaurantPatch,req.body);
  const changes:Record<string,unknown>={};
  for(const [key,value] of Object.entries(data)){
    const camel=key.replace(/_([a-z])/g,(_m,c:string)=>c.toUpperCase());
    changes[camel]=value;
  }
  const updated=await db.marketplaceRestaurant.update({where:{id:row.id},data:changes});
  res.json(restaurantPublic(updated));
});

// Python orders.py: customer-specific recovery; no new order or financial writes.
stageOrdersRouter.get('/by-reference/:reference',async(req,res)=>{
  const account=await user(req);
  const ref=req.params.reference;
  const value=Array.isArray(ref)?ref[0]:ref;
  if(!value||!/^[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new RouteError(422,'Referencia inválida');
  res.setHeader('Cache-Control','private, no-store');
  const order=await db.marketOrder.findFirst({
    where:{userId:account.id,clientReference:value},include:orderInclude,
  });
  if(!order) return notFound('Pedido no encontrado');
  res.json(orderView(order,true));
});
stageOrdersRouter.get('/mine',async(req,res)=>{
  const account=await user(req);
  const {limit,offset}=page(req);
  const orders=await db.marketOrder.findMany({
    where:{userId:account.id},include:orderInclude,
    orderBy:[{createdAt:'desc'},{id:'desc'}],skip:offset,take:limit,
  });
  res.json(orders.map(o=>orderView(o,true)));
});
// Python orders.py reorder is a non-mutating cart reconstruction, not a charge.
stageOrdersRouter.post('/:orderId/reorder',async(req,res)=>{
  const account=await user(req,['customer']);
  const order=await db.marketOrder.findFirst({
    where:{id:idParam(req,'orderId'),userId:account.id},include:{items:true},
  });
  if(!order) return notFound('Pedido no encontrado');
  res.json({
    restaurant_id:order.restaurantId,
    items:order.items.filter(x=>x.menuItemId!==null).map(x=>({
      menu_item_id:x.menuItemId,quantity:x.quantity,
    })),
  });
});
stageOrdersRouter.get('/:orderId/cancellation-preview',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const result=await previewCancelStage(idParam(req,'orderId'),account);
  res.setHeader('Cache-Control','private, no-store');
  res.json(result);
});
stageOrdersRouter.post('/:orderId/cancel',async(req,res)=>{
  const account=await user(req,['customer','admin']);
  const raw=req.query.reason;
  if(raw!==undefined&&(typeof raw!=='string'||raw.length>300))
    throw new RouteError(422,'Motivo inválido');
  const id=await cancelCashPickupStage(idParam(req,'orderId'),account,
    typeof raw==='string'?raw:'Cambio de planes');
  const order=await db.marketOrder.findUnique({where:{id},include:orderInclude});
  if(!order)throw new RouteError(503,'Pedido no encontrado tras cancelación');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(order,true));
});
stageOrdersRouter.get('/:orderId',async(req,res)=>{
  const account=await user(req);
  const order=await db.marketOrder.findUnique({
    where:{id:idParam(req,'orderId')},include:{...orderInclude,restaurant:true},
  });
  if(!order) return notFound('Pedido no encontrado');
  const isOwner=order.userId===account.id;
  const authorized=account.role==='admin'||isOwner||order.driverId===account.id||
    (account.role==='restaurant'&&order.restaurant.ownerId===account.id);
  if(!authorized) throw new RouteError(403,'No tienes acceso a este pedido');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(order,isOwner));
});
stageOrdersRouter.post('/',async(req,res)=>{
  if(config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'||!isCashPickupIntent(req.body)){
    res.status(503).json({detail:'Checkout Node staging disponible sólo para pickup/cash sintético con feature flag explícita'});
    return;
  }
  const account=await user(req,['customer','admin']);
  const orderId=await createCashPickupOnly(req.body,account);
  const created=await db.marketOrder.findUnique({
    where:{id:orderId},include:orderInclude,
  });
  if(!created)throw new RouteError(503,'Pedido transaccional no encontrado');
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json(orderView(created,true));
});
ownerRouter.patch('/orders/:orderId/status',async(req,res)=>{
  const account=await user(req,['restaurant','admin']);
  const parsed=z.strictObject({status:z.string()}).safeParse(req.body);
  if(!parsed.success)throw new RouteError(422,'Estado inválido');
  const value=parsed.data.status;
  const id=idParam(req,'orderId');
  const orderId=value==='cancelled'?
    await cancelCashPickupStage(id,account,'Cancelado por restaurante'):
    ['confirmed','preparing','ready'].includes(value)?
      await moveCashPickupOwnerStage(id,account,value as 'confirmed'|'preparing'|'ready'):
      (()=>{throw new RouteError(503,'Transición no disponible en staging');})();
  const order=await db.marketOrder.findUnique({where:{id:orderId},include:orderInclude});
  if(!order)throw new RouteError(503,'Pedido no encontrado tras actualización');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(order,false));
});
ownerRouter.get('/orders',async(req,res)=>{
  const account=await user(req,['restaurant','admin']);
  const {limit,offset}=page(req);
  const activeOnly=req.query.active_only==='true';
  const owners=await db.marketplaceRestaurant.findMany({
    where:{ownerId:account.id},select:{id:true},
  });
  const ids=owners.length?owners.map(x=>x.id):account.role==='admin'?
    (await db.marketplaceRestaurant.findMany({select:{id:true}})).map(x=>x.id):[];
  if(!ids.length){res.json([]);return;}
  const rows=await db.marketOrder.findMany({
    where:{restaurantId:{in:ids},...(activeOnly?{status:{notIn:['delivered','cancelled']}}:{})},
    include:orderInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:offset,take:limit,
  });
  res.json(rows.map(x=>orderView(x,false)));
});

// Python owner.py KDS read-only. Delivery status changes/dispatch are NOT enabled.
ownerRouter.get('/kds',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  const lanes=['received','confirmed','preparing','ready',...(
    config.MERCHANT_MANAGED_DELIVERY==='true'?
      ['on_the_way']:['assigned','picked_up','on_the_way']
  )];
  const horizon=new Date(Date.now()+config.SCHEDULE_PREP_LEAD_MINUTES*60_000);
  const orders=await db.marketOrder.findMany({
    where:{
      restaurantId:row.id,
      status:{in:lanes},
      OR:[{paymentMethod:'cash'},{paymentStatus:'paid'}],
    },
    include:orderInclude,orderBy:[{createdAt:'asc'},{id:'asc'}],take:500,
  });
  const result:Record<string,unknown[]>={};
  for(const lane of lanes) result[lane]=[];
  for(const item of orders) {
    if(item.scheduledFor!==null&&item.scheduledFor>horizon) continue;
    result[item.status]?.push(orderView(item,false));
  }
  res.json(result);
});

// Python driver.py: profile and private assigned-order read surface.
// Availability/dispatch/GPS mutation blocked until atomic assignment and
// Redis live-location parity is implemented.
const driverFields=[
  'vehicle','plate','isOnline','isVerified','rating','totalDeliveries',
  'currentLat','currentLng','earningsToday',
] as const;
async function driverAccount(req:Request) {
  return user(req,['driver']);
}
stageDriverRouter.use((_req,res,next)=>{
  if(config.MERCHANT_MANAGED_DELIVERY==='true') {
    res.status(410).json({detail:'Tala Eats Repartidor no está activo porque MERCHANT_MANAGED_DELIVERY=true'});
    return;
  }
  next();
});
stageDriverRouter.get('/available',async(req,res)=>{
  const account=await driverAccount(req);
  const limit=z.coerce.number().int().min(1).max(100).safeParse(req.query.limit??25);
  if(!limit.success) throw new RouteError(422,'Límite inválido');
  const profile=await db.marketplaceDriverProfile.findUnique({where:{userId:account.id}});
  if(!profile?.isOnline){res.json([]);return;}
  const active=await db.marketOrder.count({
    where:{driverId:account.id,status:{in:['assigned','picked_up','on_the_way']}},
  });
  if(active>0){res.json([]);return;}
  const orders=await db.marketOrder.findMany({
    where:{status:'ready',driverId:null,orderType:'delivery'},
    include:orderInclude,orderBy:[{updatedAt:'asc'},{id:'asc'}],take:limit.data,
  });
  res.json(orders.map(x=>orderView(x,false)));
});
stageDriverRouter.get('/profile',async(req,res)=>{
  const account=await driverAccount(req);
  const profile=await db.marketplaceDriverProfile.upsert({
    where:{userId:account.id},create:{userId:account.id},update:{},
  });
  res.json(jsonFields(profile,driverFields));
});
stageDriverRouter.get('/mine',async(req,res)=>{
  const account=await driverAccount(req);
  const limitParsed=z.coerce.number().int().min(1).max(200).safeParse(req.query.limit??100);
  if(!limitParsed.success) throw new RouteError(422,'Límite inválido');
  const rows=await db.marketOrder.findMany({
    where:{driverId:account.id},include:orderInclude,
    orderBy:[{updatedAt:'desc'},{id:'desc'}],take:limitParsed.data,
  });
  res.json(rows.map(x=>orderView(x,false)));
});
stageDriverRouter.patch('/availability',async(_req,res)=>{
  res.status(503).json({detail:'Disponibilidad y asignación no habilitadas: falta paridad de dispatch concurrente'});
});
stageDriverRouter.patch('/location',async(_req,res)=>{
  res.status(503).json({detail:'Ubicación en tiempo real no habilitada: falta persistencia Redis/geo y contratos FCM'});
});

// Express 5 propagates async errors into router middleware.
export function marketplaceErrors(error:unknown,_req:Request,res:Response,_next:NextFunction) {
  if(typeof error==='object'&&error!==null&&'code' in error&&
     typeof (error as {code:unknown}).code==='number') {
    const e=error as {code:number,message?:string};
    res.status(e.code).json({detail:e.message??'Error'});
    return;
  }
  console.error('NODE_MARKETPLACE_STAGE_ERROR',error instanceof Error?error.name:'unknown');
  res.status(503).json({detail:'Marketplace de staging temporalmente no disponible'});
}
