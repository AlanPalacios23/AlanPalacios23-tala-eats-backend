// F1: Python v9/v10/v11 customer/merchant observability and read contracts.
// Metadata is explicit NODE STAGING to avoid falsely advertising LIVE PSP/WS.
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { account, bad, param } from '../operational/routes.js';
export const v9Router=Router();
export const v10Router=Router();
export const v11Router=Router();
const ACTIVE=['received','confirmed','preparing','ready','assigned','picked_up','on_the_way'];
const VERSION='0.1.0-node-stage';
const denied=()=>bad(503,'Integración todavía no habilitada en Node staging');
function round(n:number,d=2){return Number(n.toFixed(d));}
function haversine(a:number,b:number,c:number,d:number){
 const rad=Math.PI/180,p=(c-a)*rad,g=(d-b)*rad;
 const k=Math.sin(p/2)**2+Math.cos(a*rad)*Math.cos(c*rad)*Math.sin(g/2)**2;
 return 6371*2*Math.atan2(Math.sqrt(k),Math.sqrt(1-k));
}
const cash=(s:{toFixed:(n:number)=>string})=>s.toFixed(2);
function validatePoint(req:Request){
 const lat=z.coerce.number().min(-90).max(90).safeParse(req.query.lat);
 const lng=z.coerce.number().min(-180).max(180).safeParse(req.query.lng);
 if(!lat.success||!lng.success||req.query.lat===undefined||req.query.lng===undefined)
  return bad(422,'Coordenadas inválidas');
 return {lat:lat.data,lng:lng.data};
}
function iso() {return new Date().toISOString();}
function minutesBetween(a:Date,b:Date){return Math.max(0,Math.floor((b.getTime()-a.getTime())/60000));}
function numberArg(req:Request,key:string,defaultValue:number,min:number,max:number){
 const v=req.query[key];
 if(v===undefined)return defaultValue;
 if(typeof v!=='string'||!/^(?:0|[1-9]\d*)$/.test(v))return bad(422,'Parámetro inválido');
 return Math.max(min,Math.min(max,Number(v)));
}
async function redisProbe(){
 const client=new Redis(config.REDIS_URL,{
  lazyConnect:true,connectTimeout:1400,maxRetriesPerRequest:1,
  retryStrategy:()=>null,
 });
 try{
  await client.connect();
  const pong=await client.ping();
  const worker=await client.get('talaeats:worker:heartbeat');
  return {ok:pong==='PONG',worker:Boolean(worker)};
 }catch{return {ok:false,worker:false};}
 finally{client.disconnect();}
}
function readinessIntegrations(){
 return {
  payments:{configured:false,provider:'none',status:'disabled-staging'},
  payouts:{configured:false,provider:'none',status:'disabled-staging'},
  web_push:{configured:false,provider:'none',status:'disabled-staging'},
  maps:{configured:false,provider:'haversine-rules',status:'fallback-rules'},
 };
}
v10Router.get('/overview',(_req,res)=>{
 res.json({version:'10.0.0-stability-premium',theme:'Stability + Premium Experience',
  inherits:'V9 Intelligence + Growth + Automation',capabilities:122,
  stability:{request_deduplication:true,safe_get_retries:true,
   stale_read_fallback:true,adaptive_websocket_reconnect:true,
   runtime_health_monitor:true,frontend_error_boundary:true,
   safe_service_worker:true,production_preflight:true},
  node_stage_notice:'Legacy Python capability catalog; not a Node production readiness assertion'});
});
v10Router.get('/runtime',async(req,res)=>{
 const who=await account(req),p=await redisProbe();
 res.setHeader('Cache-Control','private, no-store');
 res.json({status:p.ok?'ok':'degraded',version:VERSION,role:who.role,
  redis:p.ok?'ok':'degraded',worker:p.worker?'ok':'starting',server_time:iso()});
});
v10Router.get('/admin/stability',async(req,res)=>{
 await account(req,['admin']);
 const p=await redisProbe();
 let dbOk=true;
 try{await db.$queryRawUnsafe('SELECT 1');}catch{dbOk=false;}
 const [active,incidents,drivers]=await Promise.all([
  db.marketOrder.count({where:{status:{in:ACTIVE}}}),
  db.opsIncident.count({where:{status:'open'}}),
  db.marketplaceDriverProfile.count({where:{isOnline:true}}),
 ]);
 res.setHeader('Cache-Control','private, no-store');
 res.json({status:dbOk&&p.ok?'healthy':'degraded',checked_at:iso(),version:VERSION,
  dependencies:{database:dbOk?'ok':'error',redis:p.ok?'ok':'error',
   worker:p.worker?'ok':'starting'},
  traffic:{requests:0,error_rate_percent:0,p95_ms:0,sampled:false},
  operations:{active_orders:active,open_incidents:incidents,online_drivers:drivers},
  thresholds:{slow_request_ms:1200,error_rate_attention_percent:5},
  node_stage_notice:'Traffic is not instrumented; zeroes are not production measurements'});
});
v11Router.get('/overview',(_req,res)=>{
 res.json({version:'11.0.0-launch-ready',theme:'Launch Ready + Scale + Real Integrations',
  inherits:'V10 Stability + Premium Experience',capabilities:150,
  pillars:['real-payments','payout-adapters','push','maps-routing','live-orders','kds-pro',
   'driver-offers','canary','backup-restore','security','privacy','mobile-contract'],
  node_stage_notice:'Python capability catalog only. Node production GO-LIVE is prohibited.'});
});
v11Router.get('/launch-readiness',async(_req,res)=>{
 const integrations=readinessIntegrations();
 const row=await db.stageSystemSetting.findUnique({where:{key:'v11.canary_percent'}});
 const percent=Math.max(0,Math.min(100,Number(row?.value??0)||0));
 res.json({version:VERSION,core_ready:false,integrations,
  integrations_configured:0,integrations_total:Object.keys(integrations).length,
  privileged_2fa_required:true,driver_offer_mode:'disabled-stage',
  canary_percent:percent,release_channel:'staging',
  go_live:{cash_wallet_core:false,online_payments:false,automatic_payouts:false,
   push:false,real_maps:false}});
});
v11Router.get('/integrations',async(req,res)=>{
 await account(req,['admin']);
 res.setHeader('Cache-Control','private, no-store');
 res.json(readinessIntegrations());
});
v11Router.get('/release-cohort',async(req,res)=>{
 const who=await account(req),settings=await db.stageSystemSetting.findUnique({
  where:{key:'v11.canary_percent'},
 });
 const percent=Math.max(0,Math.min(100,Number(settings?.value??0)||0));
 const bucket=parseInt(createHash('sha256').update(String(who.id)).digest('hex').slice(0,8),16)%100;
 res.setHeader('Cache-Control','private, no-store');
 res.json({bucket,canary_percent:percent,channel:bucket<percent?'canary':'stable',version:VERSION});
});
v11Router.get('/push/config',(_req,res)=>{
 res.json({enabled:false,public_key:null});
});
v11Router.get('/privacy/preferences',async(req,res)=>{
 const who=await account(req);
 res.setHeader('Cache-Control','private, no-store');
 res.json({marketing_opt_in:who.marketingOptIn,
  analytics_opt_in:who.analyticsOptIn,
  personalization_opt_in:who.personalizationOptIn});
});
v11Router.get('/mobile/contract',(_req,res)=>{
 // Route catalog parity, but flags signal that WS/push/PSP are NOT running.
 res.json({api_version:'v1',contract_version:'11.0',minimum_client:'1.0.0',
  auth:{cookie_web:true,bearer_mobile:true},
  realtime:{orders:'/ws/orders/{order_id}'},
  core:{restaurants:'/api/v1/restaurants',orders:'/api/v1/orders',
   wallet:'/api/v1/platform/wallet',
   notifications:'/api/v1/platform/notifications'},
  v11:{live_order:'/api/v1/v11/orders/{order_id}/live',
   driver_offers:'/api/v1/v11/driver/offers',
   push:'/api/v1/v11/push/subscriptions'},
  node_stage_notice:'Capability paths are compatibility metadata, not active Node WS/PSP services'});
});
v11Router.get('/performance-budgets',(_req,res)=>{
 res.json({mobile:{lcp_ms:2500,inp_ms:200,cls:0.1,
  initial_js_kb_gzip:220,initial_css_kb_gzip:90,image_hero_kb:350},
  api:{p95_ms:1200,error_rate_percent:1,checkout_p95_ms:1800}});
});
v9Router.get('/overview',(_req,res)=>{
 res.json({version:'9.0.0-intelligence-growth-automation',
  theme:'Intelligence + Growth + Automation',capabilities:112,
  engines:{dispatch:'scoring-v1',eta:'dynamic-v1',
   demand_forecast:'historical-moving-average',
   recommendations:'behavioral-rules-v1',smart_search:'intent-rules-v1',
   fraud:'signals-v1'},
  note:'Catálogo de capacidades Python. Réplica Node parcial en staging.'});
});
function tier(points:number,delivered:number){
 const score=points+delivered*25;
 return score>=3000?'BLACK':score>=1500?'GOLD':score>=600?'SILVER':'BRONZE';
}
v9Router.get('/loyalty/status',async(req,res)=>{
 const who=await account(req);
 const [wallet,delivered]=await Promise.all([
  db.authLoyaltyAccount.findUnique({where:{userId:who.id}}),
  db.marketOrder.count({where:{userId:who.id,status:'delivered'}}),
 ]);
 if(!wallet)return bad(404,'Cuenta Rewards no encontrada');
 const next=tier(wallet.points,delivered);
 if(wallet.tier!==next)await db.authLoyaltyAccount.update({
  where:{userId:who.id},data:{tier:next},
 });
 const benefits:Record<string,string[]>={
  BRONZE:['Rewards base'],SILVER:['Rewards x1.1','ofertas privadas'],
  GOLD:['Rewards x1.25','prioridad de soporte'],
  BLACK:['Rewards x1.5','beneficios premium'],
 };
 res.setHeader('Cache-Control','private, no-store');
 res.json({tier:next,points:wallet.points,streak_days:wallet.streakDays,
  plus_member:wallet.plusMember,plus_savings:cash(wallet.plusSavings),
  progress_score:wallet.points+delivered*25,
  next_target:next==='BRONZE'?600:next==='SILVER'?1500:3000,
  benefits:benefits[next]});
});
v9Router.get('/plus/value',async(req,res)=>{
 const who=await account(req);
 const [wallet,delivered]=await Promise.all([
  db.authLoyaltyAccount.findUnique({where:{userId:who.id}}),
  db.marketOrder.findMany({where:{userId:who.id,status:'delivered'},
   orderBy:{createdAt:'desc'},take:50,select:{deliveryFee:true}}),
 ]);
 // Stage-only: informational estimate, avoid mutating financial state.
 const cents=delivered.reduce((p,o)=>{
  const [a,b='']=o.deliveryFee.toString().split('.');
  return p+BigInt(a!)*100n+BigInt((b+'00').slice(0,2));
 },0n);
 const saving=wallet?.plusMember?Number((cents*45n+50n)/100n):0;
 const value=(saving/100).toFixed(2);
 res.setHeader('Cache-Control','private, no-store');
 res.json({active:Boolean(wallet?.plusMember),estimated_savings:value,
  orders_considered:delivered.length,
  message:saving>=7900?'Tu membresía ya se paga sola.':'Sigue usando Plus para aumentar tu ahorro.'});
});
async function authorizedOrder(id:number,who:{id:number;role:string}){
 const order=await db.marketOrder.findUnique({where:{id},include:{restaurant:true}});
 if(!order)return bad(404,'Pedido no encontrado');
 if(who.role!=='admin'&&order.userId!==who.id&&order.driverId!==who.id&&
  !(who.role==='restaurant'&&order.restaurant.ownerId===who.id))
  return bad(403,'Sin acceso');
 return order;
}
v9Router.get('/orders/:orderId/eta',async(req,res)=>{
 const who=await account(req),order=await authorizedOrder(param(req,'orderId'),who);
 const now=new Date(),hour=now.getUTCHours();
 const peak=[7,8,9,13,14,15,18,19,20,21].includes(hour)?1.25:1;
 const load=await db.marketOrder.count({
  where:{restaurantId:order.restaurantId,status:{in:ACTIVE}},
 });
 const penalty=Math.max(0,load-3)*3,elapsed=minutesBetween(order.createdAt,now);
 let remaining:number;
 if(['received','confirmed','preparing'].includes(order.status)){
  const prep=Math.max(5,Math.trunc(order.restaurant.etaMin+penalty-elapsed*.25));
  const travel=order.orderType==='delivery'?
   Math.max(7,Math.trunc(order.distanceKm*4*peak)):0;
  remaining=prep+travel;
 }else if(['ready','assigned'].includes(order.status))
  remaining=Math.max(7,Math.trunc(order.distanceKm*4*peak)+penalty);
 else if(order.status==='picked_up')
  remaining=Math.max(5,Math.trunc(order.distanceKm*3.5*peak));
 else if(order.status==='on_the_way')
  remaining=Math.max(3,Math.trunc(order.distanceKm*2.7*peak));
 else if(order.status==='delivered')remaining=0;
 else remaining=Math.max(0,order.estimatedMinutes-elapsed);
 res.setHeader('Cache-Control','private, no-store');
 res.json({order_id:order.id,status:order.status,eta_minutes:remaining,
  confidence:['picked_up','on_the_way'].includes(order.status)?'high':'medium',
  restaurant_load:load,traffic_factor:peak,
  traffic_source:'peak-hour-heuristic-v1',calculated_at:iso()});
});
v9Router.get('/markets',async(_req,res)=>{
 const shops=await db.marketplaceRestaurant.findMany({
  where:{isOpen:true},select:{marketCode:true,brandName:true,name:true},
 });
 const groups=new Map<string,{market_code:string;restaurants:number;brands:Set<string>}>();
 for(const r of shops){
  let v=groups.get(r.marketCode);
  if(!v){v={market_code:r.marketCode,restaurants:0,brands:new Set()};groups.set(r.marketCode,v);}
  v.restaurants++;v.brands.add(r.brandName||r.name);
 }
 res.json(Array.from(groups.values()).map(g=>({
  market_code:g.market_code,restaurants:g.restaurants,brands:g.brands.size,
 })));
});
v9Router.get('/brands/:brandName/best-branch',async(req,res)=>{
 const name=Array.isArray(req.params.brandName)?req.params.brandName[0]:req.params.brandName;
 if(!name||name.length>150)return bad(422,'Marca inválida');
 const {lat,lng}=validatePoint(req);
 const branches=await db.marketplaceRestaurant.findMany({
  where:{isOpen:true,OR:[{brandName:name},{name}]},
 });
 if(!branches.length)return bad(404,'Marca no encontrada');
 const grouped=await db.marketOrder.groupBy({
  by:['restaurantId'],where:{
   restaurantId:{in:branches.map(x=>x.id)},
   status:{in:['received','confirmed','preparing','ready']},
  },_count:{_all:true},
 });
 const counts=new Map(grouped.map(q=>[q.restaurantId,q._count._all]));
 const ranked=branches.map(x=>{
  const dist=haversine(lat,lng,x.lat,x.lng),active=counts.get(x.id)??0;
  return {x,dist,active,score:dist+active*.6};
 }).sort((a,b)=>a.score-b.score||a.x.id-b.x.id);
 const best=ranked[0]!;
 res.json({id:best.x.id,name:best.x.name,
  brand:best.x.brandName||best.x.name,branch_code:best.x.branchCode,
  market_code:best.x.marketCode,distance_km:round(best.dist),
  active_kitchen_orders:best.active,
  reason:'Mejor combinación de distancia, disponibilidad y carga'});
});
function effectiveSchedule(raw:string,weekday:number,clock:string){
 try{
  const obj=JSON.parse(raw);
  if(!obj||typeof obj!=='object')return [];
  return Array.isArray(obj.windows)?obj.windows.filter((x:unknown)=>{
   if(!x||typeof x!=='object')return false;
   const w=x as Record<string,unknown>;
   return (w.days===undefined||(Array.isArray(w.days)&&w.days.includes(weekday)))&&
    String(w.start??'00:00')<=clock&&clock<=String(w.end??'23:59');
  }):[];
 }catch{return []}
}
v9Router.get('/restaurants/:restaurantId/effective-menu',async(req,res)=>{
 const id=param(req,'restaurantId'),shop=await db.marketplaceRestaurant.findUnique({where:{id}});
 if(!shop)return bad(404,'Restaurante no encontrado');
 const items=await db.marketplaceMenuItem.findMany({where:{restaurantId:id}});
 const now=new Date(),weekday=(now.getUTCDay()+6)%7,clock=now.toISOString().slice(11,16);
 const result=items.map(x=>{
  const schedule=effectiveSchedule(x.availabilityScheduleJson,weekday,clock);
  let available=x.isAvailable;
  try{
   const original=JSON.parse(x.availabilityScheduleJson);
   if(Array.isArray(original?.windows)&&original.windows.length)available=schedule.length>0;
  }catch{}
  const prices=effectiveSchedule(x.priceScheduleJson,weekday,clock);
  let value=Number(x.price);
  if(prices.length){
   const row=prices[0] as Record<string,unknown>;
   if(row.price!==undefined&&Number.isFinite(Number(row.price))&&Number(row.price)>=0)
    value=Number(row.price);
   else if(row.multiplier!==undefined&&Number.isFinite(Number(row.multiplier))&&Number(row.multiplier)>=0)
    value=Math.round((value*Number(row.multiplier)+Number.EPSILON)*100)/100;
  }
  return {id:x.id,name:x.name,description:x.description,category:x.category,
   base_price:cash(x.price),effective_price:value.toFixed(2),
   available_now:available&&x.stock>0,stock:x.stock,image_url:x.imageUrl};
 });
 res.json({restaurant_id:id,market_code:shop.marketCode,items:result});
});
v9Router.get('/admin/funnel',async(req,res)=>{
 await account(req,['admin']);
 const days=numberArg(req,'days',30,1,180),cutoff=new Date(Date.now()-days*86400000);
 const groups=await db.stageProductEvent.groupBy({
  by:['eventName'],where:{createdAt:{gte:cutoff}},_count:{_all:true},
 });
 const counts=new Map(groups.map(g=>[g.eventName,g._count._all]));
 const stages=['app_open','search','restaurant_view','add_to_cart',
  'checkout_started','checkout_completed','order_delivered'];
 let previous:number|null=null;
 const funnel=stages.map(stage=>{
  const events=counts.get(stage)??0;
  const conversion=previous?round(events/previous*100,1):100;
  if(events>0)previous=events;
  return {stage,events,step_conversion_percent:conversion};
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json({days,total_events:Array.from(counts.values()).reduce((a,b)=>a+b,0),funnel});
});
v9Router.get('/admin/system-status',async(req,res)=>{
 await account(req,['admin']);
 const p=await redisProbe();
 let dbStatus='ok';try{await db.$queryRawUnsafe('SELECT 1');}catch{dbStatus='error';}
 const open=await db.opsIncident.count({where:{status:'open'}});
 const checks={database:dbStatus,redis:p.ok?'ok':'error',
  worker:p.worker?'ok':'stale',payments:'not-configured',
  websocket:'local-only',email:'not-configured'};
 res.setHeader('Cache-Control','private, no-store');
 res.json({status:dbStatus==='error'||!p.ok?'degraded':'ok',
  checks,open_incidents:open,generated_at:iso()});
});


// G2: 20 additional Python V9 functional contracts: consumer discovery,
// inventory, operational incidents and loyalty missions. Stage PG15 only.
const valid=<T extends z.ZodTypeAny>(schema:T,data:unknown):z.output<T>=>{
 const s=schema.safeParse(data);
 if(!s.success)return bad(422,'Parámetros inválidos');
 return s.data;
};
const dec3=z.union([z.number(),z.string()]).transform(String)
 .refine(s=>/^-?\d{1,9}(?:\.\d{1,3})?$/.test(s));
const uiTime=()=>new Date().toISOString();
async function store(who:{id:number;role:string}){
 const shop=await db.marketplaceRestaurant.findFirst({where:{ownerId:who.id}});
 if(!shop)return bad(404,'No tienes un restaurante asignado');
 return shop;
}
v9Router.post('/events',async(req,res)=>{
 const p=valid(z.strictObject({
  event_name:z.string().min(2).max(100),
  session_id:z.string().max(80).default(''),
  route:z.string().max(240).default(''),
  properties:z.record(z.string(),z.unknown()).default({}),
 }),req.body);
 const js=JSON.stringify(p.properties);
 if(js.length>8000)return bad(422,'Propiedades excesivas');
 // Pre-login analytics are deliberately anonymous even with a bearer token.
 await db.stageProductEvent.create({data:{eventName:p.event_name,
  sessionId:p.session_id,route:p.route,propertiesJson:js}});
 res.status(202).json({accepted:true});
});
v9Router.get('/search',async(req,res)=>{
 const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,160):'';
 const limitArg=req.query.limit;
 const limit=limitArg===undefined?20:Number(limitArg);
 if(!Number.isInteger(limit)||limit<1||limit>50)
  return bad(422,'Límite de búsqueda inválido');
 const maxPrice=req.query.max_price===undefined?null:Number(req.query.max_price);
 if(maxPrice!==null&&(!Number.isFinite(maxPrice)||maxPrice<0||maxPrice>1000000))
  return bad(422,'Precio inválido');
 const query=q.toLowerCase().replaceAll(',',' ');
 const terms=query.split(/\s+/).filter(x=>x.length>1),has=(patterns:string[])=>
  patterns.some(x=>query.includes(x));
 const intent={healthy:has(['saludable','healthy','light','ensalada','proteina']),
  cheap:has(['barato','económico','economico','menos de','budget']),
  breakfast:has(['desayuno','breakfast','café','cafe']),
  family:has(['familia','4 personas','compartir','grupo']),
  max_price:maxPrice};
 const shops=await db.marketplaceRestaurant.findMany({
  where:{isOpen:true},orderBy:[{sponsored:'desc'},{rating:'desc'},{id:'asc'}],
  take:100});
 const menu=await db.marketplaceMenuItem.findMany({where:{
  restaurantId:{in:shops.map(x=>x.id)},isAvailable:true,
  ...(maxPrice!==null?{price:{lte:String(maxPrice)}}:{})},
  orderBy:[{restaurantId:'asc'},{id:'asc'}]});
 const map=new Map<number,typeof menu>();
 for(const item of menu){const rows=map.get(item.restaurantId)??[];rows.push(item);map.set(item.restaurantId,rows);}
 const results=shops.flatMap(r=>{
  const hayR=(r.name+' '+r.cuisine).toLowerCase();
  const matched=(map.get(r.id)??[]).map(i=>{
   const hay=(i.name+' '+i.description+' '+i.category+' '+i.dietaryTags).toLowerCase();
   let score=terms.reduce((v,t)=>v+(hay.includes(t)?4:0)+(hayR.includes(t)?2:0),0);
   if(intent.healthy&&['veg','ensalada','pollo','protein','salud'].some(x=>hay.includes(x)))score+=5;
   if(intent.breakfast&&['café','cafe','huevo','desayuno','pan'].some(x=>hay.includes(x)))score+=5;
   if(intent.family&&(i.isCombo||hay.includes('combo')||hay.includes('familiar')))score+=5;
   if(intent.cheap&&Number(i.price)<=180)score+=3;
   return {i,score};
  }).filter(v=>v.score>0||!terms.length)
   .sort((a,b)=>b.score-a.score||Number(a.i.price)-Number(b.i.price)).slice(0,6);
  return matched.length?[{restaurant:{id:r.id,name:r.name,cuisine:r.cuisine,
   rating:Number(r.rating),eta_min:r.etaMin,delivery_fee:Number(r.deliveryFee)},
   items:matched.map(x=>({id:x.i.id,name:x.i.name,price:Number(x.i.price),
    category:x.i.category,score:x.score})),
   score:matched.reduce((v,x)=>v+x.score,Number(r.rating))}]:[];
 }).sort((a,b)=>b.score-a.score).slice(0,limit);
 res.json({query:q,intent,results});
});
v9Router.get('/recommendations',async(req,res)=>{
 const who=await account(req);
 const [orders,favs,shops]=await Promise.all([
  db.marketOrder.findMany({where:{userId:who.id,status:'delivered'},
   orderBy:{createdAt:'desc'},take:30,select:{restaurantId:true,total:true,createdAt:true}}),
  db.platformFavorite.findMany({where:{userId:who.id},select:{restaurantId:true}}),
  db.marketplaceRestaurant.findMany({where:{isOpen:true},
   orderBy:[{sponsored:'desc'},{rating:'desc'},{id:'asc'}],take:100}),
 ]);
 const counts=new Map<number,number>();
 for(const order of orders)counts.set(order.restaurantId,(counts.get(order.restaurantId)??0)+1);
 const favorites=new Set(favs.map(x=>x.restaurantId)),hour=new Date().getUTCHours();
 const ranked=shops.map(x=>{
  let score=Number(x.rating)*2+(counts.get(x.id)??0)*5+
   (favorites.has(x.id)?6:0)+(x.sponsored?2:0);
  if(hour<11&&['cafe','café','desayuno'].some(k=>x.cuisine.toLowerCase().includes(k)))score+=4;
  return {id:x.id,name:x.name,cuisine:x.cuisine,rating:Number(x.rating),
   eta_min:x.etaMin,delivery_fee:Number(x.deliveryFee),
   reason:counts.has(x.id)?'Tus hábitos':favorites.has(x.id)?'Favorito':'Popular cerca',
   score:round(score)};
 }).sort((a,b)=>b.score-a.score).slice(0,12);
 const total=orders.reduce((s,o)=>s+Number(o.total),0);
 const segment=orders.length===0?'new':orders.length>=20||total>=8000?'vip':
  orders.length>=5?'regular':'occasional';
 res.setHeader('Cache-Control','private, no-store');
 res.json({segment:{segment,delivered_orders:orders.length,total_spend:total.toFixed(2)},restaurants:ranked});
});
v9Router.get('/admin/heatmap',async(req,res)=>{
 await account(req,['admin']);
 const hours=numberArg(req,'hours',24,1,168),cutoff=new Date(Date.now()-hours*3600000);
 const rows=await db.marketOrder.findMany({where:{createdAt:{gte:cutoff}},
  include:{restaurant:true},orderBy:{createdAt:'desc'},take:100000});
 const online=await db.marketplaceDriverProfile.count({where:{isOnline:true}});
 const cells=new Map<string,{lat:number;lng:number;orders:number;active_orders:number;gmv:number}>();
 for(const o of rows){
  const lat=round(o.deliveryLat??o.restaurant.lat),lng=round(o.deliveryLng??o.restaurant.lng);
  const key=lat+':'+lng;
  const cell=cells.get(key)??{lat,lng,orders:0,active_orders:0,gmv:0};
  cell.orders++;cell.gmv+=Number(o.total);
  if(!['delivered','cancelled'].includes(o.status))cell.active_orders++;
  cells.set(key,cell);
 }
 res.setHeader('Cache-Control','private, no-store');
 res.json({hours,online_drivers:online,points:Array.from(cells.values())
  .sort((a,b)=>b.orders-a.orders).slice(0,100)
  .map(c=>({...c,gmv:c.gmv.toFixed(2),
   pressure:round(c.active_orders/Math.max(1,online))}))});
});
v9Router.get('/admin/demand-forecast',async(req,res)=>{
 await account(req,['admin']);
 const hours=numberArg(req,'hours',24,1,72),start=new Date(),cutoff=new Date(start.getTime()-56*86400000);
 const timestamps=await db.marketOrder.findMany({where:{createdAt:{gte:cutoff}},
  select:{createdAt:true},orderBy:{createdAt:'desc'},take:100000});
 const byHour=new Map<number,Map<string,number>>(),recent=new Map<number,number>();
 for(const {createdAt:t} of timestamps){
  const h=t.getUTCHours(),d=t.toISOString().slice(0,10);
  const m=byHour.get(h)??new Map<string,number>();m.set(d,(m.get(d)??0)+1);byHour.set(h,m);
  if(t.getTime()>=start.getTime()-7*86400000)recent.set(h,(recent.get(h)??0)+1);
 }
 const stamp=new Date(start);stamp.setUTCMinutes(0,0,0);
 const forecast=Array.from({length:hours},(_,i)=>{
  const at=new Date(stamp.getTime()+i*3600000),h=at.getUTCHours();
  const vals=Array.from((byHour.get(h)??new Map()).values());
  const avg=vals.length?vals.reduce((p,x)=>p+x,0)/vals.length:0;
  const predicted=round(avg*.65+(recent.get(h)??0)/7*.35,1);
  return {at:at.toISOString(),predicted_orders:predicted,
   recommended_online_drivers:Math.max(1,Math.ceil(predicted/2.2)),
   confidence:vals.length>=7?'medium':'low'};
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json({method:'56d-hourly-moving-average',sample_orders:timestamps.length,forecast});
});
v9Router.post('/admin/incidents/detect',async(req,res)=>{
 await account(req,['admin']);
 const orders=await db.marketOrder.findMany({where:{status:{in:ACTIVE}},
  orderBy:{updatedAt:'asc'},take:5000});
 let count=0;
 for(const o of orders){
  const age=(Date.now()-o.updatedAt.getTime())/60000;
  const checks:[string,string,string,string][]=[];
  if(['received','confirmed','preparing'].includes(o.status)&&age>35)
   checks.push(['restaurant_delay','high','Pedido retrasado en cocina','Contactar restaurante']);
  if(['ready','assigned'].includes(o.status)&&o.driverId==null&&age>8)
   checks.push(['no_driver','high','Pedido sin repartidor','Ejecutar auto-dispatch']);
  if(['assigned','picked_up','on_the_way'].includes(o.status)&&age>25)
   checks.push(['driver_stalled','medium','Entrega sin movimiento','Contactar repartidor']);
  for(const [kind,severity,title,action] of checks){
   const prior=await db.opsIncident.findFirst({where:{orderId:o.id,incidentType:kind,status:'open'}});
   if(prior)continue;
   await db.opsIncident.create({data:{orderId:o.id,incidentType:kind,severity,title,
    detail:'Pedido #'+o.id+', '+Math.floor(age)+' min sin cambio',
    recommendedAction:action}});
   count++;
  }
 }
 res.json({created:count,active_orders:orders.length});
});
v9Router.get('/admin/incidents',async(req,res)=>{
 await account(req,['admin']);
 const status=typeof req.query.status==='string'?req.query.status:'open';
 if(status.length>30)return bad(422,'Estado inválido');
 const rows=await db.opsIncident.findMany({where:{status},
  orderBy:{createdAt:'desc'},take:300});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,order_id:x.orderId,type:x.incidentType,
  severity:x.severity,title:x.title,detail:x.detail,
  recommended_action:x.recommendedAction,status:x.status,
  created_at:x.createdAt.toISOString()})));
});
v9Router.patch('/admin/incidents/:incidentId',async(req,res)=>{
 await account(req,['admin']);
 const id=param(req,'incidentId'),p=valid(z.strictObject({
  status:z.enum(['resolved','dismissed']).default('resolved'),
  note:z.string().max(500).default('')}),req.body);
 const old=await db.opsIncident.findUnique({where:{id}});
 if(!old)return bad(404,'Incidente no encontrado');
 const updated=await db.opsIncident.update({where:{id},data:{
  status:p.status,resolvedAt:new Date(),
  detail:[old.detail,p.note].filter(Boolean).join('\n')}});
 res.json({id:updated.id,status:updated.status});
});
v9Router.get('/driver/score',async(req,res)=>{
 const who=await account(req,['driver']);
 const [p,orders]=await Promise.all([
  db.marketplaceDriverProfile.findUnique({where:{userId:who.id}}),
  db.marketOrder.findMany({where:{driverId:who.id},
   select:{status:true,createdAt:true,deliveredAt:true,estimatedMinutes:true}}),
 ]);
 const delivered=orders.filter(x=>x.status==='delivered'),
  cancelled=orders.filter(x=>x.status==='cancelled').length;
 const ontime=delivered.filter(x=>x.deliveredAt&&minutesBetween(
  x.createdAt,x.deliveredAt)<=Math.max(60,(x.estimatedMinutes||30)+20)).length;
 const punctuality=round(100*ontime/Math.max(1,delivered.length),1),
  completion=round(100*delivered.length/Math.max(1,orders.length),1),
  rating=Number(p?.rating??5);
 res.setHeader('Cache-Control','private, no-store');
 res.json({score:round(punctuality*.35+completion*.35+rating/5*30,1),
  rating,punctuality,completion,deliveries:delivered.length,cancelled,
  use:'Calidad y coaching; no genera sanciones automáticas.'});
});


