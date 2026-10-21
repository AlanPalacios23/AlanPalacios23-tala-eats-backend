// RC5: concurrent stock contention + order/cancellation races.
// Synthetic-only QA: no Kali, LIVE cards, Stripe, or shared databases.
import assert from 'node:assert/strict';
import pg from 'pg';
import {Redis} from 'ioredis';
import {performance} from 'node:perf_hooks';
import {writeFile,appendFile} from 'node:fs/promises';
const pgUrl=String(process.env.DATABASE_URL??'');
const redisUrl=String(process.env.REDIS_URL??'');
const safe=process.env.GITHUB_ACTIONS==='true'&&process.env.NODE_ENV==='staging'&&
 process.env.HOST==='127.0.0.1'&&process.env.PORT==='18190'&&
 process.env.STRIPE_FINANCIAL_WRITES_ENABLED==='false'&&
 process.env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED==='true'&&
 pgUrl.includes('127.0.0.1:15435/tala_node_stage')&&
 redisUrl.includes('127.0.0.1:16379/0');
if(!safe)throw Error('ORDER_RACE_DISPOSABLE_GITHUB_CI_ONLY');
const db=new pg.Client({connectionString:pgUrl});await db.connect();
const start=performance.now(),samples=[],assertions=[],errors=[];
const root='http://127.0.0.1:18190/api/v1';
let step='boot';
async function api(path,{token,method='GET',body}={}){
 const begin=performance.now();
 try{
  const result=await fetch(root+path,{method,headers:{
   'content-type':'application/json','x-talaeats-client':'customer-mobile',
   ...(token?{authorization:'Bearer '+token}:{})},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),
   signal:AbortSignal.timeout(15000),
  });
  let json=null;try{json=await result.json();}catch{}
  samples.push({step,status:result.status,ms:performance.now()-begin});
  return{status:result.status,json};
 }catch(e){
  errors.push({step,message:e instanceof Error?e.message:'Network error'});
  samples.push({step,status:0,ms:performance.now()-begin});
  throw e;
 }
}
async function pool(arr,workers=12){
 const results=new Array(arr.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(workers,arr.length)},async()=>{
  while(cursor<arr.length){const i=cursor++;results[i]=await arr[i]();}
 }));
 return results;
}
const report=()=>{
 const measurements=samples.filter(x=>x.status!==0).map(x=>x.ms).sort((a,b)=>a-b);
 const q=p=>measurements.length?Number(measurements[Math.ceil(measurements.length*p)-1].toFixed(1)):null;
 const codes={};
 for(const s of samples)codes[String(s.status)]=(codes[String(s.status)]??0)+1;
 return{label:'Tala Eats RC5 — race and oversell testing',
  environment:'GitHub Actions PG15 Redis8 isolated staging',
  production_ready:false,payments_live:false,
  duration_ms:Number((performance.now()-start).toFixed(1)),
  requests:samples.length,status_codes:codes,
  latency_ms:{p50:q(.5),p95:q(.95),p99:q(.99)},
  assertions,errors,
  limitations:'No payment capture or real driver; load is synthetic on GitHub, not Kali production.'};
};
async function flushReport(failure){
 const data=report();
 if(failure)data.failure=String(failure),data.failure_step=step;
 await writeFile('/tmp/tala-rc5-order-races.json',JSON.stringify(data,null,2)+'\n',{mode:0o600});
 console.log('RC5_ORDER_RACES_REPORT='+JSON.stringify(data));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,[
  '## RC5 — compras compitiendo por inventario + cancelación vs preparación',
  'Controles: '+assertions.length+'; errores: '+errors.length+'; HTTP: '+samples.length,
  'Latencia p95: '+data.latency_ms.p95+' ms / p99: '+data.latency_ms.p99+' ms',
  ...assertions.map(x=>'- ✅ '+x),''].join('\n'));
}
try{
 step='wait for API';
 for(let n=0;n<60;n++){
  try{if((await api('/ready')).json?.ready)break;}catch{}
  if(n===59)throw Error('API_NOT_READY');
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 step='auth setup';
 const redis=new Redis(redisUrl);
 try{
  let c='0';
  do{
   const [n,keys]=await redis.scan(c,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
   if(keys.length)await redis.del(...keys);c=n;
  }while(c!=='0');
 }finally{redis.disconnect();}
 const prefix='race'+process.pid,pass='Synthetic-Race-Only-2026!';
 async function user(name){
  const email=prefix+name+'@example.test';
  const response=await api('/auth/register',{method:'POST',body:{
   email,name:'QA '+name,password:pass}});
  assert.equal(response.status,201,JSON.stringify(response.json));
  return{id:response.json.user.id,email,token:response.json.access_token};
 }
 const owner=await user('owner'),buyers=[];
 for(let i=0;i<5;i++)buyers.push(await user('buyer'+i));
 await db.query("UPDATE users SET role='restaurant' WHERE id=$1",[owner.id]);
 const login=await api('/auth/login',{method:'POST',body:{
  email:owner.email,password:pass}});
 assert.equal(login.status,200);
 owner.token=login.json.access_token;
 const shopId=(await db.query(
  "INSERT INTO restaurants(name,owner_id,market_code,address,is_open,pickup_enabled,verification_status)"+
  " VALUES('RC5 QA Shop',$1,'TALA-JAL','Tala QA',true,true,'verified') RETURNING id",
  [owner.id])).rows[0].id;
 const added=await api('/owner/menu',{token:owner.token,method:'POST',body:{
  name:'Taco de laboratorio',price:'35.00',stock:30,
  description:'Artículo simulado',is_available:true}});
 assert.equal(added.status,201,JSON.stringify(added.json));
 const menu=added.json.id;
 const ingredient=(await db.query(
  "INSERT INTO ingredient_stocks(restaurant_id,name,quantity,unit) VALUES($1,'Harina QA',30.000,'kg') RETURNING id",
  [shopId])).rows[0].id;
 await db.query(
  'INSERT INTO menu_recipes(menu_item_id,ingredient_id,quantity_required) VALUES($1,$2,1.000)',
  [menu,ingredient]);
 const stock=async()=>{
  const q=await db.query('SELECT stock FROM menu_items WHERE id=$1',[menu]);
  const i=await db.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',[ingredient]);
  return{menu:Number(q.rows[0].stock),ingredient:Number(i.rows[0].quantity)};
 };
 const requireStock=async n=>assert.deepEqual(await stock(),{menu:n,ingredient:n});
 assertions.push('Inventario inicial: 30 unidades de menú y 30 de ingredientes');
 const payload=ref=>({restaurant_id:shopId,address:'Recogida QA',
  items:[{menu_item_id:menu,quantity:1,options:''}],
  payment_method:'cash',order_type:'pickup',client_reference:ref,
  coupon_code:'',delivery_lat:null,delivery_lng:null,tip:'0.00'});
 const buy=(i)=>api('/orders',{method:'POST',token:buyers[i%5].token,
  body:payload(prefix+'-sale-'+i)});
 step='50 simultaneous purchases against 30 remaining units';
 const attempts=await pool(Array.from({length:50},(_,i)=>()=>buy(i)),20);
 const wins=[],loses=[];
 for(let i=0;i<attempts.length;i++){
  const r=attempts[i];
  if(r.status===201)wins.push({...r.json,buyer:buyers[i%5]});
  else loses.push({i,status:r.status,body:r.json});
 }
 assert.equal(wins.length,30,JSON.stringify(loses.slice(0,10)));
 assert.equal(loses.length,20);
 assert.ok(loses.every(x=>x.status===400),JSON.stringify(loses));
 await requireStock(0);
 assertions.push('50 compras a concurrencia 20: 30 aceptadas, 20 rechazadas sin sobreventa');
 step='cancellation/merchant-confirmation races';
 const cancelled= wins.slice(0,15);
 const deliverable=wins.slice(15);
 const races=await pool(cancelled.slice(0,10).map(o=>async()=>{
  return Promise.all([
   api('/orders/'+o.id+'/cancel',{token:o.buyer.token,method:'POST'}),
   api('/owner/orders/'+o.id+'/status',{
    token:owner.token,method:'PATCH',body:{status:'confirmed'}}),
  ]);
 }),5);
 for(const [cancel,transition] of races){
  assert.equal(cancel.status,200,JSON.stringify(cancel.json));
  assert.ok(transition.status===200||transition.status===409,
   JSON.stringify(transition.json));
 }
 assertions.push('10 carreras cancelación/confirmación: cancela una sola vez');
 const repeat=await pool(cancelled.slice(10).map(o=>()=>Promise.all(
  Array.from({length:3},()=>api('/orders/'+o.id+'/cancel',{
   token:o.buyer.token,method:'POST'})))),5);
 for(const group of repeat)assert.ok(group.every(x=>x.status===200&&x.json.status==='cancelled'));
 await requireStock(15);
 assertions.push('15 cancelaciones totales y tres reintentos concurrentes sin doble restauración');
 step='complete remaining orders';
 await pool(deliverable.map(o=>async()=>{
  for(const status of ['confirmed','preparing','ready']){
   const result=await api('/owner/orders/'+o.id+'/status',{
    token:owner.token,method:'PATCH',body:{status}});
   assert.equal(result.status,200,JSON.stringify(result.json));
  }
  const done=await api('/owner/orders/'+o.id+'/complete',{
   token:owner.token,method:'POST',body:{pin:o.delivery_pin}});
  assert.equal(done.status,200,JSON.stringify(done.json));
 }),8);
 await requireStock(15);
 assertions.push('15 recogidas con PIN completadas y stock final 15');
 step='inspect transactional invariants';
 const orders=(await db.query(
  'SELECT id,status,inventory_restored_at,client_reference FROM orders WHERE restaurant_id=$1',
  [shopId])).rows;
 assert.equal(orders.length,30);
 assert.equal(new Set(orders.map(o=>o.client_reference)).size,30);
 assert.equal(orders.filter(o=>o.status==='cancelled').length,15);
 assert.equal(orders.filter(o=>o.status==='delivered').length,15);
 for(const o of orders){
  if(o.status==='cancelled')assert.ok(o.inventory_restored_at);
  else assert.equal(o.inventory_restored_at,null);
 }
 assertions.push('30 órdenes únicas y exactamente 15 canceladas/15 entregadas');
 const ledger=(await db.query(
  'SELECT kind,account,count(*)::int n FROM financial_ledger_entries WHERE restaurant_id=$1 GROUP BY kind,account',
  [shopId])).rows;
 for(const [kind,n] of [['order_settlement',30],['order_cancellation',15]]){
  for(const account of ['gmv','restaurant_payable','platform_revenue','contribution_margin'])
   assert.equal(ledger.find(o=>o.kind===kind&&o.account===account)?.n,n,
    kind+'/'+account);
 }
 const outbox=(await db.query(
  'SELECT event_key,count(*)::int n FROM event_outbox WHERE aggregate_type=$1 AND aggregate_id=ANY($2::text[]) GROUP BY event_key',
  ['order',orders.map(o=>String(o.id))])).rows;
 assert.ok(outbox.every(x=>x.n===1));
 assert.equal(outbox.filter(x=>x.event_key.endsWith(':cancelled')).length,15);
 assert.equal(outbox.filter(x=>x.event_key.endsWith(':delivered')).length,15);
 assertions.push('180 asientos contables y eventos finales sin duplicación');
 assert.equal(samples.filter(s=>s.status===0||s.status>=500&&s.status!==503).length,0);
 assertions.push('Sin errores HTTP 500 ni errores de red durante la carga');
 console.log('RC5_ORDER_RACE_INVARIANTS_PASS='+assertions.length);
}catch(error){
 process.exitCode=1;
 errors.push({step,error:error instanceof Error?error.message:'unknown'});
 console.error('RC5_ORDER_RACES_FAILURE',step,error);
}finally{
 try{await flushReport(process.exitCode?errors.at(-1)?.error:undefined);}
 catch(err){process.exitCode=1;console.error('RC5_REPORT_ERROR',err);}
 await db.end();
}
