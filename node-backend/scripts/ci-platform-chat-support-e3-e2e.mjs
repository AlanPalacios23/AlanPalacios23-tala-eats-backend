// E2: Review/chat/support contracts vs Python platform.py.
// Run ONLY in disposable GitHub Actions PG15/Redis8.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const pgUrl=String(process.env.DATABASE_URL??'');
const redisUrl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||
 !pgUrl.includes('127.0.0.1:15435/tala_node_stage')||
 !redisUrl.includes('127.0.0.1:16379/0'))
 throw Error('E2_CI_ONLY_GUARD');
const redis=new Redis(redisUrl);
let cursor='0';
do{
 const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);
 cursor=next;
}while(cursor!=='0');
redis.disconnect();
const pgClient=new pg.Client({connectionString:pgUrl});
await pgClient.connect();
const root='http://127.0.0.1:18190/api/v1';
async function call(path,{token,method='GET',body}={}){
 const res=await fetch(root+path,{method,
  headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
   ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}
 return {status:res.status,json,cache:res.headers.get('cache-control')};
}
const password='Stage-E2-Customer-Test-2026!';
async function register(name){
 const email='e2.'+process.pid+'.'+name+'@example.test';
 const response=await call('/auth/register',{method:'POST',body:{
  email,name:'E2 '+name,password,
 }});
 assert.equal(response.status,201,JSON.stringify(response.json));
 return {id:response.json.user.id,token:response.json.access_token,email};
}
async function promote(a,role){
 await pgClient.query('UPDATE users SET role=$1 WHERE id=$2',[role,a.id]);
 const login=await call('/auth/login',{method:'POST',body:{email:a.email,password}});
 assert.equal(login.status,200,JSON.stringify(login.json));
 a.token=login.json.access_token;
}
const alice=await register('alice');
const bob=await register('bob');
const merchant=await register('merchant');
const outsiderMerchant=await register('othermerchant');
const driver=await register('driver');
const admin=await register('admin');
await promote(merchant,'restaurant');
await promote(outsiderMerchant,'restaurant');
await promote(driver,'driver');
await promote(admin,'admin');
const restaurantId=(await pgClient.query(
 "INSERT INTO restaurants(name,address,is_open,pickup_enabled,owner_id) VALUES('E2 Tala','Centro Tala',true,true,$1) RETURNING id",
 [merchant.id])).rows[0].id;
const itemId=(await pgClient.query(
 "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,'Tacos de prueba',50.00,30) RETURNING id",
 [restaurantId])).rows[0].id;
const platform=(who,path,method='GET',body)=>call('/platform'+path,{
 token:who?.token,method,body});
async function checkout(label,who=alice){
 const q=await call('/orders',{method:'POST',token:who.token,body:{
  restaurant_id:restaurantId,address:'Recoger en mostrador',
  payment_method:'cash',order_type:'pickup',client_reference:'e2-order-'+label,
  items:[{menu_item_id:itemId,quantity:1}],
 }});
 assert.equal(q.status,201,JSON.stringify(q.json));
 return q.json;
}
async function finish(o){
 for(const status of ['confirmed','preparing','ready']){
  const r=await call('/owner/orders/'+o.id+'/status',{token:merchant.token,
   method:'PATCH',body:{status}});
  assert.equal(r.status,200,JSON.stringify(r.json));
 }
 const done=await call('/owner/orders/'+o.id+'/complete',{token:merchant.token,
  method:'POST',body:{pin:o.delivery_pin}});
 assert.equal(done.status,200,JSON.stringify(done.json));
}
const delivered=await checkout('delivered');
const pending=await checkout('pending');
const bobs=await checkout('bob',bob);
await finish(delivered);
await finish(bobs);
// Driver associated to the already-complete fixture for chat permissions,
// without external dispatch, wallet writes or PSP.
await pgClient.query('UPDATE orders SET driver_id=$1 WHERE id=$2',[driver.id,delivered.id]);
assert.equal((await platform(alice,'/reviews','POST',{
 order_id:pending.id,restaurant_rating:4})).status,400);
assert.equal((await platform(bob,'/reviews','POST',{
 order_id:delivered.id,restaurant_rating:4})).status,400);
assert.equal((await platform(merchant,'/reviews','POST',{
 order_id:delivered.id,restaurant_rating:4})).status,403);
assert.equal((await platform(alice,'/reviews','POST',{
 order_id:delivered.id,restaurant_rating:0})).status,422);
const reviewIntent={
 order_id:delivered.id,restaurant_rating:5,driver_rating:4,
 comment:'Comida excelente y puntual',
};
const reviews=await Promise.all([
 platform(alice,'/reviews','POST',reviewIntent),
 platform(alice,'/reviews','POST',reviewIntent),
]);
assert.deepEqual(reviews.map(q=>q.status).sort(),[201,409],JSON.stringify(reviews));
const posted=reviews.find(x=>x.status===201);
assert.equal(posted.json.restaurant_id,restaurantId);
assert.equal(posted.json.restaurant_rating,5);
assert.equal(posted.json.driver_rating,4);
assert.equal(posted.json.comment,'Comida excelente y puntual');
assert.equal(posted.cache,'private, no-store');
const rows=await pgClient.query('SELECT count(*)::int n FROM reviews WHERE order_id=$1',
 [delivered.id]);
assert.equal(rows.rows[0].n,1);
const ownReview=await platform(bob,'/reviews','POST',{
 order_id:bobs.id,restaurant_rating:3});
assert.equal(ownReview.status,201);
assert.equal(ownReview.json.driver_rating,null);

const chatPath='/orders/'+delivered.id+'/chat';
const noChat='/orders/9999999/chat';
assert.equal((await platform(alice,noChat)).status,404);
assert.equal((await platform(bob,chatPath)).status,403);
assert.equal((await platform(outsiderMerchant,chatPath)).status,403);
assert.equal((await platform(undefined,chatPath)).status,401);
assert.equal((await platform(bob,chatPath,'POST',{message:'intruso'})).status,403);
assert.equal((await platform(alice,chatPath,'POST',{
 message:'hola',message_type:'script'})).status,422);
assert.equal((await platform(alice,chatPath,'POST',{
 message:'hola',message_type:'location',lat:200,lng:-103})).status,422);
const aliceChat=await platform(alice,chatPath,'POST',{
 message:'¿Dónde está mi pedido?',message_type:'text'});
assert.equal(aliceChat.status,201,JSON.stringify(aliceChat.json));
assert.equal(aliceChat.json.order_id,delivered.id);
assert.equal(aliceChat.json.sender_id,alice.id);
assert.equal(aliceChat.json.message,'¿Dónde está mi pedido?');
assert.equal(aliceChat.cache,'private, no-store');
const merchantChat=await platform(merchant,chatPath,'POST',{
 message:'Ya está listo',message_type:'quick'});
assert.equal(merchantChat.status,201);
const driverChat=await platform(driver,chatPath,'POST',{
 message:'Ubicación',message_type:'location',lat:20.653,lng:-103.703});
assert.equal(driverChat.status,201);
assert.equal(driverChat.json.message_type,'location');
const adminChat=await platform(admin,chatPath,'POST',{
 message:'Soporte revisando'});
assert.equal(adminChat.status,201);
const list=await platform(alice,chatPath);
assert.equal(list.status,200);
assert.deepEqual(list.json.map(x=>x.id),[
 aliceChat.json.id,merchantChat.json.id,driverChat.json.id,adminChat.json.id
]);
assert.equal(list.cache,'private, no-store');
assert.equal((await platform(merchant,chatPath)).json.length,4);
assert.equal((await platform(driver,chatPath)).json.length,4);
assert.equal((await platform(admin,chatPath)).json.length,4);
assert.equal((await platform(bob,chatPath)).status,403);
for(const x of list.json){
 const out=await pgClient.query(
  "SELECT status,event_type,payload_json FROM event_outbox WHERE event_key=$1",
  ['order:'+delivered.id+':chat:'+x.id]);
 assert.equal(out.rowCount,1);
 assert.equal(out.rows[0].status,'pending');
 assert.equal(out.rows[0].event_type,'chat.message');
 assert.equal(JSON.parse(out.rows[0].payload_json).sender_id,x.sender_id);
}

assert.deepEqual((await platform(alice,'/support')).json,[]);
assert.equal((await platform(alice,'/support','POST',{
 order_id:bobs.id,category:'entrega',message:'Pedido de otra persona'})).status,404);
assert.equal((await platform(alice,'/support','POST',{
 category:'otro',message:'no'})).status,422);
const ticket=await platform(alice,'/support','POST',{
 order_id:delivered.id,category:'entrega',message:'Necesito ayuda con mi entrega'});
assert.equal(ticket.status,201,JSON.stringify(ticket.json));
assert.equal(ticket.json.status,'open');
assert.equal(ticket.json.order_id,delivered.id);
assert.equal(ticket.cache,'private, no-store');
assert.equal((await platform(bob,'/support')).json.length,0);
const anonymous=await platform(bob,'/support','POST',{
 category:'general',message:'Consulta de ayuda sin pedido'});
assert.equal(anonymous.status,201);
assert.equal(anonymous.json.order_id,null);
const adminTicket=await platform(admin,'/support','POST',{
 order_id:bobs.id,category:'auditoria',message:'Revisión autorizada del pedido'});
assert.equal(adminTicket.status,201);
const adminList=await platform(admin,'/support');
assert.equal(adminList.status,200);
assert.equal(adminList.json.length,3);
const aliceList=await platform(alice,'/support');
assert.equal(aliceList.json.length,1);
assert.equal(aliceList.json[0].id,ticket.json.id);
const bobList=await platform(bob,'/support');
assert.equal(bobList.json.length,1);
assert.equal(bobList.json[0].id,anonymous.json.id);
assert.equal((await platform(outsiderMerchant,'/support')).json.length,0);
assert.equal((await platform(undefined,'/support')).status,401);

console.log('NODE_E2_REVIEW_DELIVERED_ONLY_RBAC_AND_CONCURRENT_UNIQUE=PASS');
console.log('NODE_E2_CHAT_CUSTOMER_DRIVER_MERCHANT_ADMIN_ORDER_ACL=PASS');
console.log('NODE_E2_CHAT_ATOMIC_OUTBOX_PENDING_NO_REALTIME_CLAIM=PASS');
console.log('NODE_E2_SUPPORT_TENANT_ISOLATION_AND_ADMIN_VIEW=PASS');
await pgClient.end();
