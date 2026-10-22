// Realistic 500-order load test. Fake customers and isolated CI PG15/Redis8 ONLY.
// No external hosts, no real Stripe, no Kali writes, no shared production data.
import assert from 'node:assert/strict';
import pg from 'pg';
import {Redis} from 'ioredis';
import {performance} from 'node:perf_hooks';
import {writeFile,appendFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const pgurl=String(process.env.DATABASE_URL??'');
const redisUrl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||
 process.env.NODE_ENV!=='staging'||
 process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
 process.env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'||
 !pgurl.includes('127.0.0.1:15435/tala_node_stage')||
 !redisUrl.includes('127.0.0.1:16379/0')||
 process.env.HOST!=='127.0.0.1'||
 process.env.PORT!=='18190')throw Error('FIVE_HUNDRED_ORDERS_DISPOSABLE_CI_ONLY');

const db=new pg.Client({connectionString:pgurl});
await db.connect();
const base='http://127.0.0.1:18190/api/v1';
const stamp='q500'+process.pid,pass='FiveHundred-Only-Synthetic-CI-2026!';
const samples=[],checks=[],anomalies=[],waves=[],resources=[];
let created=[],cancelled=[],delivered=[],started=performance.now(),lastStep='setup';
const reportPath='/tmp/talaeats-500-orders-load-report.json';
const serverPid=Number(process.env.STRESS_SERVER_PID);
const poll=Number.isSafeInteger(serverPid)&&serverPid>0?setInterval(()=>{
 try{
  const output=execFileSync('ps',['-p',String(serverPid),'-o','rss=,%cpu='],
   {encoding:'utf8',timeout:1200}).trim().split(/\s+/);
  if(output.length===2)resources.push({rssMb:Math.round(Number(output[0])/1024*10)/10,
   cpuPct:Number(output[1])});
 }catch{}
},600):null;
async function api(route,{token,method='GET',body}={}){
 const time=performance.now();
 let code=0,json=null;
 try{
  const r=await fetch(base+route,{
   method,
   headers:{accept:'application/json','content-type':'application/json',
    'x-talaeats-client':'customer-mobile',
    ...(token?{authorization:'Bearer '+token}:{})},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),
   signal:AbortSignal.timeout(20_000),
  });
  code=r.status;
  try{json=await r.json();}catch{}
  return{code,json};
 }catch(err){
  anomalies.push({type:'network',stage:lastStep,message:err instanceof Error?err.message:'error'});
  throw err;
 }finally{
  samples.push({method,route:route.replace(/\/[0-9]+(?=\/|$)/g,'/:id'),
   code,ms:performance.now()-time});
 }
}
const tick=async()=>{for(let i=0;i<60;i++){
 try{if((await api('/ready')).json?.ready)return;}catch{}
 await new Promise(resolve=>setTimeout(resolve,200));
}throw Error('LOAD_TEST_API_NOT_READY');};
const pool=async(jobs,max)=>{
 let cursor=0;const results=new Array(jobs.length);
 await Promise.all(Array.from({length:Math.min(max,jobs.length)},async()=>{
  while(cursor<jobs.length){const i=cursor++;results[i]=await jobs[i]();}
 }));
 return results;
};
const percentile=(arr,q)=>{
 if(!arr.length)return null;
 const xs=[...arr].sort((a,b)=>a-b);
 return Number(xs[Math.ceil(xs.length*q)-1].toFixed(1));
};
const metricsFor=(begin)=>{
 const xs=samples.slice(begin);
 const timings=xs.filter(s=>s.code>0).map(s=>s.ms);
 const distribution={};
 for(const s of xs)distribution[String(s.code)]=(distribution[String(s.code)]??0)+1;
 return{requests:xs.length,codes:distribution,latency_ms:{
  p50:percentile(timings,.5),p95:percentile(timings,.95),p99:percentile(timings,.99),
  max:percentile(timings,1)}};
};
const generate=()=>{
 const all=samples.filter(s=>s.code!==0&&s.route!=='/ready');
 const pgCounts=Object.fromEntries([...new Set(samples.map(s=>s.code))].map(n=>[
  String(n),samples.filter(s=>s.code===n).length]));
 return{title:'Tala Eats Node RC4 — 500 simulated orders under bounded concurrency',
  environment:'GitHub Actions Ubuntu runner: isolated PostgreSQL 15 + Redis 8',
  production_ready:false,payments_live:false,currency:'MXN',
  planned_orders:500,accepted_orders:created.length,
  delivered_orders:delivered.length,cancelled_orders:cancelled.length,
  fake_customers:7,fake_restaurants:5,
  total_http_requests:samples.length,response_codes:pgCounts,
  readiness_connection_attempts:samples.filter(s=>s.code===0&&s.route==='/ready').length,
  load_network_errors:samples.filter(s=>s.code===0&&s.route!=='/ready').length,
  duration_ms:Number((performance.now()-started).toFixed(1)),
  latency_ms:{p50:percentile(all.map(s=>s.ms),.5),
   p95:percentile(all.map(s=>s.ms),.95),
   p99:percentile(all.map(s=>s.ms),.99)},
  max_node_memory_rss_mb:resources.length?Math.max(...resources.map(x=>x.rssMb)):null,
  max_node_cpu_sample_pct:resources.length?Math.max(...resources.map(x=>x.cpuPct)):null,
  waves,checks,anomalies,
  limitation:'CI localhost only; not capacity proof for Kali. Stripe and delivery commercially disabled.'};
};
async function snapshot(failure){
 const result=generate();
 if(failure)result.failed_at=lastStep,result.failure=String(failure);
 await writeFile(reportPath,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log('FIVE_HUNDRED_ORDER_TEST_REPORT='+JSON.stringify(result));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,
  ['## Tala Eats · prueba de 500 pedidos ficticios',
   '**Pedidos aceptados: '+result.accepted_orders+'/500** · recogidos: '+result.delivered_orders+
     ' · cancelados: '+result.cancelled_orders+' · pruebas: '+checks.length,
   'HTTP: '+result.total_http_requests+' · p95 '+result.latency_ms.p95+' ms · p99 '+result.latency_ms.p99+' ms.',
   'CPU pico muestreado: '+result.max_node_cpu_sample_pct+'% · RSS máximo: '+result.max_node_memory_rss_mb+' MB.',
   'Anomalías: '+(anomalies.length?JSON.stringify(anomalies):'0')+'.',
   '**Prueba CI con datos ficticios y sin cobros reales; no prueba capacidad de Kali.**',
   ...checks.map(x=>'- ✅ '+x),''].join('\n'));
}
async function users(label){
 const email=stamp+label+'@example.test';
 const result=await api('/auth/register',{method:'POST',body:{
  email,name:'Usuario prueba '+label,password:pass}});
 assert.equal(result.code,201,JSON.stringify(result.json));
 return{id:result.json.user.id,email,token:result.json.access_token};
}
async function stock(shop){
 const rs=await db.query('SELECT stock FROM menu_items WHERE id=$1',[shop.menu]);
 const ingredient=await db.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',
  [shop.ingredient]);
 return{menu:Number(rs.rows[0].stock),ingredient:Number(ingredient.rows[0].quantity)};
}
async function requireStock(shops,expected){
 for(let i=0;i<shops.length;i++)
  assert.deepEqual(await stock(shops[i]),{menu:expected,ingredient:expected},
   'Shop '+i+' inventory mismatch');
}
const orderPayload=(shop,ref)=>({
 restaurant_id:shop.id,address:'Recoger en mostrador QA',
 items:[{menu_item_id:shop.menu,quantity:1,options:''}],
 payment_method:'cash',order_type:'pickup',client_reference:ref,
 coupon_code:'',delivery_lat:null,delivery_lng:null,tip:'0.00'});
