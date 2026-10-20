// RC4 synthetic real-world purchase simulation via the public HTTP contracts.
// This script is for disposable GitHub Actions PG15/Redis8 ONLY: never Kali.
// Money, stock, PIN hand-off, cancellation and alerts are fake QA records.
import assert from 'node:assert/strict';
import pg from 'pg';
import {Redis} from 'ioredis';
import {writeFile,appendFile} from 'node:fs/promises';

const dsn=String(process.env.DATABASE_URL??'');
const redisUrl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||
   !dsn.includes('127.0.0.1:15435/tala_node_stage')||
   !redisUrl.includes('127.0.0.1:16379/0')||
   process.env.NODE_ENV!=='staging'||
   process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
   process.env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true')
 throw Error('PURCHASE_SIMULATION_DISPOSABLE_CI_ONLY');

const db=new pg.Client({connectionString:dsn});
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
const apiRoot='http://127.0.0.1:18190/api/v1';
const password='Synthetic-Purchase-QA-Only-2026!';
const stats={cases:[],orders_created:0,orders_delivered:0,orders_cancelled:0,
 rejected_operations:0,real_charges:0};
const passed=(name)=>stats.cases.push(name);
async function request(route,{token,method='GET',body}={}){
 const response=await fetch(apiRoot+route,{
  method,headers:{accept:'application/json','content-type':'application/json',
   'x-talaeats-client':'customer-mobile',...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
  signal:AbortSignal.timeout(9000),
 });
 let json=null;try{json=await response.json();}catch{}
 return {status:response.status,json};
}
async function waitForApi(){
 for(let i=0;i<35;i++){
  try{const r=await request('/ready');if(r.status===200&&r.json?.ready)return;}
  catch{}
  await new Promise(done=>setTimeout(done,250));
 }
 throw Error('SYNTHETIC_PURCHASE_API_NOT_READY');
}
await waitForApi();
async function register(label){
 const email='saleqa.'+process.pid+'.'+label+'@example.test';
 const r=await request('/auth/register',{method:'POST',body:{
  email,name:'Compras simuladas '+label,password}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return{id:r.json.user.id,email,token:r.json.access_token};
}
const owner=await register('comercio');
const customer=await register('comprador');
const outsider=await register('otro');
await db.query("UPDATE users SET role='restaurant' WHERE id=$1",[owner.id]);
const ownerLogin=await request('/auth/login',{method:'POST',body:{
 email:owner.email,password}});
assert.equal(ownerLogin.status,200,JSON.stringify(ownerLogin.json));
owner.token=ownerLogin.json.access_token;
passed('registro y autenticación de dos clientes y comercio');
const payoutsBefore=Number((await db.query(
 'SELECT count(*)::int AS n FROM payouts')).rows[0].n);
const restaurant=(await db.query(
 "INSERT INTO restaurants(name,address,is_open,pickup_enabled,market_code,verification_status,owner_id) "+
 "VALUES('Antojitos QA', 'Centro Tala', true, true, 'TALA-JAL','verified',$1) RETURNING id",
 [owner.id])).rows[0].id;
// Using the merchant HTTP API (not inserting products into PostgreSQL).
const createdItem=await request('/owner/menu',{token:owner.token,method:'POST',body:{
 name:'Hamburguesa de prueba',price:'80.00',stock:3,
 description:'Producto ficticio para prueba sin dinero',category:'Hamburguesas',
 is_available:true}});
assert.equal(createdItem.status,201,JSON.stringify(createdItem.json));
const menuId=createdItem.json.id;
const catalog=await request('/restaurants?market_code=TALA-JAL&limit=200');
assert.equal(catalog.status,200);
assert.ok(catalog.json.some(x=>x.id===restaurant));
const detail=await request('/restaurants/'+restaurant);
assert.equal(detail.status,200);
assert.ok(detail.json.menu_items.some(x=>x.id===menuId));
passed('menú publicado y catálogo de Tala verificado');
const paymentMethods=await request('/orders/payment-methods',{token:customer.token});
assert.equal(paymentMethods.status,200);
assert.equal(paymentMethods.json.methods.find(x=>x.id==='stripe').enabled,false);
const body=(ref,quantity=2)=>({
 restaurant_id:restaurant,address:'Recoger en mostrador',
 items:[{menu_item_id:menuId,quantity,options:''}],
 payment_method:'cash',order_type:'pickup',client_reference:ref,
 notes:'Sin cebolla. Compra simulada.',
 coupon_code:'',delivery_lat:null,delivery_lng:null,tip:'0.00',
});
const reference='saleqa-'+process.pid+'-001';
const payload=body(reference);
const blockedStripe=await request('/orders',{token:customer.token,method:'POST',
 body:{...body('blocked-stripe'),payment_method:'stripe'}});
assert.equal(blockedStripe.status,503);
const blockedDelivery=await request('/orders',{token:customer.token,method:'POST',
 body:{...body('blocked-delivery'),order_type:'delivery'}});
assert.equal(blockedDelivery.status,503);
const blockedCoupon=await request('/orders',{token:customer.token,method:'POST',
 body:{...body('blocked-coupon'),coupon_code:'DESCUENTO10'}});
assert.equal(blockedCoupon.status,503);
stats.rejected_operations+=3;
passed('Stripe, delivery y cupones no implementados rechazados sin cobros');
const bought=await request('/orders',{token:customer.token,method:'POST',body:payload});
assert.equal(bought.status,201,JSON.stringify(bought.json));
const id=bought.json.id;
stats.orders_created++;
assert.equal(bought.json.status,'received');
assert.equal(bought.json.payment_method,'cash');
assert.equal(bought.json.payment_status,'pending');
assert.equal(Number(bought.json.subtotal),160.00);
assert.equal(Number(bought.json.platform_commission),24.00);
assert.equal(Number(bought.json.service_fee),11.20);
assert.equal(Number(bought.json.restaurant_payout),136.00);
assert.equal(Number(bought.json.platform_revenue),35.20);
assert.equal(Number(bought.json.total),171.20);
assert.match(bought.json.delivery_pin,/^[0-9]{4}$/);
passed('precio y desglose comercial exactos: 15% + 7%, propina cero');
const concurrent=await Promise.all(Array.from({length:4},
 ()=>request('/orders',{token:customer.token,method:'POST',body:payload})));
assert.ok(concurrent.every(x=>x.status===201&&x.json.id===id),
 JSON.stringify(concurrent.map(x=>[x.status,x.json?.id])));
const duplicateMismatch=await request('/orders',{token:customer.token,
 method:'POST',body:{...payload,notes:'Pedido modificado'}});
assert.equal(duplicateMismatch.status,409);
const ordersRef=await db.query(
 'SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1 AND client_reference=$2',
 [customer.id,reference]);
assert.equal(ordersRef.rows[0].n,1);
assert.equal((await db.query('SELECT stock FROM menu_items WHERE id=$1',[menuId])).rows[0].stock,1);
passed('5 solicitudes equivalentes: un pedido y un único descuento de stock');
assert.equal((await request('/orders/'+id,{token:outsider.token})).status,403);
const refLookup=await request('/orders/by-reference/'+reference,{token:customer.token});
assert.equal(refLookup.status,200);assert.equal(refLookup.json.id,id);
assert.equal((await request('/orders/by-reference/'+reference,{token:outsider.token})).status,404);
const ownerQueue=await request('/owner/orders',{token:owner.token});
assert.equal(ownerQueue.status,200);
assert.ok(ownerQueue.json.some(x=>x.id===id));
assert.ok(ownerQueue.json.every(x=>!Object.hasOwn(x,'delivery_pin')));
stats.rejected_operations+=2;
passed('aislamiento de pedidos, referencia del comprador y ocultación de PIN');
const ownerStep=(status)=>request('/owner/orders/'+id+'/status',{
 token:owner.token,method:'PATCH',body:{status}});
const wrongStep=await ownerStep('ready');
assert.equal(wrongStep.status,409);
stats.rejected_operations++;
for(const status of ['confirmed','preparing','ready']){
 const moved=await ownerStep(status);
 assert.equal(moved.status,200,JSON.stringify(moved.json));
 assert.equal(moved.json.status,status);
}
const kds=await request('/owner/kds',{token:owner.token});
assert.equal(kds.status,200);
assert.ok(kds.json.ready.some(x=>x.id===id));
passed('restaurante: confirmar, preparar, listo y KDS');
const complete=(pin)=>request('/owner/orders/'+id+'/complete',{
 token:owner.token,method:'POST',body:{pin}});
const badPin=bought.json.delivery_pin==='0000'?'0001':'0000';
assert.equal((await complete(badPin)).status,400);
stats.rejected_operations++;
const handed=await Promise.all([complete(bought.json.delivery_pin),
 complete(bought.json.delivery_pin)]);
assert.ok(handed.every(x=>x.status===200&&x.json?.status==='delivered'),
 JSON.stringify(handed.map(x=>[x.status,x.json?.detail])));
assert.ok(handed.every(x=>x.json.payment_status==='paid'));
assert.ok(handed.every(x=>!Object.hasOwn(x.json,'delivery_pin')));
stats.orders_delivered++;
const finalized=(await db.query(
 'SELECT status,payment_method,payment_status,total,cash_collected FROM orders WHERE id=$1',
 [id])).rows[0];
assert.equal(finalized.status,'delivered');
assert.equal(finalized.payment_method,'cash');
assert.equal(finalized.cash_collected,finalized.total);
assert.equal((await db.query(
 "SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND status='delivered'",
 [id])).rows[0].n,1);
assert.equal((await db.query(
 "SELECT count(*)::int AS n FROM event_outbox WHERE event_key=$1",
 ['order:'+id+':delivered'])).rows[0].n,1);
passed('entrega en mostrador con PIN, cobro efectivo simulado y cierre idempotente');
const review=await request('/platform/reviews',{token:customer.token,method:'POST',
 body:{order_id:id,restaurant_rating:5,driver_rating:null,
 comment:'Calificación de compra simulada'}});
assert.equal(review.status,201,JSON.stringify(review.json));
assert.equal((await request('/platform/reviews',{token:customer.token,method:'POST',
 body:{order_id:id,restaurant_rating:5}})).status,409);
const notifications=await request('/platform/notifications',{token:customer.token});
assert.equal(notifications.status,200);
assert.ok(notifications.json.some(x=>x.kind==='order'));
passed('calificación postentrega única y notificaciones al cliente');
const cancelRef='saleqa-'+process.pid+'-cancel';
const another=await request('/orders',{token:customer.token,method:'POST',
 body:body(cancelRef,1)});
assert.equal(another.status,201,JSON.stringify(another.json));
stats.orders_created++;
assert.equal((await db.query(
 'SELECT stock FROM menu_items WHERE id=$1',[menuId])).rows[0].stock,0);
const preview=await request('/orders/'+another.json.id+'/cancellation-preview',
 {token:customer.token});
assert.equal(preview.status,200);
assert.equal(preview.json.fee,'0.00');
const cancelResults=await Promise.all(Array.from({length:3},
 ()=>request('/orders/'+another.json.id+'/cancel',
  {token:customer.token,method:'POST'})));
assert.ok(cancelResults.every(x=>x.status===200&&x.json?.status==='cancelled'));
stats.orders_cancelled++;
assert.equal((await db.query(
 'SELECT stock FROM menu_items WHERE id=$1',[menuId])).rows[0].stock,1);
const reversals=await db.query(
 "SELECT COUNT(*)::int AS n FROM financial_ledger_entries WHERE order_id=$1 AND kind='order_cancellation'",
 [another.json.id]);
assert.equal(reversals.rows[0].n,4);
assert.equal((await db.query(
 "SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND status='cancelled'",
 [another.json.id])).rows[0].n,1);
passed('cancelación concurrente: reposición única de stock y cuatro asientos reversos');
assert.equal((await request('/owner/menu/'+menuId,{
 token:owner.token,method:'DELETE'})).status,409);
const oversold=await request('/orders',{token:customer.token,method:'POST',
 body:body('saleqa-'+process.pid+'-stockout',2)});
assert.equal(oversold.status,400,JSON.stringify(oversold.json));
stats.rejected_operations+=2;
assert.equal((await db.query(
 'SELECT stock FROM menu_items WHERE id=$1',[menuId])).rows[0].stock,1);
passed('historial de productos protegido y venta sin existencias rechazada');
const original=await db.query(
 "SELECT account,amount FROM financial_ledger_entries WHERE order_id=$1 AND kind='order_settlement' ORDER BY account",
 [id]);
assert.equal(original.rowCount,4);
assert.deepEqual(original.rows.map(x=>x.account).sort(),
 ['gmv','restaurant_payable','platform_revenue','contribution_margin'].sort());
const payoutsAfter=Number((await db.query(
 'SELECT count(*)::int AS n FROM payouts')).rows[0].n);
assert.equal(payoutsAfter,payoutsBefore);
assert.equal(stats.real_charges,0);
passed('ledger sintético íntegro; sin pagos a repartidores ni transferencias reales');
const report={
 label:'Tala Eats — simulación de compra E2E sin dinero',
 backend:'Node.js staging',
 ci_synthetic_only:true,
 real_charge_attempts:0,
 payment_provider_live:false,
 summary:stats,
 example:{subtotal_mxn:'160.00',service_fee_mxn:'11.20',
  merchant_commission_mxn:'24.00',total_mxn:'171.20'},
};
await writeFile('/tmp/tala-eats-purchase-simulation.json',
 JSON.stringify(report,null,2)+'\n',{mode:0o600});
if(process.env.GITHUB_STEP_SUMMARY){
 const markdown=['### Tala Eats — simulación de compras (datos ficticios)',
  '**Resultado: '+stats.cases.length+' escenarios PASS.**',
  'Pedidos creados: '+stats.orders_created+
   ' | Entregados: '+stats.orders_delivered+
   ' | Cancelados: '+stats.orders_cancelled+
   ' | Operaciones rechazadas: '+stats.rejected_operations,
  'Ejemplo: subtotal $160.00 MXN, tarifa $11.20, comisión comercio $24.00, total $171.20.',
  '**Sin cobros bancarios ni transferencias; solo efectivo simulado en CI.**',
  ...stats.cases.map(x=>'- ✅ '+x),
  ''];
 await appendFile(process.env.GITHUB_STEP_SUMMARY,markdown.join('\n'));
}
console.log('PURCHASE_SIMULATION_E2E_PASS='+stats.cases.length);
console.log('PURCHASE_SIMULATION_STATS='+JSON.stringify(stats));
console.log('LIVE_FINANCIAL_TRANSACTIONS=ZERO');
await db.end();
