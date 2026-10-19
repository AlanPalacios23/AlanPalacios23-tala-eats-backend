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
  {id:2,name:'Órdenes con efectivo y recoger',area:'checkout',mode:'staging',description:'Flujo sintético aislado'},
  {id:3,name:'Comercio y KDS',area:'merchant',mode:'staging',description:'Acciones con autorización'},
  {id:4,name:'Repartidores',area:'driver',mode:'staging',description:'Despacho limitado a efectivo'},
  {id:5,name:'Wallet y puntos',area:'loyalty',mode:'restricted',description:'Sin pasarela de monetización real'},
  {id:6,name:'Pagos digitales',area:'payment',mode:'disabled',description:'Stripe/MercadoPago aún no activos'},
  {id:7,name:'Retiros y conciliación',area:'finance',mode:'disabled',description:'Sin transferencias financieras reales'},
  {id:8,name:'Media',area:'uploads',mode:'staging',description:'Almacenamiento restringido a laboratorio'}]});
});
parityRouter.get('/orders/payment-methods',async(req,res)=>{
 await account(req);
 res.json({methods:[
  {id:'cash',label:'Efectivo',enabled:true,mode:'stage-cash-pickup'},
  {id:'mercadopago',label:'Mercado Pago',enabled:false,reason:'node-provider-not-configured'},
  {id:'stripe',label:'Tarjeta',enabled:false,reason:'node-provider-not-configured'},
  {id:'wallet',label:'Wallet',enabled:false,reason:'wallet-not-reconciled'}],
  production_ready:false});
});
parityRouter.get('/payments/config',(_req,res)=>{
 res.json({provider:'mercadopago',enabled:false,
  public_key:null,checkout_ready:false,environment:'staging'});
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
