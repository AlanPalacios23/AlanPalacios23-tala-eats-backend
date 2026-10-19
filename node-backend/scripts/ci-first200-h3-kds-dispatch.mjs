import assert from 'node:assert/strict';
import pgLib from 'pg';
import {Redis} from 'ioredis';
const pgUrl=String(process.env.DATABASE_URL??''),ru=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!pgUrl.includes('127.0.0.1:15435/tala_node_stage')||
 !ru.includes('127.0.0.1:16379/0'))throw Error('H3_DISPOSABLE_DB_ONLY');
const redis=new Redis(ru);let cur='0';do{
 const [next,keys]=await redis.scan(cur,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);cur=next;
}while(cur!=='0');redis.disconnect();
const sql=new pgLib.Client({connectionString:pgUrl});await sql.connect();
const password='H3-Dispatch-Test-Only!';
async function api(path,{token,method='GET',body}={}){
 const r=await fetch('http://127.0.0.1:18190/api/v1'+path,{
 method,headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
 ...(token?{authorization:'Bearer '+token}:{})},
 ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await r.json()}catch{}return {status:r.status,json};}
async function make(name){
 const email='h3b.'+process.pid+'.'+name+'@example.test';
 const res=await api('/auth/register',{method:'POST',body:{name,email,password}});
 assert.equal(res.status,201,JSON.stringify(res.json));
 return {id:res.json.user.id,email,token:res.json.access_token};}
async function role(user,role){
 await sql.query('UPDATE users SET role=$1 WHERE id=$2',[role,user.id]);
 const login=await api('/auth/login',{method:'POST',
 body:{email:user.email,password}});assert.equal(login.status,200);
 user.token=login.json.access_token;}
const admin=await make('admin'),driver=await make('driver'),
 merchant=await make('merchant'),buyer=await make('buyer');
await role(admin,'admin');await role(merchant,'restaurant');await role(driver,'driver');
const go=(u,path,method='GET',body)=>api(path,{token:u?.token,method,body});
const store=(await sql.query(
 "INSERT INTO restaurants(name,address,owner_id,lat,lng)"+
 " VALUES('H3 Kitchen','Centro Tala',$1,20.6534,-103.704) RETURNING id",
 [merchant.id])).rows[0].id;
const order=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,status,order_type,payment_method,address)"+
 " VALUES($1,$2,'received','delivery','cash','Tala') RETURNING id",
 [buyer.id,store])).rows[0].id;
assert.equal((await go(buyer,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'confirm'})).status,403);
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'start'})).status,409);
const confirmed=await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'confirm',station:'Cocina'});
assert.equal(confirmed.status,200,JSON.stringify(confirmed.json));
assert.equal(confirmed.json.status,'confirmed');
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'start'})).json.status,'preparing');
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'undo'})).json.status,'confirmed');
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'start'})).json.status,'preparing');
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'ready'})).json.status,'ready');
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/bump','POST',
 {action:'ready'})).status,409);
const orderEvents=(await sql.query(
 "SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND metadata_json LIKE '%v11_kds%'",
 [order])).rows[0].n;
assert.equal(orderEvents,5);
const cash=(await sql.query('SELECT refunded_amount FROM orders WHERE id=$1',[order])).rows[0];
assert.equal(cash.refunded_amount,'0.00');
assert.equal((await go(buyer,'/v9/admin/dispatch/'+order+'/candidates')).status,403);
assert.equal((await go(null,'/v9/admin/dispatch/'+order+'/candidates')).status,401);
const unavailable=await go(admin,'/v9/admin/dispatch/'+order+'/auto-assign','POST');
assert.equal(unavailable.status,409);
await sql.query(
 "INSERT INTO driver_profiles(user_id,is_online,is_verified,current_lat,current_lng,rating)"+
 " VALUES($1,true,true,20.6535,-103.7042,4.90)",[driver.id]);
const choices=await go(admin,'/v9/admin/dispatch/'+order+'/candidates');
assert.equal(choices.status,200,JSON.stringify(choices.json));
assert.ok(choices.json.candidates.some(x=>x.driver_id===driver.id));
assert.equal(choices.json.candidates[0].active_deliveries,0);
const assigned=await go(admin,'/v9/admin/dispatch/'+order+'/auto-assign','POST');
assert.equal(assigned.status,200,JSON.stringify(assigned.json));
assert.equal(assigned.json.assigned,true);
assert.equal(assigned.json.driver.driver_id,driver.id);
assert.equal((await go(admin,'/v9/admin/dispatch/'+order+'/auto-assign','POST')).status,409);
const busyOrder=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,status,order_type,payment_method,address)"+
 " VALUES($1,$2,'ready','delivery','cash','Tala') RETURNING id",
 [buyer.id,store])).rows[0].id;
assert.equal((await go(admin,'/v9/admin/dispatch/'+busyOrder+'/auto-assign','POST')).status,409);
const active=(await sql.query(
 "SELECT count(*)::int n FROM orders WHERE driver_id=$1 AND status IN ('assigned','picked_up','on_the_way')",
 [driver.id])).rows[0].n;
assert.equal(active,1);
const events=(await sql.query(
 "SELECT count(*)::int n FROM event_outbox WHERE aggregate_id=$1 AND event_type='order.assigned'",
 [String(order)])).rows[0].n;
assert.equal(events,1);
const financial=(await sql.query(
 'SELECT count(*)::int n FROM financial_ledger_entries WHERE order_id IN ($1,$2)',
 [order,busyOrder])).rows[0].n;
assert.equal(financial,0);
console.log('NODE_H3_KDS_MERCHANT_RBAC_TRANSITIONS_ATOMIC=PASS');
console.log('NODE_H3_DISPATCH_DRIVER_SCORE_SINGLE_ACTIVE_DELIVERY=PASS');
console.log('NODE_H3_ONE_ASSIGNMENT_EVENT_OUTBOX_NO_LEDGER_MUTATIONS=PASS');
await sql.end();
