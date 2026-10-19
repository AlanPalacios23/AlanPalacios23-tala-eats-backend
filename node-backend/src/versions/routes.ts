// F1: Python v9/v10/v11 customer/merchant observability and read contracts.
// Metadata is explicit NODE STAGING to avoid falsely advertising LIVE PSP/WS.
import { createHash } from 'node:crypto';
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
 const limit=numberArg(req,'limit',20,1,50);
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
