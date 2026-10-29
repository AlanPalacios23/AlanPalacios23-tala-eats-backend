// Python contract sources: restaurants.py, owner.py, orders.py, driver.py,
// models.py/schemas.py at Python main@7cf8ae3f. Stage-only implementation.
// READ-ONLY order views; no checkout, settlement, dispatch or payment writes.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import {requireStageCheckoutWorker} from '../stage-worker-gate.js';
import { createStagePickupOrder, isCashPickupIntent, isStripePickupIntent,
  isStageCashDeliveryIntent,isStageStripeDeliveryIntent } from './checkout.js';
import {deliveryDistance,assertRestaurantDeliveryOrigin,DeliveryGeoError} from './delivery-geography.js';
import {hasReachableLiveDriver} from './live-delivery-capacity.js';
import {liveCashDeliveryReleased,isLiveCashCheckoutProvenance,cashPickupReleased} from './live-cash-delivery.js';
import {liveDispatchReleased} from './live-delivery-payment.js';
import {freshDriverNearPickup,driverLocationKey} from './delivery-runtime.js';
import {calculateDefaultCommercial,fmtCents} from '../finance/pricing.js';
import {calculatePickupQuoteFromCatalog,assertDefaultPickupRates,PickupQuoteError} from './quote.js';
import { previewCancelStage, cancelCashPickupStage, moveCashPickupOwnerStage } from './lifecycle.js';
import { completeCashPickupStage } from './pickup.js';
import { driverAvailability, driverAccept, driverStatus, driverGps,
  driverDashboard, driverComplete, driverPresenceReadiness, hasReachableStageDriver,
  canDriverReachPickup,liveCashDriverOffers } from './driver.js';
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
  // The ADMIN role is a privileged identity everywhere, including owner
  // mutations and cross-customer order views. A pre-enrollment JWT must not
  // bypass MFA simply by choosing a non-/admin/ route.
  if(session.user.role==='admin' &&
     (!session.user.twoFactorEnabled || !session.mfaVerified))
    throw new RouteError(403,'ADMIN requiere iniciar sesión con código 2FA');
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
export function restaurantPublic(r:MarketplaceRestaurant) {return jsonFields(r,restaurantFields);}
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
// Merchant list/KDS must not expose a manually flipped paid flag as proof.
// Only signed-webhook settlement receipt matching exact order total is trusted.
async function ownerProcessableOrders(orders:LoadedOrder[]):Promise<LoadedOrder[]>{
 const card=orders.filter(o=>o.paymentMethod==='stripe'&&o.paymentStatus==='paid');
 if(!card.length)return orders.filter(o=>o.paymentMethod==='cash');
 const live=config.NODE_ENV==='production';
 const receipts=await db.stageFinancialLedgerEntry.findMany({
   where:{orderId:{in:card.map(o=>o.id)},
     kind:live?'stripe_live_payment':'stripe_test_payment',
     account:live?'stripe_live_collected':'stripe_test_collected'},
   select:{orderId:true,account:true,kind:true,direction:true,
     amount:true,idempotencyKey:true},
 });
 const expectedKey=(id:number)=>'order:'+id+(live?':stripe-live:collected':':stripe-test:collected');
 const verified=new Set(card.filter(o=>receipts.some(e=>
   e.orderId===o.id&&e.idempotencyKey===expectedKey(o.id)&&
   e.direction==='credit'&&e.amount.toFixed(2)===o.total.toFixed(2)
 )).map(o=>o.id));
 return orders.filter(o=>o.paymentMethod==='cash'||
   (o.paymentMethod==='stripe'&&verified.has(o.id)));
}
function idParam(req:Request, name:string) {
  const value=req.params[name];
  return posInt(Array.isArray(value)?value[0]:value);
}