const buy=(u,shop,ref)=>api('/orders',{
 token:u.token,method:'POST',body:orderPayload(shop,ref)});
async function cancel(o,u){
 const response=await api('/orders/'+o.id+'/cancel',{token:u.token,method:'POST'});
 assert.equal(response.code,200,JSON.stringify(response.json));
 assert.equal(response.json.status,'cancelled');
 return response;
}
async function pickup(o,shop){
 for(const status of ['confirmed','preparing','ready']){
  const r=await api('/owner/orders/'+o.id+'/status',{
   token:shop.owner.token,method:'PATCH',body:{status}});
  assert.equal(r.code,200,JSON.stringify(r.json));
 }
 const finished=await api('/owner/orders/'+o.id+'/complete',{
  token:shop.owner.token,method:'POST',body:{pin:o.delivery_pin}});
 assert.equal(finished.code,200,JSON.stringify(finished.json));
 assert.equal(finished.json.status,'delivered');
 return finished;
}
try{
 lastStep='api ready';await tick();
 lastStep='clear isolated auth rate-limit keys';
 const redis=new Redis(redisUrl);
 try{
  let cursor='0';
  do{
   const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
   if(keys.length)await redis.del(...keys);
   cursor=next;
  }while(cursor!=='0');
 }finally{redis.disconnect();}
 lastStep='seed 5 shops and 7 customers';
 // Authentication guard limits registration to 12/min from one CI IP.
 // Exactly 5 owners + 7 customers.
 const owners=[];
 for(let i=0;i<5;i++)owners.push(await users('owner'+i));
 const buyers=[];
 for(let i=0;i<7;i++)buyers.push(await users('buyer'+i));
 await db.query("UPDATE users SET role='restaurant' WHERE id=ANY($1::int[])",
  [owners.map(x=>x.id)]);
 const shops=[];
 const prices=[39.90,55,80,110,23.50];
 for(let i=0;i<owners.length;i++){
  const owner=owners[i];
  const login=await api('/auth/login',{method:'POST',body:{
   email:owner.email,password:pass}});
  assert.equal(login.code,200,JSON.stringify(login.json));
  owner.token=login.json.access_token;
  const row=await db.query(
   "INSERT INTO restaurants(name,owner_id,address,is_open,pickup_enabled,verification_status,market_code)"+
   " VALUES($1,$2,'Centro Tala',true,true,'verified','TALA-JAL') RETURNING id",
   ['Prueba Restaurante '+(i+1),owner.id]);
  const id=row.rows[0].id;
  const menu=await api('/owner/menu',{method:'POST',token:owner.token,body:{
   name:'Producto QA '+i,price:prices[i].toFixed(2),stock:100,
   description:'Solo laboratorio 500 pedidos',is_available:true}});
  assert.equal(menu.code,201,JSON.stringify(menu.json));
  const ing=await db.query(
   "INSERT INTO ingredient_stocks(restaurant_id,name,quantity,unit) VALUES($1,$2,100.000,'kg') RETURNING id",
   [id,'Ingrediente QA '+i]);
  await db.query(
   "INSERT INTO menu_recipes(menu_item_id,ingredient_id,quantity_required) VALUES($1,$2,1.000)",
   [menu.json.id,ing.rows[0].id]);
  shops.push({id,owner,menu:menu.json.id,ingredient:ing.rows[0].id,price:prices[i]});
 }
 checks.push('5 comercios, 7 compradores, catálogo, recetas, stock 100 por tienda');
 const methods=await api('/orders/payment-methods',{token:buyers[0].token});
 assert.equal(methods.code,200);
 assert.equal(methods.json.methods.find(x=>x.id==='stripe').enabled,false);
 const specs=Array.from({length:500},(_,i)=>({
  shop:shops[i%5],buyer:buyers[i%7],reference:stamp+'-sale-'+i,index:i,
 }));
 lastStep='500 unique purchases, controlled concurrency';
 const waveSizes=[{size:100,parallel:8},{size:200,parallel:12},{size:200,parallel:16}];
 let offset=0;
 for(let phase=0;phase<waveSizes.length;phase++){
  const wave=waveSizes[phase],batch=specs.slice(offset,offset+wave.size);
  const begin=samples.length,when=performance.now();
  const responses=await pool(batch.map(s=>()=>buy(s.buyer,s.shop,s.reference)),wave.parallel);
  const errors=[];
  for(let i=0;i<responses.length;i++){
   const response=responses[i];
   if(response.code===201)created.push({...response.json,spec:batch[i]});
   else errors.push({request:batch[i].index,status:response.code,detail:response.json?.detail});
  }
  const outcome={wave:phase+1,concurrency:wave.parallel,attempted:wave.size,
   created:responses.length-errors.length,failures:errors.slice(0,30),
   duration_ms:Number((performance.now()-when).toFixed(1)),...metricsFor(begin)};
  waves.push(outcome);
  if(errors.length){
   anomalies.push({type:'purchase_wave_failure',...outcome});
   throw Error('FAILED_500_ORDERS_WAVE_'+(phase+1)+'_'+errors.length+'_FAILURES');
  }
  offset+=wave.size;
 }
 assert.equal(created.length,500);
 checks.push('500 pedidos HTTP 201 en 3 oleadas (concurrencia 8/12/16)');
 await requireStock(shops,0);
 checks.push('Sin sobreventa: cinco inventarios de menú e ingredientes agotados a cero');
 lastStep='stockouts, 50 rejected purchases';
 const failed=await pool(Array.from({length:50},(_,i)=>()=>buy(
  buyers[i%7],shops[i%5],stamp+'-stockout-'+i)),12);
 assert.ok(failed.every(r=>r.code===400),
  JSON.stringify(failed.filter(r=>r.code!==400).slice(0,10)));
 await requireStock(shops,0);
 checks.push('50 intentos sin stock rechazados sin inventario negativo');
 lastStep='idempotency same reference';
 const first=created[0],repeated=await pool(Array.from({length:60},()=>()=>buy(
  first.spec.buyer,first.spec.shop,first.spec.reference)),12);
 assert.ok(repeated.every(r=>r.code===201&&r.json.id===first.id),
  JSON.stringify(repeated.filter(r=>r.code!==201).slice(0,10)));
 const changed=await api('/orders',{token:first.spec.buyer.token,method:'POST',
  body:{...orderPayload(first.spec.shop,first.spec.reference),notes:'Different payload'}});
 assert.equal(changed.code,409);
 checks.push('60 reintentos de la misma compra sin duplicado + conflicto 409');
 lastStep='cancel 150 orders';
 // 30 per shop: 150 cancelled. Cancelled orders remain in the history.
 const cancelledOrders=created.filter((o)=>Math.floor(o.spec.index/5)%10<3);
 const deliveredOrders=created.filter((o)=>Math.floor(o.spec.index/5)%10>=3);
 assert.equal(cancelledOrders.length,150);
 assert.equal(deliveredOrders.length,350);
 const cancellations=await pool(cancelledOrders.map(o=>()=>cancel(o,o.spec.buyer)),12);
 cancelled=cancelledOrders;
 assert.equal(cancellations.length,150);
 await requireStock(shops,30);
 checks.push('150 cancelaciones HTTP 200, stock restaurado exactamente una vez');
 lastStep='complete 350 pickup orders';
 // Customer journey: received -> confirmed -> preparing -> ready -> PIN -> delivered.
 const finished=await pool(deliveredOrders.map(o=>()=>pickup(o,o.spec.shop)),12);
 delivered=deliveredOrders;
 assert.equal(finished.length,350);
 await requireStock(shops,30);
 checks.push('350 compras completadas con preparación y PIN');
 lastStep='verify SQL financial, idempotency, events and invariants';
 const shopIds=shops.map(s=>s.id);
 const orders=(await db.query(
  "SELECT id,restaurant_id,status,payment_method,payment_status,total,cash_collected,client_reference,inventory_restored_at"+
  " FROM orders WHERE restaurant_id=ANY($1::int[])",
  [shopIds])).rows;
 assert.equal(orders.length,500);
 assert.equal(new Set(orders.map(o=>o.client_reference)).size,500);
 assert.equal(orders.filter(o=>o.status==='delivered').length,350);
 assert.equal(orders.filter(o=>o.status==='cancelled').length,150);
 for(const order of orders){
  assert.equal(order.payment_method,'cash');
  if(order.status==='delivered'){
   assert.equal(order.payment_status,'paid');
   assert.equal(order.cash_collected,order.total);
   assert.equal(order.inventory_restored_at,null);
  }else{
   assert.equal(order.payment_status,'pending');
   assert.ok(order.inventory_restored_at);
   assert.equal(Number(order.cash_collected),0);
  }
 }
 checks.push('500 referencias únicas y dinero solo en pedidos entregados (efectivo sintético)');
 const ledger=(await db.query(
  "SELECT kind,account,COUNT(*)::int n FROM financial_ledger_entries"+
  " WHERE restaurant_id=ANY($1::int[]) GROUP BY kind,account",
  [shopIds])).rows;
 for(const [kind,expected] of [['order_settlement',500],['order_cancellation',150]]){
  for(const account of ['gmv','restaurant_payable','platform_revenue','contribution_margin']){
   const x=ledger.find(x=>x.kind===kind&&x.account===account);
   assert.equal(x?.n,expected,kind+'/'+account);
  }
 }
 checks.push('2,000 asientos originales + 600 reversos consistentes');
 const outbox=(await db.query(
  "SELECT event_key,COUNT(*)::int n FROM event_outbox"+
  " WHERE aggregate_type='order' AND aggregate_id=ANY($1::text[]) GROUP BY event_key",
  [orders.map(o=>String(o.id))])).rows;
 assert.ok(outbox.every(x=>x.n===1));
 assert.equal(outbox.filter(x=>x.event_key.endsWith(':created')).length,500);
 assert.equal(outbox.filter(x=>x.event_key.endsWith(':cancelled')).length,150);
 assert.equal(outbox.filter(x=>x.event_key.endsWith(':delivered')).length,350);
 checks.push('Eventos de pedido sin duplicados');
 assert.equal((await api('/orders/'+created[0].id,{
  token:buyers[(created[0].spec.index%7+1)%7].token})).code,403);
 assert.equal((await api('/orders',{method:'POST',token:buyers[0].token,
  body:{...orderPayload(shops[0],stamp+'-stripe'),payment_method:'stripe'}})).code,503);
 assert.equal((await db.query(
  "SELECT COUNT(*)::int n FROM orders WHERE restaurant_id=ANY($1::int[])",[shopIds])).rows[0].n,500);
 checks.push('Autorización entre compradores y Stripe bloqueado');
 const bad=samples.filter(s=>(s.code===0&&s.route!=='/ready')||(s.code>=500&&s.code!==503));
 assert.equal(bad.length,0,'Unexpected 5xx or network errors');
 checks.push('Cero errores HTTP 5xx inesperados y cero cargos reales');
 console.log('FIVE_HUNDRED_ORDER_LOAD_PASS=500');
}catch(err){
 anomalies.push({type:'failure',at:lastStep,error:err instanceof Error?err.message:'unknown'});
 console.error('FIVE_HUNDRED_ORDER_LOAD_FAIL='+lastStep);
 console.error(err);
 process.exitCode=1;
}finally{
 if(poll)clearInterval(poll);
 try{await snapshot(process.exitCode?anomalies.at(-1)?.error:undefined);}
 catch(e){console.error('ERROR_WRITING_500_LOAD_REPORT',e);process.exitCode=1;}
 await db.end();
}
