// J1: final missing Python HTTP contracts; stage only. Explicit no-go for
// absent PSP/settlement/transfer implementations. No fake "success".
import {Router,type Request,type Response,type NextFunction} from 'express';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {db} from '../db.js';
import {account,bad,param} from '../operational/routes.js';
import {config} from '../config.js';

export const parityRouter=Router();
const euro=(v:{toFixed:(n:number)=>string})=>v.toFixed(2);
const fmt=(v:bigint)=>{const x=v<0n?-v:v;return (v<0n?'-':'')+(x/100n).toString()+'.'+(x%100n).toString().padStart(2,'0');};
const minor=(v:{toFixed:(n:number)=>string})=>{
 const [a,b='00']=v.toFixed(2).split('.');
 return BigInt(a!)*100n+BigInt(b);
};
const vparse=<T extends z.ZodTypeAny>(scheme:T,body:unknown):z.output<T>=>{
 const out=scheme.safeParse(body);
 if(!out.success)return bad(422,'Datos inválidos');
 return out.data;
};
const qNum=(req:Request,key:string,def:number,min:number,max:number)=>{
 const raw=req.query[key];
 if(raw===undefined)return def;
 if(typeof raw!=='string'||!/^(0|[1-9]\d*)$/.test(raw)||
  !Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)
  return bad(422,'Parámetro numérico inválido');
 return Number(raw);
};
const qString=(req:Request,key:string,def='')=>{
 const v=req.query[key];return typeof v==='string'?v:def;
};
const memoPrivate=(res:Response)=>res.setHeader('Cache-Control','private, no-store');
const financialUnavailable=(_why:string):never=>bad(503,
 'Operación financiera no disponible: faltan integración TEST, ledger, firma, reconciliación y controles de despliegue');