// Python restaurants.py: paginated public list + menu detail.
marketplaceRouter.get('/',async(req,res)=>{
  const {limit,offset}=page(req);
  if(Object.keys(req.query).some(key=>!['limit','offset','market_code'].includes(key)))
    throw new RouteError(422,'Parámetro de catálogo inválido');
  // Flutter Usuarios verifies market_code on every page. Filtering MUST
  // happen in PostgreSQL before OFFSET/LIMIT, never in the Flutter client
  // or after pagination (which would mix cities or truncate results).
  const raw=req.query.market_code;
  if(raw!==undefined&&(typeof raw!=='string'||
     !/^[A-Z][A-Z0-9-]{2,39}$/.test(raw)))
    throw new RouteError(422,'Código de localidad inválido');
  const marketCode=typeof raw==='string'?raw:undefined;
  const rows=await db.marketplaceRestaurant.findMany({
    where:{verificationStatus:'verified',...(marketCode?{marketCode}:{})},
    orderBy:[{isOpen:'desc'},{name:'asc'},{id:'asc'}],skip:offset,take:limit,
  });
  res.json(rows.map(restaurantPublic));
});
marketplaceRouter.get('/:restaurantId',async(req,res)=>{
  const row=await db.marketplaceRestaurant.findUnique({
    where:{id:idParam(req,'restaurantId')},include:{menuItems:true},
  });
  if(!row||row.verificationStatus!=='verified') return notFound('Restaurante no encontrado');
  res.json(restaurantDetail(row));
});

// Python owner.py: ownership and profile/menu; never trust a merchant-supplied owner_id.
async function ownRestaurant(req:Request) {
  const account=await user(req,['restaurant','admin']);
  const row=await db.marketplaceRestaurant.findFirst({
    where:{ownerId:account.id,verificationStatus:{not:'archived'}}});
  if(!row) return notFound('No tienes un restaurante asignado');
  return {account,row};
}
// Python owner.py analytics contract: total all-status orders, only delivered
// orders contribute gross_sales, and stock<10 counts ALL menu rows regardless
// of is_available. Never calculate merchant gross from unconfirmed orders.
ownerRouter.get('/analytics',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  const [all,delivered,inventoryLow]=await db.$transaction([
    db.marketOrder.count({where:{restaurantId:row.id}}),
    db.marketOrder.aggregate({
      where:{restaurantId:row.id,status:'delivered'},
      _count:{_all:true},_sum:{total:true},
    }),
    db.marketplaceMenuItem.count({where:{restaurantId:row.id,stock:{lt:10}}}),
  ]);
  const done=delivered._count._all;
  const gross=Number(delivered._sum.total??0);
  res.setHeader('Cache-Control','private, no-store');
  res.json({orders:all,delivered:done,gross_sales:gross,
    avg_ticket:done?gross/done:0,inventory_low:inventoryLow});
});
// Python owner.py employee access: only registered accounts can be added.
// A restaurant_employees membership is NOT a global auth role or a new
// source of API privileges; owner-only checks remain unchanged.
function employeeView(e:{
  id:number;userId:number;role:string;user:{name:string;email:string};
}){
  return {id:e.id,user_id:e.userId,name:e.user.name,
    email:e.user.email,role:e.role};
}
ownerRouter.get('/employees',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  const staff=await db.marketplaceRestaurantEmployee.findMany({
    where:{restaurantId:row.id},include:{user:{select:{name:true,email:true}}},
    orderBy:{id:'asc'},
  });
  res.setHeader('Cache-Control','private, no-store');
  res.json(staff.map(employeeView));
});
const employeeQuery=z.strictObject({
  email:z.string().trim().min(1).max(255),
  role:z.enum(['manager','cashier','kitchen']).default('cashier'),
});
ownerRouter.post('/employees',async(req,res)=>{
  const {row}=await ownRestaurant(req);
  // FastAPI parameters are QUERY arguments, not request JSON.
  const query=employeeQuery.safeParse(req.query);
  if(!query.success){
    const role=req.query.role;
    if(typeof role==='string'&&!['manager','cashier','kitchen'].includes(role))
      throw new RouteError(400,'Rol inválido');
    throw new RouteError(422,'Email y rol inválidos');
  }
  const email=query.data.email.toLowerCase();
  const employee=await db.authUser.findUnique({where:{email}});
  if(!employee)return notFound('Primero crea la cuenta del empleado');
  // Single PostgreSQL statement guarantees one row for concurrent invites;
  // Prisma's read+create upsert with nested include can surface a P2002 race.
  const saved=await db.$queryRaw<{id:number;user_id:number;role:string}[]>`
    INSERT INTO restaurant_employees(restaurant_id,user_id,role)
    VALUES (${row.id},${employee.id},${query.data.role})
    ON CONFLICT (restaurant_id,user_id) DO UPDATE SET role=EXCLUDED.role
    RETURNING id,user_id,role
  `;
  if(saved.length!==1)throw new RouteError(503,'No se pudo asignar el empleado');
  res.setHeader('Cache-Control','private, no-store');
  res.json({id:saved[0]!.id,user_id:saved[0]!.user_id,
    name:employee.name,email:employee.email,role:saved[0]!.role});
});

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
  const {account,row}=await ownRestaurant(req);
  const data=input(restaurantPatch,req.body);
  // Opening is only authorized for administratively verified merchants;
  // profile, menu and photo preparation remain possible while pending.
  if(data.is_open===true && row.verificationStatus!=='verified')
    throw new RouteError(403,'El comercio debe estar verificado antes de abrir');
  // Paid placement is platform-controlled; a restaurant cannot award itself
  // featured exposure by mutating its own profile.
  if(data.sponsored!==undefined && account.role!=='admin')
    throw new RouteError(403,'Destacados requiere autorización de administración');
  const changes:Record<string,unknown>={};
  for(const [key,value] of Object.entries(data)){
    const camel=key.replace(/_([a-z])/g,(_m,c:string)=>c.toUpperCase());
    changes[camel]=value;
  }
  const updated=await db.marketplaceRestaurant.update({where:{id:row.id},data:changes});
  res.json(restaurantPublic(updated));
});