v9Router.get('/merchant/intelligence',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const [rows,low]=await Promise.all([
  db.marketOrder.findMany({where:{restaurantId:shop.id},
   orderBy:{createdAt:'desc'},take:1000,include:{items:true}}),
  db.stageIngredientStock.findMany({where:{restaurantId:shop.id},
   orderBy:{quantity:'asc'},take:200}),
 ]);
 const delivered=rows.filter(x=>x.status==='delivered'),
  itemMap=new Map<string,{units:number;revenue:number}>(),
  hours=new Map<number,number>(),customers=new Map<number,number>();
 for(const o of delivered){
  const hour=o.createdAt.getUTCHours();
  hours.set(hour,(hours.get(hour)??0)+1);
  customers.set(o.userId,(customers.get(o.userId)??0)+1);
  for(const i of o.items){
   const value=itemMap.get(i.nameSnapshot)??{units:0,revenue:0};
   value.units+=i.quantity;
   value.revenue+=Number(i.unitPrice)*i.quantity;
   itemMap.set(i.nameSnapshot,value);
  }
 }
 res.setHeader('Cache-Control','private, no-store');
 res.json({restaurant_id:shop.id,orders:rows.length,delivered:delivered.length,
  repeat_customers:Array.from(customers.values()).filter(x=>x>=2).length,
  peak_hours:Array.from(hours,([hour,orders])=>({hour,orders})).sort((a,b)=>b.orders-a.orders).slice(0,5),
  top_products:Array.from(itemMap,([name,x])=>({name,units:x.units,
   revenue:x.revenue.toFixed(2)})).sort((a,b)=>b.units-a.units).slice(0,10),
  low_ingredients:low.filter(x=>Number(x.quantity)<=Number(x.reorderLevel))
   .map(x=>({id:x.id,name:x.name,quantity:x.quantity.toFixed(3),
    reorder_level:x.reorderLevel.toFixed(3)})),
  suggestions:['Crea combos con tus productos más vendidos',
   'Activa campaña en horas de baja demanda',
   'Repón ingredientes por debajo del mínimo']});
});
v9Router.get('/merchant/kitchen-forecast',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const hours=numberArg(req,'hours',6,1,24);
 const cutoff=new Date(Date.now()-42*86400000);
 const [rows,active]=await Promise.all([
  db.marketOrder.findMany({where:{restaurantId:shop.id,
   createdAt:{gte:cutoff}},select:{createdAt:true},
   orderBy:{createdAt:'desc'},take:50000}),
  db.marketOrder.count({where:{restaurantId:shop.id,status:{in:['received','confirmed','preparing']}}}),
 ]);
 const counts=new Map<number,number>(),
  days=new Set(rows.map(x=>x.createdAt.toISOString().slice(0,10)));
 for(const r of rows){const hour=r.createdAt.getUTCHours();
  counts.set(hour,(counts.get(hour)??0)+1);}
 const stamp=new Date();stamp.setUTCMinutes(0,0,0);
 const forecast=Array.from({length:hours},(_,i)=>{
  const at=new Date(stamp.getTime()+i*3600000),
   predicted=round((counts.get(at.getUTCHours())??0)/Math.max(1,days.size),1);
  return {at:at.toISOString(),predicted_orders:predicted,
   recommended_prep_capacity:Math.max(1,Math.ceil(predicted*1.2)),
   status:predicted>=5?'high':'normal'};
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json({active_kitchen_orders:active,forecast,
  delay_risk:active>=8?'high':active>=4?'medium':'low'});
});
const ingredientPublic=(x:any)=>({id:x.id,name:x.name,unit:x.unit,
 quantity:x.quantity.toFixed(3),reorder_level:x.reorderLevel.toFixed(3),
 unit_cost:x.unitCost.toFixed(2),
 low:Number(x.quantity)<=Number(x.reorderLevel)});
v9Router.get('/merchant/ingredients',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const rows=await db.stageIngredientStock.findMany({where:{restaurantId:shop.id},
  orderBy:{name:'asc'}});
 res.setHeader('Cache-Control','private, no-store');res.json(rows.map(ingredientPublic));
});
v9Router.post('/merchant/ingredients',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const p=valid(z.strictObject({
  name:z.string().trim().min(2).max(140),unit:z.string().max(30).default('unit'),
  quantity:dec3.default('0'),reorder_level:dec3.default('0'),
  unit_cost:z.union([z.number(),z.string()]).transform(String)
   .refine(s=>/^\d{1,8}(?:\.\d{1,2})?$/.test(s)).default('0'),
 }),req.body);
 if(Number(p.quantity)<0||Number(p.reorder_level)<0)return bad(422,'Cantidad no válida');
 const x=await db.stageIngredientStock.create({data:{restaurantId:shop.id,
  name:p.name,unit:p.unit,quantity:p.quantity,reorderLevel:p.reorder_level,
  unitCost:p.unit_cost}});
 res.status(201).json({id:x.id,name:x.name,quantity:x.quantity.toFixed(3)});
});
v9Router.patch('/merchant/ingredients/:ingredientId',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const id=param(req,'ingredientId');
 const p=valid(z.strictObject({
  quantity_delta:dec3,reason:z.string().max(180).default('adjustment'),
 }),req.body);
 const quantity=await db.$transaction(async tx=>{
  const locked=await tx.$queryRawUnsafe(
   'SELECT id FROM ingredient_stocks WHERE id=$1 AND restaurant_id=$2 FOR UPDATE',
   id,shop.id);
  if(!Array.isArray(locked)||!locked.length)return bad(404,'Ingrediente no encontrado');
  await tx.$executeRawUnsafe(
   'UPDATE ingredient_stocks SET quantity=GREATEST(0,quantity+$1::numeric),updated_at=NOW() WHERE id=$2',
   p.quantity_delta,id);
  const row=await tx.stageIngredientStock.findUnique({where:{id}});
  if(!row)return bad(404,'Ingrediente no encontrado');
  return row.quantity.toFixed(3);
 });
 res.json({id,quantity,reason:p.reason});
});
v9Router.post('/merchant/recipes',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const p=valid(z.strictObject({
  menu_item_id:z.number().int().positive(),
  ingredient_id:z.number().int().positive(),
  quantity_required:dec3,
 }),req.body);
 if(Number(p.quantity_required)<=0)return bad(422,'Cantidad requerida inválida');
 const [item,ingredient]=await Promise.all([
  db.marketplaceMenuItem.findUnique({where:{id:p.menu_item_id}}),
  db.stageIngredientStock.findUnique({where:{id:p.ingredient_id}}),
 ]);
 if(item?.restaurantId!==shop.id||ingredient?.restaurantId!==shop.id)
  return bad(404,'Producto o ingrediente no encontrado');
 const x=await db.stageMenuRecipe.upsert({
  where:{uq_recipe_component:{menuItemId:item.id,ingredientId:ingredient.id}},
  create:{menuItemId:item.id,ingredientId:ingredient.id,
   quantityRequired:p.quantity_required},
  update:{quantityRequired:p.quantity_required},
 });
 res.status(201).json({menu_item_id:x.menuItemId,ingredient_id:x.ingredientId,
  quantity_required:x.quantityRequired.toFixed(3)});
});
v9Router.post('/merchant/waste',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const p=valid(z.strictObject({
  ingredient_id:z.number().int().positive().nullable().default(null),
  quantity:dec3,
  reason:z.string().min(2).max(180),
 }),req.body);
 if(Number(p.quantity)<=0)return bad(422,'Cantidad de merma inválida');
 const created=await db.$transaction(async tx=>{
  let cost='0.00';
  if(p.ingredient_id!==null){
   const locked=await tx.$queryRawUnsafe(
    'SELECT id FROM ingredient_stocks WHERE id=$1 AND restaurant_id=$2 FOR UPDATE',
    p.ingredient_id,shop.id);
   if(!Array.isArray(locked)||!locked.length)return bad(404,'Ingrediente no encontrado');
   const row=await tx.$queryRawUnsafe(
    'SELECT (unit_cost*$1::numeric)::numeric(12,2) AS cost FROM ingredient_stocks WHERE id=$2',
    p.quantity,p.ingredient_id);
   cost=String((row as {cost:string}[])[0]?.cost??'0.00');
   await tx.$executeRawUnsafe(
    'UPDATE ingredient_stocks SET quantity=GREATEST(0,quantity-$1::numeric), updated_at=NOW() WHERE id=$2',
    p.quantity,p.ingredient_id);
  }
  return tx.stageWasteRecord.create({data:{restaurantId:shop.id,
   ingredientId:p.ingredient_id,quantity:p.quantity,reason:p.reason,estimatedCost:cost}});
 });
 res.status(201).json({id:created.id,estimated_cost:created.estimatedCost.toFixed(2)});
});
v9Router.get('/merchant/upsell/:menuItemId',async(req,res)=>{
 const who=await account(req,['restaurant']),shop=await store(who);
 const id=param(req,'menuItemId');
 const item=await db.marketplaceMenuItem.findUnique({where:{id}});
 if(!item||item.restaurantId!==shop.id)return bad(404,'Producto no encontrado');
 const choices=await db.marketplaceMenuItem.findMany({where:{
  restaurantId:shop.id,id:{not:id},isAvailable:true}});
 res.setHeader('Cache-Control','private, no-store');
 res.json({base:{id:item.id,name:item.name},
  suggestions:choices.sort((a,b)=>
   Math.abs(Number(a.price)-Number(item.price))-Math.abs(Number(b.price)-Number(item.price)))
   .slice(0,4).map(x=>({id:x.id,name:x.name,price:Number(x.price),
    reason:'Complemento/upsell sugerido por rango de precio'}))});
});
v9Router.get('/admin/trust/risk',async(req,res)=>{
 await account(req,['admin']);
 const customers=await db.authUser.findMany({where:{role:'customer'},
  select:{id:true,name:true,email:true},orderBy:{id:'asc'},take:10000});
 const orders=await db.marketOrder.groupBy({by:['userId','status'],
  where:{userId:{in:customers.map(x=>x.id)}},_count:{_all:true}});
 const disputes=await db.opsDispute.groupBy({by:['openedByUserId'],
  where:{openedByUserId:{in:customers.map(x=>x.id)},refundAmount:{gt:0}},
  _count:{_all:true}});
 const refunded=new Map(disputes.map(x=>[x.openedByUserId,x._count._all]));
 const counts=new Map<number,{total:number;cancelled:number}>();
 for(const x of orders){
  const row=counts.get(x.userId)??{total:0,cancelled:0};
  row.total+=x._count._all;if(x.status==='cancelled')row.cancelled+=x._count._all;
  counts.set(x.userId,row);
 }
 const result=customers.flatMap(who=>{
  const row=counts.get(who.id)??{total:0,cancelled:0},signals=[];
  if((refunded.get(who.id)??0)>=3)signals.push('multiple_refunds');
  if(row.total>=3&&row.cancelled/row.total>.45)signals.push('high_cancellation_rate');
  if(who.email.includes('+'))signals.push('email_alias');
  return signals.length?[{user_id:who.id,name:who.name,email:who.email,
   signals,risk_score:Math.min(100,signals.length*30)}]:[];
 }).sort((a,b)=>b.risk_score-a.risk_score);
 res.setHeader('Cache-Control','private, no-store');res.json(result);
});
async function missionStatus(id:number){
 const date=new Date(),month=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1));
 const rows=await db.marketOrder.findMany({where:{userId:id,status:'delivered',
  deliveredAt:{gte:month}},select:{restaurantId:true}});
 const orderCount=rows.length,restaurantCount=new Set(rows.map(x=>x.restaurantId)).size;
 const refs=['three_orders','two_restaurants'].map(k=>k+':'+month.toISOString().slice(0,7));
 const claimed=await db.stageWalletTransaction.findMany({where:{userId:id,
  kind:'mission_reward',referenceId:{in:refs}},select:{referenceId:true}});
 const set=new Set(claimed.map(x=>x.referenceId));
 return [{key:'three_orders',title:'3 pedidos este mes',
  progress:Math.min(3,orderCount),target:3,reward_points:100},
  {key:'two_restaurants',title:'Prueba 2 restaurantes',
   progress:Math.min(2,restaurantCount),target:2,reward_points:80}]
  .map(m=>({...m,claimed:set.has(m.key+':'+month.toISOString().slice(0,7)),
   claimable:m.progress>=m.target&&!set.has(m.key+':'+month.toISOString().slice(0,7))}));
}
v9Router.get('/loyalty/missions',async(req,res)=>{
 const who=await account(req);
 res.setHeader('Cache-Control','private, no-store');
 res.json(await missionStatus(who.id));
});
v9Router.post('/loyalty/missions/:missionKey/claim',async(req,res)=>{
 const who=await account(req);
 const key=Array.isArray(req.params.missionKey)?req.params.missionKey[0]:req.params.missionKey;
 if(!['three_orders','two_restaurants'].includes(String(key)))
  return bad(404,'Misión no encontrada');
 const result=await db.$transaction(async tx=>{
  const locked=await tx.$queryRawUnsafe(
   'SELECT id FROM loyalty_accounts WHERE user_id=$1 FOR UPDATE',who.id);
  if(!Array.isArray(locked)||!locked.length)return bad(404,'Cuenta Rewards no encontrada');
  const account=await tx.authLoyaltyAccount.findUnique({where:{userId:who.id}});
  if(!account)return bad(404,'Cuenta Rewards no encontrada');
  const date=new Date(),month=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1));
  const rows=await tx.marketOrder.findMany({where:{userId:who.id,status:'delivered',
   deliveredAt:{gte:month}},select:{restaurantId:true}});
  const done=(String(key)==='three_orders'?rows.length>=3:
   new Set(rows.map(x=>x.restaurantId)).size>=2);
  if(!done)return bad(409,'Misión aún no completada');
  const pts=String(key)==='three_orders'?100:80;
  const ref=String(key)+':'+month.toISOString().slice(0,7);
  const duplicate=await tx.stageWalletTransaction.findFirst({
   where:{userId:who.id,kind:'mission_reward',referenceId:ref}});
  if(duplicate)return bad(409,'Misión ya reclamada');
  const points=account.points+pts;
  if(points>2_000_000_000)return bad(409,'Saldo de puntos fuera de rango');
  await tx.authLoyaltyAccount.update({where:{userId:who.id},data:{points}});
  await tx.stageWalletTransaction.create({data:{userId:who.id,
   kind:'mission_reward',amount:'0',balanceAfter:account.walletBalance,
   referenceType:'loyalty_mission',referenceId:ref,description:'+'+pts+' puntos',
   idempotencyKey:'mission:'+who.id+':'+ref}});
  return {claimed:true,points_added:pts,points};
 },{maxWait:10000,timeout:20000});
 res.json(result);
});