async function ownOrder(id:number,who:{id:number;role:string}){
 const o=await db.marketOrder.findUnique({where:{id},include:{restaurant:true}});
 if(!o)return bad(404,'Pedido no encontrado');
 if(who.role!=='admin'&&o.userId!==who.id&&o.driverId!==who.id&&
  !(who.role==='restaurant'&&o.restaurant.ownerId===who.id))return bad(403,'Pedido ajeno');
 return o;
}
async function payee(req:Request){
 const who=await account(req);
 const role=String(req.params.role??''),
  identifier=param(req,'recipientId');
 if(!['restaurant','driver'].includes(role))return bad(422,'Beneficiario inválido');
 if(who.role==='admin')return {role,identifier,who};
 if(role==='driver'&&(who.role!=='driver'||identifier!==who.id))
  return bad(403,'Sin acceso a saldos ajenos');
 if(role==='restaurant'){
  if(who.role!=='restaurant')return bad(403,'Sin acceso');
  const shop=await db.marketplaceRestaurant.findUnique({where:{id:identifier}});
  if(!shop||shop.ownerId!==who.id)return bad(403,'Sin acceso a comercio ajeno');
 }
 return {role,identifier,who};
}
// Public capabilities: don't copy historical Python feature descriptions that
// incorrectly describe Node integrations as already shipped.
parityRouter.get('/platform/features',(_req,res)=>{
 res.json({version:'0.1.0-node-stage',feature_count:8,features:[
  {id:1,name:'Catálogo local',area:'catalog',mode:'staging',description:'Restaurantes y productos en PostgreSQL'},
  {id:2,name:'Órdenes con efectivo y recoger',area:'checkout',
   mode:config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true'?'staging':'disabled',
   description:'Sólo pedidos de prueba con efectivo y recoger'},
  {id:3,name:'Comercio y KDS',area:'merchant',mode:'staging',description:'Acciones con autorización'},
  {id:4,name:'Repartidores',area:'driver',
   mode:config.STAGE_DRIVER_DELIVERY_ENABLED==='true'?'staging':'disabled',
   description:'Despacho limitado a entregas cash sintéticas'},
  {id:5,name:'Wallet y puntos',area:'loyalty',mode:'restricted',description:'Sin pasarela de monetización real'},
  {id:6,name:'Pagos digitales',area:'payment',mode:'disabled',description:'Stripe TEST pendiente; ningún otro PSP'},
  {id:7,name:'Retiros y conciliación',area:'finance',mode:'disabled',description:'Sin transferencias financieras reales'},
  {id:8,name:'Media',area:'uploads',mode:'staging',description:'Almacenamiento restringido a laboratorio'}]});
});
parityRouter.get('/orders/payment-methods',async(req,res)=>{
 await account(req);
 const cashEnabled=config.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true';
 res.setHeader('Cache-Control','private, no-store');
 res.json({digital_provider:'stripe',cash_available_in_staging:cashEnabled,methods:[
  {id:'cash',label:'Efectivo',enabled:cashEnabled,mode:'stage-cash-pickup',
   ...(cashEnabled?{}:{reason:'staging-cash-pickup-disabled'})},
  {id:'stripe',label:'Tarjeta (Stripe)',enabled:false,reason:'stripe-test-payments-not-yet-implemented'},
  {id:'wallet',label:'Wallet',enabled:false,reason:'wallet-not-reconciled'}],
  production_ready:false});
});
parityRouter.get('/payments/config',(_req,res)=>{
 res.json({provider:'stripe',digital_providers:['stripe'],enabled:false,
  publishable_key:null,checkout_ready:false,financial_writes_enabled:false,
  environment:'staging'});
});
parityRouter.get('/payments/stripe/config',(_req,res)=>{
 res.json({provider:'stripe',enabled:false,
  publishable_key:null,checkout_ready:false,
  financial_writes_enabled:false,environment:'staging'});
});
parityRouter.get('/operations/admin/commercial-pricing',async(req,res)=>{
 await account(req,['admin']);
 const keys=await db.stageSystemSetting.findMany({where:{key:{startsWith:'commercial_v162.'}}});
 const map=new Map(keys.map(x=>[x.key,x.value]));
 memoPrivate(res);
 res.json({policy_version:'node-stage-no-live-financial-parity',enabled:false,
  restaurant_commission_rate:map.get('commercial_v162.restaurant_commission_rate')??'0.15',
  service_fee_rate:map.get('commercial_v162.service_fee_rate')??'0.07',
  base_delivery_fee:map.get('commercial_v162.base_delivery_fee')??'39.00',
  base_driver_pay:map.get('commercial_v162.base_driver_pay')??'32.00',
  tips_fee_rate:'0',
  service_fee_basis:'subtotal_minus_discount_without_shipping_or_tip',
  legacy_restaurant_rates_retained_for_rollback:true,
  stage_notice:'Illustrative read-only policy; not a verified production pricing engine'});
});
parityRouter.patch('/operations/admin/restaurants/:restaurantId/commercial',async(req,res)=>{
 const who=await account(req,['admin']),id=param(req,'restaurantId');
 const p=vparse(z.strictObject({
  commercial_plan:z.enum(['START','PRO','ENTERPRISE']).optional(),
  commission_rate:z.number().min(0).max(.5).optional(),
  service_fee_rate:z.number().min(0).max(.5).optional(),
  service_fee_fixed:z.number().min(0).max(100).optional(),
 }),req.body);
 const row=await db.$transaction(async tx=>{
  const o=await tx.marketplaceRestaurant.findUnique({where:{id}});
  if(!o)return bad(404,'Restaurante no encontrado');
  const v=await tx.marketplaceRestaurant.update({where:{id},data:{
   ...(p.commercial_plan?{commercialPlan:p.commercial_plan}:{}),
   ...(p.commission_rate!==undefined?{commissionRate:p.commission_rate}:{}),
   ...(p.service_fee_rate!==undefined?{serviceFeeRate:p.service_fee_rate}:{}),
   ...(p.service_fee_fixed!==undefined?{serviceFeeFixed:p.service_fee_fixed}:{})}});
  await tx.authAuditEvent.create({data:{userId:who.id,
   action:'commercial.update.stage',entityType:'restaurant',
   entityId:String(id),detail:'staging price columns only'}});
  return v;
 });
 res.json({id,commercial_plan:row.commercialPlan,
  commission_rate:row.commissionRate.toFixed(4),
  service_fee_rate:row.serviceFeeRate.toFixed(4),
  service_fee_fixed:euro(row.serviceFeeFixed),
  stage_notice:'No retroactive settlement or production pricing implications'});
});
parityRouter.get('/operations/admin/sla',async(req,res)=>{
 await account(req,['admin']);
 const orders=await db.marketOrder.findMany({where:{status:'delivered'},
  select:{acceptedAt:true,createdAt:true,deliveredAt:true},take:10000});
 const durations=orders.flatMap(x=>x.deliveredAt?
  [Math.max(0,(x.deliveredAt.getTime()-x.createdAt.getTime())/60000)]:[]);
 const avg=durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:0;
 memoPrivate(res);
 res.json({delivered_orders:durations.length,
  avg_delivery_minutes:Number(avg.toFixed(2)),p95_delivery_minutes:durations.length?
   Number(durations.sort((a,b)=>a-b)[Math.ceil(.95*durations.length)-1]!.toFixed(2)):null,
  sampled:orders.length<10000});
});
parityRouter.get('/withdrawals/:role/:recipientId/balance',async(req,res)=>{
 const {role,identifier}=await payee(req);
 const payouts=await db.opsPayout.findMany({where:{payeeType:role,payeeId:identifier},
  orderBy:{createdAt:'desc'},take:10000});
 const outstanding=payouts.filter(x=>x.status==='pending').reduce(
  (n,x)=>n+minor(x.amount),0n);
 memoPrivate(res);
 res.json({role,recipient_id:identifier,
  currency:'MXN',pending_payouts:fmt(outstanding),
  available_for_withdrawal:'0.00',provider:'not-configured',
  reconciliation_hold:true,eligible:false,
  reason:'Stripe Connect proof of available balance not verified; cannot transfer'});
});
parityRouter.get('/withdrawals/:role/:recipientId/history',async(req,res)=>{
 const {role,identifier}=await payee(req);
 const rows=await db.opsPayout.findMany({where:{payeeType:role,payeeId:identifier},
  orderBy:{createdAt:'desc'},take:200});
 memoPrivate(res);
 res.json({role,recipient_id:identifier,payouts:rows.map(x=>({
  id:x.id,amount:euro(x.amount),currency:x.currency,status:x.status,
  provider:x.provider,provider_ref:x.providerRef,
  created_at:x.createdAt.toISOString(),paid_at:x.paidAt?.toISOString()??null}))});
});
parityRouter.get('/withdrawals/:role/:recipientId/connect/status',async(req,res)=>{
 const {role,identifier}=await payee(req);
 memoPrivate(res);
 res.json({role,recipient_id:identifier,provider:'stripe-connect',
  connected:false,charges_enabled:false,payouts_enabled:false,
  details_submitted:false,configuration:'disabled-node-staging'});
});
parityRouter.get('/withdrawals/connect/finish',(_req,res)=>{
 res.status(403).json({detail:'OAuth/Connect return token unverified; finish disabled on Node staging'});
});