// RC11.2 LIVE: real production catalog quote and driver availability, READ ONLY.
// This is NOT checkout permission; cash/card orders remain off until financial
// admission, dispatch, and delivery proofs are integrated in a separate release.
stageOrdersRouter.post('/delivery-quote',async(req,res)=>{
  const livePreview=config.NODE_ENV==='production'&&
    config.LIVE_DRIVER_PRESENCE_ENABLED==='true'&&
    config.MERCHANT_MANAGED_DELIVERY!=='true';
  const stagePreview=config.NODE_ENV==='staging'&&
    config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true';
  if(!livePreview&&!stagePreview)
    throw new RouteError(503,'Cotización a domicilio no habilitada');
  await user(req,['customer']);
  const schema=z.strictObject({
    restaurant_id:z.number().int().positive().safe(),
    order_type:z.literal('delivery'),
    payment_method:z.enum(['cash','stripe']),
    delivery_lat:z.number().finite().min(-90).max(90),
    delivery_lng:z.number().finite().min(-180).max(180),
    tip:z.union([z.string(),z.number()]).transform(String).default('0'),
    coupon_code:z.literal('').optional(),
    items:z.array(z.strictObject({
      menu_item_id:z.number().int().positive().safe(),
      quantity:z.number().int().min(1).max(50),
      options:z.literal('').optional(),
    })).min(1).max(100),
  });
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)throw new RouteError(422,'Datos de cotización inválidos');
  const data=parsed.data;
  if(livePreview&&data.payment_method==='stripe')
    throw new RouteError(503,'Tarjeta a domicilio LIVE pendiente de autorización financiera');
  if(stagePreview&&data.payment_method==='stripe'&&
     (config.STAGE_DELIVERY_STRIPE_TEST_ENABLED!=='true'||
      config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED!=='true'))
    throw new RouteError(503,'Tarjeta TEST a domicilio no habilitada');
  const restaurant=await db.marketplaceRestaurant.findUnique({
    where:{id:data.restaurant_id},
  });
  if(!restaurant||restaurant.verificationStatus!=='verified')
    throw new RouteError(404,'Restaurante no disponible');
  if(!restaurant.isOpen)throw new RouteError(409,'Restaurante cerrado');
  if(!['START','DELIVERY','PRO'].includes(restaurant.commercialPlan))
    throw new RouteError(503,'Política comercial no compatible');
  try{
    assertRestaurantDeliveryOrigin({lat:restaurant.lat,lng:restaurant.lng},
      restaurant.address);
    const geo=deliveryDistance({lat:restaurant.lat,lng:restaurant.lng},
      {lat:data.delivery_lat,lng:data.delivery_lng},restaurant.deliveryRadiusKm);
    const reachable=livePreview?
      await hasReachableLiveDriver({lat:restaurant.lat,lng:restaurant.lng}):
      await hasReachableStageDriver({lat:restaurant.lat,lng:restaurant.lng});
    if(!reachable)
      throw new RouteError(409,'No hay repartidores disponibles con ubicación actual');
    const products=await db.marketplaceMenuItem.findMany({
      where:{id:{in:data.items.map(i=>i.menu_item_id)},restaurantId:restaurant.id},
    });
    const policies=await db.stageSystemSetting.findMany({
      where:{key:{in:[
        'commercial_v152.restaurant_commission_rate',
        'commercial_v152.service_fee_rate',
        'commercial_v162.service_fee_rate',
        'commercial_v162.service_fee_cap',
      ]}},
    });
    const policy=config.COMMERCIAL_PRICING_V162_ENABLED==='true'?'v162':'v152';
    assertDefaultPickupRates(policies,policy);
    const catalog=products.map(i=>({
      id:i.id,restaurantId:i.restaurantId,name:i.name,
      price:i.price.toString(),stock:i.stock,isAvailable:i.isAvailable,
      optionsJson:i.optionsJson,priceScheduleJson:i.priceScheduleJson,
      availabilityScheduleJson:i.availabilityScheduleJson,
    }));
    const subtotalQuote=calculatePickupQuoteFromCatalog({
      restaurantId:restaurant.id,items:data.items,
      catalog,tip:'0',method:data.payment_method,policy,
    });
    const amount=subtotalQuote.subtotal.split('.');
    const subtotal=BigInt(amount[0]!)*100n+BigInt(amount[1]!);
    if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(data.tip))
      throw new PickupQuoteError(422,'Propina inválida');
    const tipParts=data.tip.split('.');
    const tip=BigInt(tipParts[0]!)*100n+
      BigInt(((tipParts[1]??'')+'00').slice(0,2));
    if(tip>1_000_000n)throw new PickupQuoteError(422,'Propina fuera de límite');
    const economics=calculateDefaultCommercial({
      policy,method:data.payment_method,fulfillment:'delivery',
      subtotal,discount:0n,tip,distanceMilliKm:geo.distanceMilliKm,
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json({
      currency:'MXN',order_type:'delivery',payment_method:data.payment_method,
      restaurant_id:restaurant.id,
      distance_method:'great_circle_rounded_up_0_001km',
      distance_km:geo.distanceKm,
      shipping_is_road_routing:false,
      commercial_pricing_version:policy==='v162'?'1.6.2':'1.5.2',
      subtotal:fmtCents(subtotal),discount:'0.00',
      delivery_fee:fmtCents(economics.deliveryFee),
      service_fee:fmtCents(economics.serviceFee),
      tip:fmtCents(tip),total:fmtCents(economics.total),
      driver_earning:fmtCents(economics.driverEarning),
      quote_is_binding:false,inventory_reserved:false,
      requires_revalidation_on_order:true,
      delivery_checkout_supported:stagePreview||(livePreview&&
        (liveCashDeliveryReleased()||liveDispatchReleased())),
      live_cash_delivery_supported:livePreview&&liveCashDeliveryReleased(),
      live_stripe_delivery_supported:livePreview&&liveDispatchReleased(),
      ...(livePreview?{live_driver_capacity_verified:true,
        preview_only:true,
        ...((liveCashDeliveryReleased()||liveDispatchReleased())?{}:{
          checkout_blocker:'LIVE_DELIVERY_CHECKOUT_NOT_RELEASED'})}:{}),
      driver_assignment_guaranteed:false,
    });
  }catch(err){
    if(err instanceof PickupQuoteError||err instanceof DeliveryGeoError)
      throw new RouteError(err.code,err.message);
    throw err;
  }
});