// G3: Python V9 collaborative carts, corporate access, user privacy and sessions.
const gcode=(req:Request)=>{
 const raw=req.params.code;
 const key=(Array.isArray(raw)?raw[0]:raw)?.toUpperCase()??'';
 if(!/^[A-Z0-9]{4,12}$/.test(key))return bad(422,'Código de grupo inválido');
 return key;
};
async function groupSummary(code:string){
 const cart=await db.stageGroupCart.findUnique({where:{code},include:{items:true}});
 if(!cart)return bad(404,'Pedido grupal no encontrado');
 const ids=[...new Set(cart.items.map(x=>x.userId))],
  products=[...new Set(cart.items.map(x=>x.menuItemId))];
 const [users,menu]=await Promise.all([
  db.authUser.findMany({where:{id:{in:ids}},select:{id:true,name:true}}),
  db.marketplaceMenuItem.findMany({where:{id:{in:products}},select:{id:true,name:true}})]);
 const names=new Map(users.map(x=>[x.id,x.name])),
  labels=new Map(menu.map(x=>[x.id,x.name]));
 return {code,restaurant_id:cart.restaurantId,owner_user_id:cart.ownerUserId,
  locked:cart.locked,participants:new Set([cart.ownerUserId,...ids]).size,
  items:cart.items.sort((a,b)=>a.id-b.id).map(x=>({
   id:x.id,user_id:x.userId,user_name:names.get(x.userId)??'Usuario',
   menu_item_id:x.menuItemId,name:labels.get(x.menuItemId)??'Producto',
   quantity:x.quantity,options:x.options}))};
}
v9Router.post('/groups',async(req,res)=>{
 const who=await account(req),p=valid(z.strictObject({
  restaurant_id:z.number().int().positive()}),req.body);
 const shop=await db.marketplaceRestaurant.findUnique({where:{id:p.restaurant_id}});
 if(!shop?.isOpen)return bad(404,'Restaurante no disponible');
 const x=await db.stageGroupCart.create({data:{
  code:randomBytes(6).toString('hex').toUpperCase(),
  restaurantId:shop.id,ownerUserId:who.id}});
 res.status(201).json({id:x.id,code:x.code,restaurant_id:x.restaurantId,
  owner_user_id:x.ownerUserId,locked:x.locked});
});
v9Router.get('/groups/:code',async(req,res)=>{
 await account(req);res.setHeader('Cache-Control','private, no-store');
 res.json(await groupSummary(gcode(req)));
});
v9Router.post('/groups/:code/items',async(req,res)=>{
 const who=await account(req),code=gcode(req);
 const p=valid(z.strictObject({menu_item_id:z.number().int().positive(),
  quantity:z.number().int().min(1).max(20).default(1),
  options:z.string().max(500).default('')}),req.body);
 await db.$transaction(async tx=>{
  const lock=await tx.$queryRawUnsafe(
   'SELECT id FROM group_carts WHERE code=$1 FOR UPDATE',code);
  if(!Array.isArray(lock)||!lock.length)return bad(404,'Pedido grupal no encontrado');
  const cart=await tx.stageGroupCart.findUnique({where:{code}});
  if(!cart)return bad(404,'Pedido grupal no encontrado');
  if(cart.locked)return bad(409,'El pedido grupal ya está cerrado');
  const item=await tx.marketplaceMenuItem.findUnique({where:{id:p.menu_item_id}});
  if(!item||item.restaurantId!==cart.restaurantId||!item.isAvailable)
   return bad(400,'Producto no disponible en este grupo');
  await tx.stageGroupCartItem.upsert({
   where:{uq_group_cart_user_item:{
    groupCartId:cart.id,userId:who.id,menuItemId:item.id}},
   create:{groupCartId:cart.id,userId:who.id,menuItemId:item.id,
    quantity:p.quantity,options:p.options},
   update:{quantity:p.quantity,options:p.options}});
 },{maxWait:10000,timeout:15000});
 res.json(await groupSummary(code));
});
v9Router.post('/groups/:code/lock',async(req,res)=>{
 const who=await account(req),code=gcode(req);
 const cart=await db.stageGroupCart.findUnique({where:{code}});
 if(!cart||cart.ownerUserId!==who.id)return bad(404,'Pedido grupal no encontrado');
 await db.stageGroupCart.update({where:{id:cart.id},data:{locked:true}});
 res.json({code,locked:true});
});
v9Router.get('/groups/:code/checkout-payload',async(req,res)=>{
 const who=await account(req),code=gcode(req);
 const cart=await db.stageGroupCart.findUnique({where:{code},include:{items:true}});
 if(!cart||cart.ownerUserId!==who.id)return bad(404,'Pedido grupal no encontrado');
 const merged=new Map<number,number>();
 for(const item of cart.items)
  merged.set(item.menuItemId,(merged.get(item.menuItemId)??0)+item.quantity);
 res.setHeader('Cache-Control','private, no-store');
 res.json({restaurant_id:cart.restaurantId,group_code:code,
  items:Array.from(merged,([menu_item_id,quantity])=>({
   menu_item_id,quantity,options:''}))});
});
v9Router.post('/admin/corporate',async(req,res)=>{
 await account(req,['admin']);
 const p=valid(z.strictObject({name:z.string().min(2).max(180),
  monthly_budget:z.union([z.number(),z.string()]).transform(String)
   .refine(x=>/^\d{1,10}(?:\.\d{1,2})?$/.test(x)).default('0'),
  cost_center:z.string().max(80).default('GENERAL')}),req.body);
 const c=await db.stageCorporateAccount.create({data:{
  name:p.name,monthlyBudget:p.monthly_budget,costCenter:p.cost_center,
  joinCode:randomBytes(8).toString('hex').toUpperCase()}});
 res.status(201).json({id:c.id,name:c.name,join_code:c.joinCode,
  monthly_budget:c.monthlyBudget.toFixed(2),cost_center:c.costCenter});
});
v9Router.post('/corporate/join',async(req,res)=>{
 const who=await account(req);
 const p=valid(z.strictObject({join_code:z.string().min(4).max(30),
  employee_code:z.string().max(80).default('')}),req.body);
 const org=await db.stageCorporateAccount.findUnique({where:{
  joinCode:p.join_code.toUpperCase()}});
 if(!org?.active)return bad(404,'Código empresarial inválido');
 await db.stageCorporateMember.upsert({
  where:{uq_corporate_member:{corporateAccountId:org.id,userId:who.id}},
  create:{corporateAccountId:org.id,userId:who.id,employeeCode:p.employee_code},
  update:{}});
 res.setHeader('Cache-Control','private, no-store');
 res.json({joined:true,company:org.name,cost_center:org.costCenter,
  monthly_budget:org.monthlyBudget.toFixed(2)});
});
v9Router.get('/corporate/me',async(req,res)=>{
 const who=await account(req);
 const rows=await db.stageCorporateMember.findMany({
  where:{userId:who.id,active:true},include:{account:true}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.filter(x=>x.account.active).map(x=>({
  id:x.account.id,membership_id:x.id,company:x.account.name,
  cost_center:x.account.costCenter,employee_code:x.employeeCode,
  individual_budget:x.individualBudget.toFixed(2),
  monthly_budget:x.account.monthlyBudget.toFixed(2)})));
});
v9Router.post('/privacy',async(req,res)=>{
 const who=await account(req),p=valid(z.strictObject({
  request_type:z.enum(['export','delete','marketing_opt_out'])}),req.body);
 const result=await db.$transaction(async tx=>{
  if(p.request_type==='marketing_opt_out')await tx.authUser.update({
   where:{id:who.id},data:{marketingOptIn:false}});
  const orders=p.request_type==='export'?await tx.marketOrder.findMany({
   where:{userId:who.id},orderBy:{createdAt:'desc'},take:10000,
   select:{id:true,status:true,total:true,createdAt:true}}):[];
  const output=p.request_type==='export'?{
   profile:{id:who.id,name:who.name,email:who.email},
   orders:orders.map(o=>({id:o.id,status:o.status,
    total:o.total.toFixed(2),created_at:o.createdAt.toISOString()})),
   generated_at:new Date().toISOString()}:null;
  const completed=p.request_type==='export';
  const rec=await tx.stagePrivacyRequest.create({data:{
   userId:who.id,requestType:p.request_type,status:completed?'completed':'pending',
   resultJson:JSON.stringify(output??{}),completedAt:completed?new Date():null}});
  return {id:rec.id,type:p.request_type,status:rec.status,result:output};
 });
 res.setHeader('Cache-Control','private, no-store');
 res.status(201).json(result);
});
v9Router.get('/security/devices',async(req,res)=>{
 const who=await account(req);
 const rows=await db.authDeviceSession.findMany({where:{userId:who.id},
  orderBy:{lastSeenAt:'desc'}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,device:x.deviceLabel,ip_hint:x.ipHint,
  active:x.active,created_at:x.createdAt.toISOString(),
  last_seen_at:x.lastSeenAt.toISOString()})));
});
v9Router.delete('/security/devices/:deviceId',async(req,res)=>{
 const who=await account(req),id=param(req,'deviceId');
 const result=await db.authDeviceSession.updateMany({
  where:{id,userId:who.id},data:{active:false}});
 if(!result.count)return bad(404,'Sesión no encontrada');
 res.status(204).end();
});