// Payments and settlements: explicit fail-closed boundaries. Unlike returning
// fake 200s, we never acknowledge provider events without PSP signature,
// reservation, ledger postings, external verification and durable reconcile.
parityRouter.post('/payments/stripe/orders/:orderId/payment-intent',async(req)=>{
 await account(req);param(req,'orderId');
 return financialUnavailable('stripe_payment_intent');
});
parityRouter.post('/payments/stripe/webhook',async()=>{
 // A separate signed webhook at /api/v1/webhooks/stripe exists in the base
 // stack but is not equivalent to the Python payment capture contract.
 return financialUnavailable('stripe_webhook_is_not_payment_settlement');
});
parityRouter.post('/payments/stripe/admin/orders/:orderId/refund',async(req)=>{
 await account(req,['admin']);param(req,'orderId');
 return financialUnavailable('stripe_refund');
});
parityRouter.get('/payments/stripe/admin/orders/:orderId/settlement-preview',async(req,res)=>{
 await account(req,['admin']);
 const id=param(req,'orderId');
 const order=await db.marketOrder.findUnique({where:{id},include:{restaurant:true}});
 if(!order)return bad(404,'Pedido no encontrado');
 memoPrivate(res);
 res.json({order_id:id,payment_provider:order.paymentProvider,
  payment_status:order.paymentStatus,order_status:order.status,
  gmv:euro(order.total),restaurant_payout:euro(order.restaurantPayout),
  platform_commission:euro(order.platformCommission),
  delivery_fee:euro(order.deliveryFee),driver_earning:euro(order.driverEarning),
  tip:euro(order.tip),pending_refund:euro(order.refundedAmount),
  eligibility:'reconciliation-hold',
  reason:'No verifiable Stripe Connect charge/transfer balance from Node staging',
  can_settle:false});
});
parityRouter.put('/payments/stripe/admin/recipients/:role/:entityId',async(req)=>{
 await account(req,['admin']);
 const role=String(req.params.role),id=param(req,'entityId');
 if(!['driver','restaurant'].includes(role))return bad(422,'Beneficiario no permitido');
 void id;
 return financialUnavailable('stripe_connected_recipient_write');
});
parityRouter.post('/payments/stripe/admin/orders/:orderId/settle',async(req)=>{
 await account(req,['admin']);param(req,'orderId');
 return financialUnavailable('stripe_split_settlement');
});
parityRouter.post('/withdrawals/:role/:recipientId/request',async(req)=>{
 await payee(req);
 return financialUnavailable('withdrawal_requires_verified_ledger_and_provider');
});
parityRouter.post('/withdrawals/stripe-connect/webhook',async()=>{
 return financialUnavailable('stripe_connect_webhook_signed_provider_and_hold');
});
parityRouter.post('/withdrawals/:role/:recipientId/connect/onboarding',async(req)=>{
 await payee(req);
 return financialUnavailable('stripe_connect_oauth_provider_required');
});
parityRouter.post('/operations/admin/payouts/run',async(req)=>{
 await account(req,['admin']);
 qNum(req,'days',7,1,31);
 return financialUnavailable('payout_batch_generation_reconciled_cash_receipts_missing');
});
parityRouter.post('/operations/admin/payouts/:payoutId/mark-paid',async(req)=>{
 await account(req,['admin']);
 param(req,'payoutId');
 return financialUnavailable('manual_mark_paid_requires_bank_document_verified');
});
parityRouter.post('/operations/admin/cash-settlements/run',async(req)=>{
 await account(req,['admin']);qNum(req,'days',1,1,31);
 return financialUnavailable('cash_receipt_matching_not_reconciled');
});
parityRouter.patch('/operations/admin/cash-settlements/:settlementId',async(req)=>{
 await account(req,['admin']);param(req,'settlementId');
 return financialUnavailable('settlement_manual_acknowledgement_unverified');
});
parityRouter.post('/operations/plus/subscribe',async(req)=>{
 await account(req,['customer']);
 return financialUnavailable('plus_subscription_without_verified_charge');
});
parityRouter.post('/platform/plus/subscribe',async(req)=>{
 await account(req,['customer']);
 return financialUnavailable('platform_plus_without_verified_charge');
});
parityRouter.post('/platform/rewards/redeem',async(req)=>{
 await account(req,['customer']);
 return financialUnavailable('points_conversion_to_money_immutable_ledger_missing');
});
parityRouter.post('/platform/gift-cards/redeem',async(req)=>{
 await account(req,['customer','admin']);
 return financialUnavailable('gift_card_liability_reconciliation_missing');
});
parityRouter.post('/admin/wallet/:userId/adjust',async(req)=>{
 await account(req,['admin']);param(req,'userId');
 return financialUnavailable('manual_wallet_adjustment_ledger_missing');
});
parityRouter.post('/v11/admin/orders/:orderId/partial-refund',async(req)=>{
 await account(req,['admin']);param(req,'orderId');
 return financialUnavailable('partial_refund_provider_verified_postings_missing');
});
parityRouter.post('/v11/admin/payouts/dispatch',async(req)=>{
 await account(req,['admin']);
 return financialUnavailable('payout_dispatch_provider_not_configured');
});
parityRouter.post('/v11/payouts/webhook',async()=>{
 return financialUnavailable('payout_provider_signature_not_configured');
});
parityRouter.post('/v9/admin/corporate/:accountId/settle',async(req)=>{
 await account(req,['admin']);param(req,'accountId');
 return financialUnavailable('corporate_invoice_and_bank_payment_unverified');
});
parityRouter.post('/resilience/payments/reconcile',async(req)=>{
 await account(req,['admin']);
 return financialUnavailable('PSP_oracle_not_configured');
});
parityRouter.post('/resilience/outbox/drain',async(req)=>{
 await account(req,['admin']);
 // Never mark messages processed just to simulate that a webhook got delivered.
 return bad(503,'Outbox de Node sin publicador ni DLQ real de consumo verificados');
});


