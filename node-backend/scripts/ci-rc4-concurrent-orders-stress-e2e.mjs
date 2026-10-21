// Concurrent checkout/fulfillment tests. ONLY disposable GitHub Actions PG15 + Redis8.
// No remote hosts, Kali, shared databases or real money.
import assert from 'node:assert/strict';
import pg from 'pg';
import {Redis} from 'ioredis';
import {performance} from 'node:perf_hooks';
import {writeFile,appendFile} from 'node:fs/promises';
const pgurl=String(process.env.DATABASE_URL??'');
const redisUrl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||process.env.NODE_ENV!=='staging'||
 process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
 process.env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'||
 !pgurl.includes('127.0.0.1:15435/tala_node_stage')||
 !redisUrl.includes('127.0.0.1:16379/0'))throw Error('STRESS_DISPOSABLE_CI_ONLY');
const db=new pg.Client({connectionString:pgurl});
await db.connect();
const redis=new Redis(redisUrl);
try{
 let cursor='0';
 do{
  const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
  if(keys.length)await redis.del(...keys);
  cursor=next;
 }while(cursor!=='0');
}finally{redis.disconnect();}
const base='http://127.0.0.1:18190/api/v1';
const start=performance.now(),stats=[],checks=[];
async function call(route,{token,method='GET',body}={}){
 const t=performance.now();
 const r=await fetch(base+route,{method,headers:{
  'content-type':'application/json','x-talaeats-client':'customer-mobile',
  ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
  signal:AbortSignal.timeout(15_000)});
 let json=null;try{json=await r.json();}catch{}
 stats.push({code:r.status,ms:performance.now()-t,method});
 return {code:r.status,json};
}
async function wait(){
 for(let i=0;i<35;i++){
  try{const r=await call('/ready');if(r.code===200&&r.json?.ready)return;}catch{}
  await new Promise(ok=>setTimeout(ok,200));
 }
 throw Error('API_NOT_READY');
}
await wait();
const pwd='RC4-Stress-Synthetic-Only-2026!',tag='stress'+process.pid;
async function register(label){
 const email=tag+label+'@example.test';
 const r=await call('/auth/register',{method:'POST',body:{name:'QA '+label,email,password:pwd}});
 assert.equal(r.code,201,JSON.stringify(r.json));
 return{id:r.json.user.id,email,token:r.json.access_token};
}
const owner=await register('owner'),buyers=[];
for(let i=0;i<6;i++)buyers.push(await register('buyer'+i));
await db.query("UPDATE users SET role='restaurant' WHERE id=$1",[owner.id]);
const login=await call('/auth/login',{method:'POST',body:{email:owner.email,password:pwd}});
assert.equal(login.code,200);
owner.token=login.json.access_token;
const rid=(await db.query(
 "INSERT INTO restaurants(name,owner_id,address,is_open,pickup_enabled,verification_status,market_code) VALUES('RC4 Load QA',$1,'Tala',true,true,'verified','TALA-JAL') RETURNING id",
 [owner.id])).rows[0].id;
const menu=await call('/owner/menu',{token:owner.token,method:'POST',body:{
 name:'Quesadilla de laboratorio',price:'49.90',stock:18,
 description:'Solo pruebas',is_available:true}});
assert.equal(menu.code,201,JSON.stringify(menu.json));
const mid=menu.json.id;
const ingredient=(await db.query(
 "INSERT INTO ingredient_stocks(restaurant_id,name,quantity,unit) VALUES($1,'Masa',18.000,'kg') RETURNING id",
 [rid])).rows[0].id;
await db.query("INSERT INTO menu_recipes(menu_item_id,ingredient_id,quantity_required) VALUES($1,$2,1.000)",[mid,ingredient]);
checks.push('7 identidades, producto y receta en entorno privado');
const payload=ref=>({restaurant_id:rid,address:'Recoger en mostrador',
 items:[{menu_item_id:mid,quantity:1,options:''}],
 payment_method:'cash',order_type:'pickup',client_reference:ref,
 coupon_code:'',delivery_lat:null,delivery_lng:null,tip:'0.00'});
const buy=(who,ref)=>call('/orders',{token:who.token,method:'POST',body:payload(ref)});
const getStock=async()=>{
 const m=await db.query('SELECT stock FROM menu_items WHERE id=$1',[mid]);
 const i=await db.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',[ingredient]);
 return{menu:m.rows[0].stock,ingredient:i.rows[0].quantity};
};
const assertStock=async n=>assert.deepEqual(await getStock(),{menu:n,ingredient:n+'.000'});
async function pool(jobs,max=6){
 const out=new Array(jobs.length);let pos=0;
 await Promise.all(Array.from({length:Math.min(max,jobs.length)},async()=>{
  while(pos<jobs.length){const i=pos++;out[i]=await jobs[i]();}
 }));
 return out;
}
const firstRefs=Array.from({length:18},(_,i)=>tag+'-first-'+i);
const first=await pool(firstRefs.map((r,i)=>()=>buy(buyers[i%6],r)),6);
assert.ok(first.every(x=>x.code===201),JSON.stringify(first.map(x=>[x.code,x.json?.detail])));
const orders=first.map(x=>x.json);
assert.equal(new Set(orders.map(x=>x.id)).size,18);
await assertStock(0);
checks.push('18 compras concurridas aceptadas; sin vender doble stock');
const overflow=await pool(Array.from({length:12},(_,i)=>
 ()=>buy(buyers[i%6],tag+'-overflow-'+i)),6);
assert.ok(overflow.every(x=>x.code===400),JSON.stringify(overflow.map(x=>[x.code,x.json?.detail])));
await assertStock(0);
checks.push('12 compras sin existencias denegadas, stock no negativo');
const retries=await pool(Array.from({length:16},()=>()=>buy(buyers[0],firstRefs[0])),8);
assert.ok(retries.every(x=>x.code===201&&x.json.id===orders[0].id));
const mutation=await call('/orders',{token:buyers[0].token,method:'POST',
 body:{...payload(firstRefs[0]),notes:'Cambio concurrente'}});
assert.equal(mutation.code,409);
checks.push('16 reintentos idempotentes, misma referencia modificada rechazada');
async function cancel(o,who){
 const results=await Promise.all(Array.from({length:3},()=>call(
  '/orders/'+o.id+'/cancel',{token:who.token,method:'POST'})));
 assert.ok(results.every(x=>x.code===200&&x.json?.status==='cancelled'),
  JSON.stringify(results.map(x=>[x.code,x.json?.detail])));
}
async function deliver(o){
 for(const status of ['confirmed','preparing','ready']){
  const v=await call('/owner/orders/'+o.id+'/status',{
   token:owner.token,method:'PATCH',body:{status}});
  assert.equal(v.code,200,JSON.stringify(v.json));
 }
 const results=await Promise.all(Array.from({length:2},()=>call(
  '/owner/orders/'+o.id+'/complete',{token:owner.token,method:'POST',
   body:{pin:o.delivery_pin}})));
 assert.ok(results.every(x=>x.code===200&&x.json?.status==='delivered'));
}
await pool(orders.slice(0,9).map((o,i)=>()=>cancel(o,buyers[i%6])),4);
await assertStock(9);
checks.push('9 cancelaciones x3 intentos; restauración única');
await pool(orders.slice(9).map(o=>()=>deliver(o)),4);
await assertStock(9);
checks.push('9 recogidas con preparación KDS, PIN y doble confirmación');
const secondRefs=Array.from({length:9},(_,i)=>tag+'-second-'+i);
const second=await pool(secondRefs.map((r,i)=>()=>buy(buyers[i%6],r)),5);
assert.ok(second.every(x=>x.code===201),JSON.stringify(second.map(x=>[x.code,x.json?.detail])));
const secondOrders=second.map(x=>x.json);
await assertStock(0);
await pool(secondOrders.slice(0,3).map((o,i)=>()=>cancel(o,buyers[i])),3);
await pool(secondOrders.slice(3).map(o=>()=>deliver(o)),4);
await assertStock(3);
checks.push('segunda oleada de 9 compras: 3 canceladas, 6 completadas');
const rows=(await db.query(
 'SELECT id,status,payment_method,payment_status,total,cash_collected,client_reference,inventory_restored_at FROM orders WHERE restaurant_id=$1',
 [rid])).rows;
assert.equal(rows.length,27);
assert.equal(new Set(rows.map(x=>x.client_reference)).size,27);
assert.equal(rows.filter(x=>x.status==='delivered').length,15);
assert.equal(rows.filter(x=>x.status==='cancelled').length,12);
for(const o of rows){
 assert.equal(o.payment_method,'cash');
 if(o.status==='delivered'){
  assert.equal(o.payment_status,'paid');
  assert.equal(o.cash_collected,o.total);
  assert.equal(o.inventory_restored_at,null);
 }else{
  assert.equal(o.payment_status,'pending');
  assert.equal(Number(o.cash_collected),0);
  assert.ok(o.inventory_restored_at);
 }
}
checks.push('27 referencias únicas, 15 entregados y 12 cancelados, sin cargos indebidos');
const ledger=(await db.query(
 'SELECT kind,account,COUNT(*)::int n FROM financial_ledger_entries WHERE restaurant_id=$1 GROUP BY kind,account',
 [rid])).rows;
for(const [kind,expected] of [['order_settlement',27],['order_cancellation',12]]){
 for(const account of ['gmv','restaurant_payable','platform_revenue','contribution_margin'])
  assert.equal(ledger.find(x=>x.kind===kind&&x.account===account)?.n,expected,kind+account);
}
const outbox=(await db.query(
 "SELECT event_key,COUNT(*)::int n FROM event_outbox WHERE aggregate_type='order' AND aggregate_id=ANY($1::text[]) GROUP BY event_key",
 [rows.map(x=>String(x.id))])).rows;
assert.ok(outbox.every(x=>x.n===1));
assert.equal(outbox.filter(x=>x.event_key.endsWith(':created')).length,27);
assert.equal(outbox.filter(x=>x.event_key.endsWith(':cancelled')).length,12);
assert.equal(outbox.filter(x=>x.event_key.endsWith(':delivered')).length,15);
checks.push('ledger sin alteraciones y eventos outbox exactamente una vez');
assert.equal((await call('/orders/'+orders[9].id,{token:buyers[4].token})).code,403);
const blocked=await call('/orders',{token:buyers[0].token,method:'POST',
 body:{...payload(tag+'-stripe-blocked'),payment_method:'stripe'}});
assert.equal(blocked.code,503);
assert.equal((await db.query('SELECT COUNT(*)::int n FROM orders WHERE restaurant_id=$1',[rid])).rows[0].n,27);
checks.push('aislamiento de cliente y cobros Stripe bloqueados');
const all=stats.map(x=>x.ms).sort((a,b)=>a-b);
const at=q=>Number(all[Math.ceil(all.length*q)-1].toFixed(1));
const statusCounts=Object.fromEntries([...new Set(stats.map(x=>x.code))].map(code=>[
 String(code),stats.filter(x=>x.code===code).length]));
const duration=Number((performance.now()-start).toFixed(1));
const report={mode:'synthetic-disposable-ci',production_ready:false,real_charges:0,
 customers:6,orders_created:27,delivered:15,cancelled:12,inventory_remaining:3,
 http_requests:stats.length,status_codes:statusCounts,runtime_ms:duration,
 latency_ms:{p50:at(.50),p95:at(.95),p99:at(.99)},
 notice:'Single CI runner; measured times are NOT live production throughput.',
 checks};
assert.equal(stats.filter(x=>x.code>=500&&x.code!==503).length,0);
assert.equal(stats.filter(x=>x.code===503).length,1,'Only Stripe blocked');
await writeFile('/tmp/tala-eats-rc4-stress-report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,[
 '## Tala Eats · estrés de compras ficticias',
 '**'+checks.length+' controles PASS:** 27 compras, 15 recogidas, 12 cancelaciones, 0 cargos reales.',
 'HTTP: '+stats.length+' llamadas · p50 '+at(.50)+'ms · p95 '+at(.95)+'ms · p99 '+at(.99)+'ms.',
 'Respuestas: '+JSON.stringify(statusCounts)+'.',
 '**No es una medición de capacidad de producción.**',
 ...checks.map(x=>'- ✅ '+x),'',
].join('\n'));
console.log('STRESS_PURCHASE_CHECKS_PASS='+checks.length);
console.log('STRESS_PURCHASE_REPORT='+JSON.stringify(report));
console.log('LIVE_FINANCIAL_WRITES=ZERO');
await db.end();