// G3 follow-on: administrative CRM and restricted operational controls.
v9Router.get('/admin/segments',async(req,res)=>{
 await account(req,['admin']);
 const users=await db.authUser.findMany({where:{role:'customer',isActive:true},
  select:{id:true,name:true,email:true},orderBy:{id:'asc'},take:5000});
 const stats=await db.marketOrder.findMany({where:{
  userId:{in:users.map(x=>x.id)}},select:{
   userId:true,status:true,total:true,createdAt:true}});
 const byId=new Map<number,{n:number;spend:number;last:number|null}>();
 for(const o of stats){
  const a=byId.get(o.userId)??{n:0,spend:0,last:null};
  if(o.status==='delivered'){a.n++;a.spend+=Number(o.total);}
  const stamp=o.createdAt.getTime();a.last=Math.max(a.last??0,stamp);
  byId.set(o.userId,a);
 }
 const now=Date.now(),counts:Record<string,number>={};
 const profiles=users.map(u=>{
  const s=byId.get(u.id)??{n:0,spend:0,last:null};
  const days=s.last===null?null:Math.max(0,Math.floor((now-s.last)/86400000));
  const segment=s.n===0?'new':s.n>=20||s.spend>=8000?'vip':
   days!==null&&days>=30?'inactive':days!==null&&days>=14?'at_risk':
   s.n>=5?'frequent':'active';
  counts[segment]=(counts[segment]??0)+1;
  return {user_id:u.id,name:u.name,email:u.email,segment,
   orders:s.n,lifetime_value:s.spend.toFixed(2),days_since_last_order:days};
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json({counts,customers:profiles.slice(0,500)});
});
v9Router.post('/admin/marketing',async(req,res)=>{
 await account(req,['admin']);
 const p=valid(z.strictObject({
  name:z.string().min(2).max(180),
  trigger_type:z.enum(['inactive_7d','inactive_30d','birthday',
   'cart_abandoned','first_order','vip','at_risk']),
  segment:z.string().max(80).default('all'),
  channel:z.enum(['in_app','email']).default('in_app'),
  coupon_code:z.string().max(50).default(''),
  message_template:z.string().min(3).max(1000),
  active:z.boolean().default(true)}),req.body);
 const x=await db.stageMarketingAutomation.create({data:{
  name:p.name,triggerType:p.trigger_type,segment:p.segment,channel:p.channel,
  couponCode:p.coupon_code,messageTemplate:p.message_template,active:p.active}});
 res.status(201).json({id:x.id,name:x.name,trigger_type:x.triggerType,active:x.active});
});
v9Router.get('/admin/marketing',async(req,res)=>{
 await account(req,['admin']);
 const rows=await db.stageMarketingAutomation.findMany({
  orderBy:{createdAt:'desc'},take:500});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,name:x.name,trigger_type:x.triggerType,
  segment:x.segment,channel:x.channel,coupon_code:x.couponCode,
  active:x.active,last_run_at:x.lastRunAt?.toISOString()??null})));
});
v9Router.post('/admin/incentives',async(req,res)=>{
 await account(req,['admin']);
 const moneyField=z.union([z.number(),z.string()]).transform(String)
  .refine(v=>/^\d{1,8}(?:\.\d{1,2})?$/.test(v));
 const p=valid(z.strictObject({
  zone_name:z.string().max(120).default('General'),
  title:z.string().min(2).max(180),
  bonus_per_delivery:moneyField.default('0'),
  multiplier:moneyField.default('1'),
  starts_at:z.iso.datetime().nullable().default(null),
  ends_at:z.iso.datetime().nullable().default(null),
 }),req.body);
 if(Number(p.multiplier)<1||Number(p.multiplier)>5)return bad(422,'Multiplicador inválido');
 const now=new Date(),start=p.starts_at?new Date(p.starts_at):now,
  end=p.ends_at?new Date(p.ends_at):null;
 if(end&&end<start)return bad(422,'La fecha final precede a la inicial');
 const x=await db.stageDriverIncentive.create({data:{
  zoneName:p.zone_name,title:p.title,bonusPerDelivery:p.bonus_per_delivery,
  multiplier:p.multiplier,startsAt:start,endsAt:end}});
 res.status(201).json({id:x.id,zone_name:x.zoneName,title:x.title,
  bonus_per_delivery:x.bonusPerDelivery.toFixed(2),multiplier:x.multiplier.toFixed(2),
  active:x.active});
});
v9Router.get('/driver/incentives',async(req,res)=>{
 await account(req,['driver']);
 const now=new Date(),rows=await db.stageDriverIncentive.findMany({
  where:{active:true,startsAt:{lte:now},OR:[{endsAt:null},{endsAt:{gte:now}}]}});
 res.setHeader('Cache-Control','private, no-store');
 res.json(rows.map(x=>({id:x.id,zone_name:x.zoneName,title:x.title,
  bonus_per_delivery:x.bonusPerDelivery.toFixed(2),
  multiplier:x.multiplier.toFixed(2),
  ends_at:x.endsAt?.toISOString()??null})));
});
v9Router.get('/admin/dispatch/batches',async(req,res)=>{
 await account(req,['admin']);
 // Python deliberately disables batching: one active delivery per driver.
 res.json([]);
});
v9Router.post('/admin/dispatch/batch-assign',async(req,res)=>{
 await account(req,['admin']);
 return bad(409,'La asignación múltiple está deshabilitada: cada repartidor puede tener solo una entrega activa');
});
v9Router.patch('/admin/restaurants/:restaurantId/market',async(req,res)=>{
 await account(req,['admin']);const id=param(req,'restaurantId');
 const market=typeof req.query.market_code==='string'?
  req.query.market_code.trim().toUpperCase().slice(0,40):'';
 if(!market||!/^[A-Z0-9_-]{2,40}$/.test(market))
  return bad(422,'Mercado inválido');
 const name=typeof req.query.brand_name==='string'?
  req.query.brand_name.trim().slice(0,150):'';
 const branch=typeof req.query.branch_code==='string'?
  req.query.branch_code.trim().toUpperCase().slice(0,40):'MAIN';
 const found=await db.marketplaceRestaurant.findUnique({where:{id}});
 if(!found)return bad(404,'Restaurante no encontrado');
 const updated=await db.marketplaceRestaurant.update({where:{id},
  data:{marketCode:market,brandName:name,branchCode:branch}});
 res.json({id:updated.id,market_code:updated.marketCode,
  brand_name:updated.brandName,branch_code:updated.branchCode});
});
v11Router.put('/privacy/preferences',async(req,res)=>{
 const who=await account(req);
 const p=valid(z.strictObject({
  marketing_opt_in:z.boolean().nullable().default(null),
  analytics_opt_in:z.boolean().nullable().default(null),
  personalization_opt_in:z.boolean().nullable().default(null)}),req.body);
 const updated=await db.$transaction(async tx=>{
  const row=await tx.authUser.update({where:{id:who.id},data:{
   ...(p.marketing_opt_in!==null?{marketingOptIn:p.marketing_opt_in}:{}),
   ...(p.analytics_opt_in!==null?{analyticsOptIn:p.analytics_opt_in}:{}),
   ...(p.personalization_opt_in!==null?{personalizationOptIn:p.personalization_opt_in}:{})}});
  await tx.authAuditEvent.create({data:{userId:who.id,
   action:'v11.privacy.preferences',entityType:'user',entityId:String(who.id),
   detail:JSON.stringify(p)}});
  return row;
 });
 res.setHeader('Cache-Control','private, no-store');
 res.json({marketing_opt_in:updated.marketingOptIn,
  analytics_opt_in:updated.analyticsOptIn,
  personalization_opt_in:updated.personalizationOptIn});
});