// Preview ONLY: user receives exact current catalog values and the same
// default commercial formula as POST /orders. This endpoint NEVER reserves
// products, starts Stripe, quotes delivery or implies live checkout approval.
stageOrdersRouter.post('/quote',async(req,res)=>{
  await user(req,['customer','admin']);
  const schema=z.strictObject({
    restaurant_id:z.number().int().positive().safe(),
    order_type:z.literal('pickup'),
    payment_method:z.enum(['cash','stripe']),
    items:z.array(z.strictObject({
      menu_item_id:z.number().int().positive().safe(),
      quantity:z.number().int().min(1).max(50),
      options:z.literal('').optional(),
    })).min(1).max(100),
    tip:z.union([z.string(),z.number()]).transform(String).default('0'),
    coupon_code:z.literal('').optional(),
    delivery_lat:z.null().optional(),
    delivery_lng:z.null().optional(),
  });
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)throw new RouteError(422,'Cotización pickup inválida');
  const body=parsed.data;
  const restaurant=await db.marketplaceRestaurant.findUnique({
    where:{id:body.restaurant_id},
  });
  if(!restaurant||restaurant.verificationStatus!=='verified')
    throw new RouteError(404,'Restaurante no encontrado');
  if(!restaurant.isOpen||!restaurant.pickupEnabled)
    throw new RouteError(409,'Restaurante no disponible para recoger');
  if(!['START','DELIVERY','PRO'].includes(restaurant.commercialPlan))
    throw new RouteError(503,'Política comercial personalizada no admitida');
  const ids=[...new Set(body.items.map(x=>x.menu_item_id))];
  const [products,policies]=await Promise.all([
    db.marketplaceMenuItem.findMany({
      where:{id:{in:ids},restaurantId:restaurant.id},
    }),
    db.stageSystemSetting.findMany({where:{key:{in:[
      'commercial_v152.restaurant_commission_rate',
      'commercial_v152.service_fee_rate',
      'commercial_v162.service_fee_rate',
      'commercial_v162.service_fee_cap',
    ]}}}),
  ]);
  const policy=config.COMMERCIAL_PRICING_V162_ENABLED==='true'?'v162':'v152';
  try{
    assertDefaultPickupRates(policies,policy);
    const quote=calculatePickupQuoteFromCatalog({
      restaurantId:restaurant.id,items:body.items,
      catalog:products.map(i=>({
        id:i.id,restaurantId:i.restaurantId,name:i.name,
        price:i.price.toString(),stock:i.stock,isAvailable:i.isAvailable,
        optionsJson:i.optionsJson,priceScheduleJson:i.priceScheduleJson,
        availabilityScheduleJson:i.availabilityScheduleJson,
      })),
      tip:body.tip,method:body.payment_method,policy,
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json(quote);
  }catch(err){
    if(err instanceof PickupQuoteError)throw new RouteError(err.code,err.message);
    throw err;
  }
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
  const cash=(isCashPickupIntent(req.body)&&cashPickupReleased())||
    (isStageCashDeliveryIntent(req.body)&&
     ((config.NODE_ENV==='staging'&&
       config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true')||
      liveCashDeliveryReleased()));
  const stageCard=(isStripePickupIntent(req.body)||
    (isStageStripeDeliveryIntent(req.body)&&
     config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&
     config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true'))&&
    config.NODE_ENV==='staging'&&config.STAGE_STRIPE_TEST_CHECKOUT_ENABLED==='true';
  const liveCard=(isStripePickupIntent(req.body)||
    (liveDispatchReleased()&&isStageStripeDeliveryIntent(req.body)))&&
    config.NODE_ENV==='production'&&config.STRIPE_LIVE_ENABLED==='true'&&
    config.STRIPE_FINANCIAL_WRITES_ENABLED==='true'&&
    config.STRIPE_LIVE_RELEASE_APPROVED==='true'&&
    config.STRIPE_MANUAL_SETTLEMENT_APPROVED==='true';
  if(!(cash||stageCard||liveCard)){
    res.status(503).json({detail:'Checkout de este tipo de pedido no habilitado'});
    return;
  }
  const account=await user(req,['customer','admin']);
  // RC8.12: do not accept new staging orders if the separate outbox,
  // Stripe TEST reconciliation or dispatch worker has stopped heartbeating.
  // Reading /ready alone does NOT prevent an app from posting an order.
  if(config.NODE_ENV==='staging')await requireStageCheckoutWorker();
  const orderId=await createStagePickupOrder(req.body,account);
  const created=await db.marketOrder.findUnique({
    where:{id:orderId},include:orderInclude,
  });
  if(!created)throw new RouteError(503,'Pedido transaccional no encontrado');
  res.setHeader('Cache-Control','private, no-store');
  res.status(201).json(orderView(created,true));
});
// Python owner.py /orders/{id}/complete: only cash pickup C1 in staging.
// Driver/merchant delivery completion remains disabled; no external capture.
const stageCompletePickup=z.strictObject({
  pin:z.string().regex(/^\d{4}$/),
  photo_url:z.string().max(600).default(''),
  lat:z.number().finite().min(-90).max(90).nullable().optional(),
  lng:z.number().finite().min(-180).max(180).nullable().optional(),
}).refine(v=>(v.lat==null)===(v.lng==null),{
  message:'lat y lng deben enviarse juntos',
});
ownerRouter.post('/orders/:orderId/complete',async(req,res)=>{
  const account=await user(req,['restaurant','admin']);
  const data=input(stageCompletePickup,req.body);
  const id=await completeCashPickupStage(idParam(req,'orderId'),account,data);
  const order=await db.marketOrder.findUnique({where:{id},include:orderInclude});
  if(!order)throw new RouteError(503,'Pedido de recogida no encontrado');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(order,false));
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
    where:{restaurantId:{in:ids},
      // Never show a pending Stripe reservation to the merchant as food to
      // prepare. Signed webhook is the only path to paymentStatus='paid'.
      OR:[{paymentMethod:'cash'},{paymentStatus:'paid'}],
      ...(activeOnly?{status:{notIn:['delivered','cancelled']}}:{})},
    include:orderInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:offset,take:limit,
  });
  res.json((await ownerProcessableOrders(rows)).map(x=>orderView(x,false)));
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
  for(const item of await ownerProcessableOrders(orders)) {
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
stageDriverRouter.get('/dashboard',async(req,res)=>{
  const account=await driverAccount(req);
  const result=await driverDashboard(account);
  res.setHeader('Cache-Control','private, no-store');
  res.json(result);
});
stageDriverRouter.get('/available',async(req,res)=>{
  const account=await driverAccount(req);
  const limit=z.coerce.number().int().min(1).max(100).safeParse(req.query.limit??25);
  if(config.NODE_ENV==='production'){
    if(!limit.success)throw new RouteError(422,'Límite inválido');
    res.setHeader('Cache-Control','private, no-store');
    res.json(await liveCashDriverOffers(account,limit.data));
    return;
  }
  if(config.STAGE_DRIVER_DELIVERY_ENABLED!=='true'){res.json([]);return;}
  if(!limit.success) throw new RouteError(422,'Límite inválido');
  const profile=await db.marketplaceDriverProfile.findUnique({where:{userId:account.id}});
  if(!profile?.isOnline||!profile.isVerified){res.json([]);return;}
  const active=await db.marketOrder.count({
    where:{driverId:account.id,status:{in:['assigned','picked_up','on_the_way']}},
  });
  if(active>0){res.json([]);return;}
  const orders=await db.marketOrder.findMany({
    where:{status:'ready',driverId:null,orderType:'delivery',
      OR:[{paymentMethod:'cash',paymentStatus:'pending'},
        ...(config.STAGE_DELIVERY_STRIPE_TEST_ENABLED==='true'?
          [{paymentMethod:'stripe',paymentStatus:'paid'}]:[])]},
    include:orderInclude,orderBy:[{updatedAt:'asc'},{id:'asc'}],take:limit.data,
  });
  const events=await db.stageOrderEvent.findMany({
    where:{orderId:{in:orders.map(x=>x.id)},status:'received'},
    select:{orderId:true,metadataJson:true},
  });
  const fixtureOrders=new Set(events.filter(e=>{
    try{
      const proof=JSON.parse(e.metadataJson);
      return proof.stage_driver_fixture===true||
        (config.NODE_ENV==='staging'&&
         config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&
         proof.stage_delivery_customer_v1===true&&
         /^[a-f0-9]{64}$/.test(proof.checkout_intent_hmac??''));
    }catch{return false;}
  }).map(e=>e.orderId));
  const realCustomerOrders=new Set(events.filter(e=>{
    try{
      const v=JSON.parse(e.metadataJson);
      return config.NODE_ENV==='staging'&&
        config.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED==='true'&&
        v.stage_delivery_customer_v1===true&&
        /^[a-f0-9]{64}$/.test(v.checkout_intent_hmac??'');
    }catch{return false;}
  }).map(e=>e.orderId));
  const publicMerchants=await db.marketplaceRestaurant.findMany({
    where:{id:{in:orders.filter(x=>realCustomerOrders.has(x.id)).map(x=>x.restaurantId)}},
    select:{id:true,name:true,address:true,lat:true,lng:true},
  });
  const merchantMap=new Map(publicMerchants.map(x=>[x.id,x]));
  // Drivers see only offers they can reach with FRESH Redis GPS, not a
  // stale PostgreSQL online toggle. Stripe offers require exact TEST ledger.
  const card=orders.filter(x=>x.paymentMethod==='stripe'&&
    realCustomerOrders.has(x.id));
  const cardReceipts=card.length?await db.stageFinancialLedgerEntry.findMany({
    where:{orderId:{in:card.map(x=>x.id)},kind:'stripe_test_payment',
      account:'stripe_test_collected'},
    select:{orderId:true,amount:true,direction:true,idempotencyKey:true},
  }):[];
  const verifiedCard=new Set(card.filter(x=>cardReceipts.some(r=>
    r.orderId===x.id&&r.direction==='credit'&&
    r.idempotencyKey==='order:'+x.id+':stripe-test:collected'&&
    r.amount.toFixed(2)===x.total.toFixed(2))).map(x=>x.id));
  const eligible:number[]=[];
  for(const order of orders){
    if(!fixtureOrders.has(order.id))continue;
    if(order.paymentMethod==='stripe'&&!verifiedCard.has(order.id))continue;
    if(realCustomerOrders.has(order.id)){
      const store=merchantMap.get(order.restaurantId);
      if(!store||!await canDriverReachPickup(account.id,
        {lat:store.lat,lng:store.lng}))continue;
    }
    eligible.push(order.id);
  }
  const allowed=new Set(eligible);
  res.setHeader('Cache-Control','private, no-store');
  res.json(orders.filter(x=>allowed.has(x.id)).map(x=>
    realCustomerOrders.has(x.id)?{
      // Dispatch offer must not disclose customer's address/phone/GPS to
      // all available drivers before one accepts the order.
      id:x.id,order_type:'delivery',status:x.status,restaurant_id:x.restaurantId,
      restaurant:merchantMap.get(x.restaurantId)??null,
      driver_earning:x.driverEarning.toString(),
      tip:x.tip.toString(),distance_km:x.distanceKm,
      total:x.total.toString(),
    }:orderView(x,false)));
});
stageDriverRouter.get('/presence-readiness',async(req,res)=>{
  const account=await driverAccount(req);
  const result=await driverPresenceReadiness(account);
  res.setHeader('Cache-Control','private, no-store');
  res.json(result);
});
stageDriverRouter.get('/profile',async(req,res)=>{
  const account=await driverAccount(req);
  const profile=await db.marketplaceDriverProfile.upsert({
    where:{userId:account.id},create:{userId:account.id,isVerified:false},update:{},
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
const driverAvailabilityInput=z.strictObject({is_online:z.boolean()});
const driverGpsInput=z.strictObject({
  lat:z.number().finite().min(-90).max(90),
  lng:z.number().finite().min(-180).max(180),
});
const driverStatusInput=z.strictObject({status:z.string().max(40)});
const driverCompleteInput=z.strictObject({
  pin:z.string().regex(/^\d{4}$/),
  photo_url:z.string().max(600).default(''),
  lat:z.number().finite().min(-90).max(90).nullable().optional(),
  lng:z.number().finite().min(-180).max(180).nullable().optional(),
}).refine(v=>(v.lat==null)===(v.lng==null));
stageDriverRouter.patch('/availability',async(req,res)=>{
  const actor=await driverAccount(req);
  const params=input(driverAvailabilityInput,req.body);
  const output=await driverAvailability(actor,params.is_online);
  res.setHeader('Cache-Control','private, no-store');
  res.json(output);
});
stageDriverRouter.patch('/location',async(req,res)=>{
  const actor=await driverAccount(req);
  const params=input(driverGpsInput,req.body);
  const output=await driverGps(actor,params.lat,params.lng);
  res.setHeader('Cache-Control','private, no-store');
  res.json(output);
});
stageDriverRouter.post('/orders/:orderId/accept',async(req,res)=>{
  const actor=await driverAccount(req);
  const id=await driverAccept(actor,idParam(req,'orderId'));
  const result=await db.marketOrder.findUnique({
    where:{id},include:orderInclude,
  });
  if(!result)throw new RouteError(503,'Pedido asignado no encontrado');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(result,false));
});
stageDriverRouter.patch('/orders/:orderId/status',async(req,res)=>{
  const actor=await driverAccount(req);
  const body=input(driverStatusInput,req.body);
  const id=await driverStatus(actor,idParam(req,'orderId'),body.status);
  const result=await db.marketOrder.findUnique({where:{id},include:orderInclude});
  if(!result)throw new RouteError(503,'Pedido en ruta no encontrado');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(result,false));
});
stageDriverRouter.post('/orders/:orderId/complete',async(req,res)=>{
  const actor=await driverAccount(req);
  const body=input(driverCompleteInput,req.body);
  const id=await driverComplete(actor,idParam(req,'orderId'),body);
  const result=await db.marketOrder.findUnique({where:{id},include:orderInclude});
  if(!result)throw new RouteError(503,'Entrega finalizada no encontrada');
  res.setHeader('Cache-Control','private, no-store');
  res.json(orderView(result,false));
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