// Referral is pending, never applies reward until a verified eligible delivery.
parityRouter.post('/operations/referrals/apply',async(req,res)=>{
 const who=await account(req,['customer']);
 const code=qString(req,'code').trim().toUpperCase();
 if(!/^[A-Z0-9_-]{4,30}$/.test(code))return bad(400,'Código de referido inválido');
 const found=await db.authLoyaltyAccount.findUnique({where:{referralCode:code}});
 if(!found||found.userId===who.id)return bad(400,'Código de referido inválido');
 const row=await db.stageReferralConversion.createMany({data:[{
  referrerUserId:found.userId,referredUserId:who.id,referralCode:code,
  rewardAmount:'0',status:'pending'}],skipDuplicates:true});
 if(!row.count)return bad(409,'Ya aplicaste un referido');
 res.status(200).json({status:'pending',
  message:'El beneficio se libera después del primer pedido entregado válido y conciliado.',
  reward:'0.00',reconciliation_hold:true});
});
// Driver offers: cash-delivery staging only, with profile-first row locks.
const offerView=(x:{id:number;orderId:number;roundNo:number;
 score:number;estimatedPickupMin:number;
 estimatedEarning:{toFixed:(n:number)=>string};
 status:string;expiresAt:Date})=>({
 id:x.id,order_id:x.orderId,round:x.roundNo,score:x.score,
 estimated_pickup_min:x.estimatedPickupMin,
 estimated_earning:x.estimatedEarning.toFixed(2),
 status:x.status,expires_at:x.expiresAt.toISOString()});