// H1: V11 stage-only safe HTTP flows, no LIVE push/PSP/map provider.
v11Router.put('/admin/canary',async(req,res)=>{
 const who=await account(req,['admin']);
 const p=valid(z.strictObject({percent:z.number().int().min(0).max(100)}),req.body);
 await db.$transaction(async tx=>{
  await tx.stageSystemSetting.upsert({where:{key:'v11.canary_percent'},
   create:{key:'v11.canary_percent',value:String(p.percent),valueType:'integer',
    description:'Porcentaje rollout V11',updatedByUserId:who.id},
   update:{value:String(p.percent),updatedByUserId:who.id}});
  await tx.authAuditEvent.create({data:{userId:who.id,action:'v11.canary.update',
   entityType:'system_setting',entityId:'v11.canary_percent',
   detail:String(p.percent)}});
 });
 res.json({canary_percent:p.percent});
});
const pushPublic=(x:{
 id:number;platform:string;deviceLabel:string;active:boolean;
 createdAt:Date;updatedAt:Date;
})=>({id:x.id,platform:x.platform,device_label:x.deviceLabel,
 active:x.active,created_at:x.createdAt.toISOString(),
 updated_at:x.updatedAt.toISOString()});
v11Router.post('/push/subscriptions',async(req,res)=>{
 const who=await account(req);
 const p=valid(z.strictObject({
  endpoint:z.url().min(20).max(1200),
  p256dh:z.string().max(300).default(''),
  auth:z.string().max(300).default(''),
  platform:z.enum(['web','android','ios']).default('web'),
  device_label:z.string().max(200).default(''),
 }),req.body);
 if(!p.endpoint.startsWith('https://'))return bad(422,'Push requiere HTTPS');
 // Endpoints are bearer capabilities; one endpoint can only belong to one
 // current account. Serialize cross-worker moves by PostgreSQL advisory lock.
 const created=await db.$transaction(async tx=>{
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',
   p.endpoint);
  await tx.stagePushSubscription.updateMany({where:{
   endpoint:p.endpoint,userId:{not:who.id},active:true},data:{active:false}});
  return tx.stagePushSubscription.upsert({
   where:{uq_push_user_endpoint:{userId:who.id,endpoint:p.endpoint}},
   create:{userId:who.id,endpoint:p.endpoint,p256dh:p.p256dh,auth:p.auth,
    platform:p.platform,deviceLabel:p.device_label,active:true},
   update:{p256dh:p.p256dh,auth:p.auth,platform:p.platform,
    deviceLabel:p.device_label,active:true}});
 },{maxWait:10000,timeout:15000});
 res.setHeader('Cache-Control','private, no-store');
 res.status(201).json(pushPublic(created));
});
v11Router.delete('/push/subscriptions/:subscriptionId',async(req,res)=>{
 const who=await account(req),id=param(req,'subscriptionId');
 const updated=await db.stagePushSubscription.updateMany({where:{
  id,...(who.role!=='admin'?{userId:who.id}:{})},data:{active:false}});
 if(!updated.count)return bad(404,'Suscripción no encontrada');
 res.status(204).end();
});
v11Router.post('/maps/geocode',async(req,res)=>{
 await account(req);
 const p=valid(z.strictObject({query:z.string().min(3).max(300),
  limit:z.number().int().min(1).max(10).default(5)}),req.body);
 const rows=await db.marketplaceRestaurant.findMany({where:{isOpen:true,
  OR:[{name:{contains:p.query,mode:'insensitive'}},
   {address:{contains:p.query,mode:'insensitive'}}]},
  take:p.limit,orderBy:{id:'asc'}});
 // DB-backed local Tala marketplace directory ONLY, not street-level geocode.
 res.json({query:p.query,results:rows.map(x=>({
  label:x.name,lat:x.lat,lng:x.lng,address:x.address,
  source:'verified-marketplace-record'})),
  provider:'local-catalog',provider_status:'no-external-geocoder'});
});
v11Router.post('/maps/route',async(req,res)=>{
 await account(req);
 const n=z.number().finite(),p=valid(z.strictObject({
  origin_lat:n.min(-90).max(90),origin_lng:n.min(-180).max(180),
  destination_lat:n.min(-90).max(90),destination_lng:n.min(-180).max(180),
 }),req.body);
 const km=haversine(p.origin_lat,p.origin_lng,
  p.destination_lat,p.destination_lng);
 const kmRoad=km*1.3;
 res.json({distance_km:round(kmRoad,2),
  duration_minutes:Math.max(1,Math.round(kmRoad/25*60)),
  source:'haversine-road-factor-estimate',precise_road_route:false,
  provider:'local-stage',real_time_traffic:false});
});
const liveStages=['received','confirmed','preparing','ready',
 'assigned','picked_up','on_the_way','delivered'];
v11Router.get('/orders/:orderId/live',async(req,res)=>{
 const who=await account(req),id=param(req,'orderId');
 const order=await authorizedOrder(id,who);
 const events=await db.stageOrderEvent.findMany({where:{orderId:id},
  orderBy:[{createdAt:'asc'},{id:'asc'}]});
 const idx=liveStages.indexOf(order.status);
 // Never derive driver GPS from stale DB fields: only verified fresh
 // post-assignment Redis GPS would be safe, and is not enabled in H1.
 const output={id:order.id,user_id:order.userId,restaurant_id:order.restaurantId,
  driver_id:order.driverId,status:order.status,order_type:order.orderType,
  payment_status:order.paymentStatus,total:order.total.toFixed(2),
  delivery_fee:order.deliveryFee.toFixed(2),
  estimated_minutes:order.estimatedMinutes,
  ...(who.id===order.userId?{delivery_pin:order.deliveryPin}:{})};
 res.setHeader('Cache-Control','private, no-store');
 res.json({order:output,timeline:events.map(e=>({
  status:e.status,at:e.createdAt.toISOString(),metadata:e.metadataJson})),
  stages:liveStages.map((key,i)=>({key,done:idx>=i,active:key===order.status})),
  route:null,driver_location:null,
  next_action:order.status==='delivered'?'rate':
   order.status==='on_the_way'?'delivery_pin':'track'});
});