parityRouter.get('/v11/driver/offers',async(req,res)=>{
 const who=await account(req,['driver']);
 const now=new Date();
 const list=await db.stageDriverOffer.findMany({
  where:{driverId:who.id,status:'offered',expiresAt:{gt:now}},
  orderBy:{offeredAt:'desc'},take:30});
 memoPrivate(res);res.json(list.map(offerView));
});
parityRouter.post('/v11/admin/driver-offers/:orderId/create',async(req,res)=>{
 const who=await account(req,['admin']),id=param(req,'orderId');
 const now=new Date();
 const offers=await db.$transaction(async tx=>{
  await tx.$queryRawUnsafe('SELECT id FROM orders WHERE id=$1 FOR UPDATE',id);
  const order=await tx.marketOrder.findUnique({where:{id}});
  if(!order||order.status!=='ready'||order.driverId!==null)
   return bad(409,'Pedido no disponible');
  if(order.orderType!=='delivery'||order.paymentMethod!=='cash')
   return bad(503,'Las ofertas sólo admiten entregas en efectivo de staging');
  const profiles=await tx.marketplaceDriverProfile.findMany({
   where:{isOnline:true,isVerified:true,user:{isActive:true,role:'driver'}},
   include:{user:true},take:80});
  const active=await tx.marketOrder.findMany({
   where:{driverId:{in:profiles.map(x=>x.userId)},
    status:{in:['assigned','picked_up','on_the_way']}},
   select:{driverId:true}});
  const busy=new Set(active.map(x=>x.driverId));
  const prior=await tx.stageDriverOffer.findFirst({where:{orderId:id},
   orderBy:{roundNo:'desc'}});
  const round=(prior?.roundNo??0)+1;
  const candidates=profiles.filter(x=>!busy.has(x.userId)).map(p=>{
   return {user:p,score:Number(p.rating),eta:15};
  }).sort((a,b)=>b.score-a.score).slice(0,5);
  const created=[];
  for(const selected of candidates){
   const x=await tx.stageDriverOffer.create({data:{
    orderId:id,driverId:selected.user.userId,roundNo:round,
    score:selected.score,estimatedPickupMin:selected.eta,
    estimatedEarning:order.driverEarning,
    expiresAt:new Date(now.getTime()+45000)}});
   await tx.authNotification.create({data:{userId:x.driverId,kind:'delivery',
    title:'Nueva oferta de entrega',message:'Pedido #'+id+' disponible durante 45 segundos.'}});
   created.push(x);
  }
  await tx.authAuditEvent.create({data:{userId:who.id,action:'v11.driver.offer.create',
   entityType:'order',entityId:String(id),detail:'offered='+created.length}});
  return {order_id:id,round,created:created.length};
 },{maxWait:10000,timeout:20000});
 res.json(offers);
});
parityRouter.post('/v11/driver/offers/:offerId/respond',async(req,res)=>{
 const who=await account(req,['driver']),id=param(req,'offerId');
 const p=vparse(z.strictObject({action:z.enum(['accept','reject'])}),req.body);
 const decision=await db.$transaction(async tx=>{
  const lock=await tx.$queryRawUnsafe(
   'SELECT user_id FROM driver_profiles WHERE user_id=$1 FOR UPDATE',who.id);
  if(!Array.isArray(lock)||!lock.length)return bad(403,'Perfil de repartidor no disponible');
  const profile=await tx.marketplaceDriverProfile.findUnique({where:{userId:who.id}});
  if(!profile?.isOnline||!profile.isVerified)return bad(403,'Repartidor no habilitado');
  const offer=await tx.stageDriverOffer.findUnique({where:{id}});
  if(!offer||offer.driverId!==who.id)return bad(404,'Oferta no encontrada');
  if(offer.status!=='offered'||offer.expiresAt<=new Date())
   return bad(409,'Oferta vencida o respondida');
  await tx.$queryRawUnsafe('SELECT id FROM orders WHERE id=$1 FOR UPDATE',offer.orderId);
  const order=await tx.marketOrder.findUnique({where:{id:offer.orderId}});
  if(!order||order.status!=='ready'||order.driverId!==null)
   return bad(409,'El pedido ya fue asignado');
  if(p.action==='accept'){
   const active=await tx.marketOrder.count({where:{driverId:who.id,
    status:{in:['assigned','picked_up','on_the_way']}}});
   if(active)return bad(409,'Ya tienes entrega activa');
   await tx.marketOrder.update({where:{id:order.id},data:{
    status:'assigned',driverId:who.id}});
   await tx.stageOrderEvent.create({data:{orderId:order.id,
    actorUserId:who.id,status:'assigned',
    metadataJson:JSON.stringify({source:'v11_offer',offer_id:id})}});
   await tx.stageEventOutbox.create({data:{aggregateType:'order',
    aggregateId:String(order.id),eventType:'order.assigned',
    eventKey:'offer:'+id+':accepted',
    payloadJson:JSON.stringify({driver_id:who.id,order_id:order.id})}});
  }
  await tx.stageDriverOffer.update({where:{id},data:{
   status:p.action==='accept'?'accepted':'rejected',respondedAt:new Date()}});
  if(p.action==='accept')await tx.stageDriverOffer.updateMany({where:{
   orderId:order.id,id:{not:id},status:'offered'},data:{
    status:'expired',respondedAt:new Date()}});
  return {offer_id:id,order_id:order.id,status:p.action==='accept'?'accepted':'rejected'};
 },{maxWait:10000,timeout:20000});
 res.json(decision);
});
parityRouter.post('/v9/admin/dispatch/:orderId/reassign',async(req,res)=>{
 const who=await account(req,['admin']),id=param(req,'orderId');
 const order=await db.marketOrder.findUnique({where:{id}});
 if(!order)return bad(404,'Pedido no encontrado');
 if(!['ready','assigned'].includes(order.status)||order.paymentMethod!=='cash')
  return bad(409,'No se puede reasignar este pedido');
 const old=order.driverId;
 const candidate=await db.marketplaceDriverProfile.findMany({
  where:{isOnline:true,isVerified:true,user:{role:'driver',isActive:true},
   userId:{not:old??-1}},orderBy:{rating:'desc'},take:25});
 const result=await db.$transaction(async tx=>{
  for(const c of candidate){
   const rows=await tx.$queryRawUnsafe(
    'SELECT user_id FROM driver_profiles WHERE user_id=$1 FOR UPDATE SKIP LOCKED',
    c.userId);
   if(!Array.isArray(rows)||!rows.length)continue;
   if(await tx.marketOrder.count({where:{driverId:c.userId,
    status:{in:['assigned','picked_up','on_the_way']}}}))continue;
   const changed=await tx.marketOrder.updateMany({where:{
    id,status:{in:['ready','assigned']},driverId:old},
    data:{driverId:c.userId,status:'assigned'}});
   if(!changed.count)return bad(409,'El pedido cambió de estado');
   await tx.opsIncident.create({data:{orderId:id,
    incidentType:'auto_reassignment',severity:'medium',
    title:'Reasignación automática',detail:'Anterior '+String(old),
    recommendedAction:'Seguimiento de nueva recogida',
    status:'resolved',resolvedAt:new Date()}});
   await tx.stageOrderEvent.create({data:{orderId:id,actorUserId:who.id,
    status:'assigned',metadataJson:JSON.stringify({
     source:'v9_reassign',previous_driver:old})}});
   return {order_id:id,previous_driver:old,driver:{driver_id:c.userId,
    rating:Number(c.rating)}};
  }
  return bad(409,'No hay otro repartidor disponible');
 });
 res.json(result);
});


// Fixed staging origin avoids Host/X-Forwarded-Host injection into asset URLs.
// The Flutter Restaurante client requires an HTTPS URL for public catalog media.
const STAGE_CATALOG_ORIGIN='https://api-stage-talaeats.alan-palacios-dev.com';
const catalogAbsoluteUrl=(filename:string)=>STAGE_CATALOG_ORIGIN+'/api/v1/uploads/catalog/'+filename;

// Files J1: bounded single-file multipart, magic bytes, private owner/assignment.
// No base64-in-JSON workaround; maintains real upload binary contracts.
const ROOT=path.resolve(process.env.TALA_NODE_STAGE_MEDIA_DIR||
 '/tmp/tala-node-stage-media');
if(!(ROOT==='/tmp/tala-node-stage-media'||
 ROOT.startsWith('/tmp/tala-node-stage-media/')||
 ROOT==='/home/tala-node-stage/media'||
 ROOT.startsWith('/home/tala-node-stage/media/')))
 throw new Error('NODE_STAGE_MEDIA_MUST_BE_ISOLATED');
const TYPES:Record<string,{ext:string;magic:(p:Buffer)=>boolean}>={
 'image/jpeg':{ext:'.jpg',magic:x=>x.subarray(0,3).equals(Buffer.from([255,216,255]))},
 'image/png':{ext:'.png',magic:x=>x.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))},
 'image/webp':{ext:'.webp',magic:x=>x.subarray(0,4).toString()==='RIFF'&&
  x.subarray(8,12).toString()==='WEBP'},
 'application/pdf':{ext:'.pdf',magic:x=>x.subarray(0,5).toString()==='%PDF-'},
};
const fnOk=(s:string)=>/^[a-zA-Z0-9_-]{12,130}\.(jpg|png|webp|pdf)$/.test(s);
const MAX_BYTES=5*1024*1024;
async function singleUpload(req:Request,pdf=false){
 const type=req.header('content-type')??'';
 const marker=type.match(/^multipart\/form-data;\s*boundary=(?:"([^"]{1,80})"|([^;\s]{1,80}))(?:\s*;.*)?$/i);
 const boundary=marker?.[1]??marker?.[2];
 if(!boundary||!/^[a-zA-Z0-9'()+_,./:=?-]{1,80}$/.test(boundary))
  return bad(415,'Se requiere multipart/form-data válido');
 const parts:Buffer[]=[];let size=0;
 for await(const chunk of req){
  const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);
  size+=data.length;if(size>MAX_BYTES+8192)return bad(413,'Archivo excede 5 MB');
  parts.push(data);
 }
 const body=Buffer.concat(parts);
 const delim=Buffer.from('--'+boundary),start=body.indexOf(delim);
 if(start!==0)return bad(400,'Multipart inválido');
 const headerStart=delim.length+2,headerEnd=body.indexOf(Buffer.from('\r\n\r\n'),headerStart);
 if(headerEnd<0||headerEnd-headerStart>4096)return bad(400,'Cabeceras de archivo inválidas');
 const head=body.subarray(headerStart,headerEnd).toString('latin1');
 if(!/\bname="file"/.test(head)||!/\bfilename="[^"\r\n]{1,200}"/.test(head))
  return bad(400,'Falta campo file');
 const mime=head.match(/content-type:\s*([a-z0-9/+-]+)/i)?.[1]?.toLowerCase();
 const spec=mime?TYPES[mime]:undefined;
 if(!spec||(!pdf&&mime==='application/pdf'))return bad(415,'Formato de archivo no permitido');
 const contentStart=headerEnd+4,
  end=body.indexOf(Buffer.from('\r\n--'+boundary),contentStart);
 if(end<contentStart)return bad(400,'Multipart sin cierre');
 const tail=body.subarray(end).toString('latin1');
 if(!tail.startsWith('\r\n--'+boundary+'--'))return bad(400,'Sólo se admite un archivo');
 const file=body.subarray(contentStart,end);
 if(file.length===0||file.length>MAX_BYTES)return bad(413,'Archivo vacío o demasiado grande');
 if(!spec.magic(file))return bad(415,'La firma del archivo no coincide');
 return {file,mime:mime!,ext:spec.ext};
}
async function saveMedia(req:Request,owner:number,category:string,
 prefix:string,opts:{pdf?:boolean;orderId?:number;restaurantId?:number;menuItemId?:number}={}){
 const data=await singleUpload(req,opts.pdf);
 const filename=prefix+'-'+randomBytes(24).toString('base64url')+data.ext;
 const dir=path.join(ROOT,category);
 await mkdir(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,filename);
 await writeFile(file,data.file,{flag:'wx',mode:0o600});
 try{
  const asset=await db.stageMediaAsset.create({data:{
   filename,category,userId:owner,mime:data.mime,bytes:data.file.length,
   orderId:opts.orderId??null,restaurantId:opts.restaurantId??null,
   menuItemId:opts.menuItemId??null}});
  return asset;
 }catch(e){await unlink(file).catch(()=>{});throw e;}
}
async function mediaResponse(res:Response,category:string,name:string,publicCache=false){
 if(!fnOk(name))return bad(400,'Nombre de archivo inválido');
 const asset=await db.stageMediaAsset.findUnique({where:{filename:name}});
 if(!asset||asset.category!==category)return bad(404,'Archivo no encontrado');
 let bytes:Buffer;
 try{bytes=await readFile(path.join(ROOT,category,name));}catch{return bad(404,'Archivo no encontrado');}
 res.setHeader('Cache-Control',publicCache?'public, max-age=31536000, immutable':'private, no-store');
 res.type(asset.mime);res.send(bytes);
}
async function ownsRestaurant(user:{id:number;role:string}){
 if(user.role!=='restaurant')return bad(403,'Se requiere cuenta de restaurante');
 const shop=await db.marketplaceRestaurant.findFirst({where:{ownerId:user.id}});
 if(!shop)return bad(404,'Restaurante no encontrado');
 return shop;
}
parityRouter.post('/uploads/delivery-proof',async(req,res)=>{
 const who=await account(req,['driver','admin']);
 const asset=await saveMedia(req,who.id,'delivery-proofs','d');
 res.status(200).json({url:'/api/v1/uploads/delivery-proof/'+asset.filename});
});
parityRouter.get('/uploads/delivery-proof/:filename',async(req,res)=>{
 const who=await account(req);const name=String(req.params.filename??'');
 const asset=await db.stageMediaAsset.findUnique({where:{filename:name}});
 if(who.role!=='admin'){
  const proof=await db.stageDeliveryProof.findFirst({
   where:{photoUrl:'/api/v1/uploads/delivery-proof/'+name}});
  if(!proof)return bad(403,'Evidencia no asociada a una entrega');
  await ownOrder(proof.orderId,who);
 }
 if(!asset)return bad(404,'Archivo no encontrado');
 await mediaResponse(res,'delivery-proofs',name);
});
parityRouter.post('/uploads/onboarding-document',async(req,res)=>{
 const who=await account(req);
 const asset=await saveMedia(req,who.id,'onboarding','u'+who.id,{pdf:true});
 res.json({url:'/api/v1/uploads/onboarding-document/'+asset.filename,
  name:asset.filename});
});
parityRouter.get('/uploads/onboarding-document/:filename',async(req,res)=>{
 const who=await account(req),name=String(req.params.filename??'');
 const asset=await db.stageMediaAsset.findUnique({where:{filename:name}});
 if(!asset||asset.category!=='onboarding')return bad(404,'Documento no encontrado');
 if(who.role!=='admin'){
  if(asset.userId!==who.id||!name.startsWith('u'+who.id+'-'))
   return bad(403,'Documento ajeno');
  const applications=await db.opsOnboarding.findMany({where:{userId:who.id},
   select:{documentsJson:true},take:100});
  const url='/api/v1/uploads/onboarding-document/'+name;
  if(!applications.some(x=>{try{
   return (JSON.parse(x.documentsJson) as string[]).includes(url);
  }catch{return false;}}))return bad(403,'Documento no asociado a tu solicitud');
 }
 await mediaResponse(res,'onboarding',name);
});
parityRouter.post('/uploads/catalog/restaurant-cover',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await ownsRestaurant(who);
 const asset=await saveMedia(req,who.id,'catalog','r'+shop.id,
  {restaurantId:shop.id});
 const url=catalogAbsoluteUrl(asset.filename);
 await db.$transaction(async tx=>{
  await tx.marketplaceRestaurant.update({where:{id:shop.id},
   data:{coverImageUrl:url}});
  await tx.stageMediaAsset.update({where:{id:asset.id},data:{attached:true}});
 });
 res.json({url,restaurant_id:shop.id});
});
parityRouter.post('/uploads/catalog/menu/:itemId',async(req,res)=>{
 const who=await account(req,['restaurant']),id=param(req,'itemId'),
 shop=await ownsRestaurant(who);
 const item=await db.marketplaceMenuItem.findUnique({where:{id}});
 if(!item||item.restaurantId!==shop.id)return bad(404,'Producto ajeno');
 const asset=await saveMedia(req,who.id,'catalog','r'+shop.id+'-p'+id,
  {restaurantId:shop.id,menuItemId:id});
 const url=catalogAbsoluteUrl(asset.filename);
 await db.$transaction(async tx=>{
  await tx.marketplaceMenuItem.update({where:{id},data:{imageUrl:url}});
  await tx.stageMediaAsset.update({where:{id:asset.id},data:{attached:true}});
 });
 res.json({url,item_id:id});
});
parityRouter.get('/uploads/catalog/:filename',async(req,res)=>{
 const name=String(req.params.filename??'');
 const asset=await db.stageMediaAsset.findUnique({where:{filename:name}});
 if(!asset||!asset.attached||asset.category!=='catalog')
  return bad(404,'Imagen no publicada');
 const url=catalogAbsoluteUrl(name);
 const legacyUrl='/api/v1/uploads/catalog/'+name;
 const [shop,item]=await Promise.all([
  db.marketplaceRestaurant.findFirst({where:{coverImageUrl:{in:[url,legacyUrl]}},
   select:{id:true}}),
  db.marketplaceMenuItem.findFirst({where:{imageUrl:{in:[url,legacyUrl]}},
   select:{id:true}})]);
 if(!shop&&!item)return bad(404,'Imagen no publicada');
 await mediaResponse(res,'catalog',name,true);
});
parityRouter.post('/uploads/chat-media/:orderId',async(req,res)=>{
 const who=await account(req),id=param(req,'orderId');
 await ownOrder(id,who);
 const asset=await saveMedia(req,who.id,'chat-media','o'+id+'-u'+who.id,
  {orderId:id});
 res.json({url:'/api/v1/uploads/chat-media/'+asset.filename});
});
parityRouter.get('/uploads/chat-media/:filename',async(req,res)=>{
 const who=await account(req),name=String(req.params.filename??'');
 const asset=await db.stageMediaAsset.findUnique({where:{filename:name}});
 if(!asset||asset.category!=='chat-media')return bad(404,'Archivo no encontrado');
 const url='/api/v1/uploads/chat-media/'+name;
 const message=await db.platformChatMessage.findFirst({where:{mediaUrl:url}});
 if(!message)return bad(403,'Archivo no asociado a mensaje');
 await ownOrder(message.orderId,who);
 await mediaResponse(res,'chat-media',name);
});

export function parityErrors(error:unknown,_req:Request,res:Response,next:NextFunction){
 if(error instanceof Error&&error.message==='request aborted'){
  res.status(400).json({detail:'Carga multipart interrumpida'});return;
 }
 next(error);
}
