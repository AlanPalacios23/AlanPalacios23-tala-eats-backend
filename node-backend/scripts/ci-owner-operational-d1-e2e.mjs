// D1 functional owner app path against disposable PostgreSQL15 + Redis8:
// customer checkout -> KDS -> owner status/complete -> revenue analytics,
// staff roster/roles, tenant isolation, query contract and concurrent upsert.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const base='http://127.0.0.1:18190/api/v1';
const host=process.env.DATABASE_URL??'';
if(process.env.GITHUB_ACTIONS!=='true' ||
   !host.includes('127.0.0.1:15435/tala_node_stage')||
   !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0'))
  throw Error('OWNER_D1_CI_ONLY_GUARD');
const redis=new Redis(process.env.REDIS_URL);
let cursor='0';
do{
  const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
  if(keys.length)await redis.del(...keys);
  cursor=next;
}while(cursor!=='0');
redis.disconnect();
const pgClient=new pg.Client({connectionString:host});
await pgClient.connect();
async function call(path,{token,method='GET',body}={}){
  const response=await fetch(base+path,{method,headers:{
      'content-type':'application/json','x-talaeats-client':'customer-mobile',
      ...(token?{authorization:'Bearer '+token}:{})
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
  let json=null;try{json=await response.json()}catch{}
  return {status:response.status,json,cache:response.headers.get('cache-control')};
}
const secret='D1-Owner-CI-Synthetic-Pass!';
async function register(n){
  const email='d1.'+process.pid+'.'+n+'@example.test';
  const response=await call('/auth/register',{method:'POST',body:{
    name:'D1 '+n,email,password:secret
  }});
  assert.equal(response.status,201,JSON.stringify(response.json));
  return {id:response.json.user.id,token:response.json.access_token,email};
}
async function promote(user,role){
  const updated=await pgClient.query('UPDATE users SET role=$1 WHERE id=$2',[role,user.id]);
  assert.equal(updated.rowCount,1);
  const login=await call('/auth/login',{method:'POST',body:{email:user.email,password:secret}});
  assert.equal(login.status,200);
  user.token=login.json.access_token;
}
const owner=await register('owner');
const owner2=await register('owner2');
const customer=await register('customer');
const employee=await register('employee');
const third=await register('employee2');
await promote(owner,'restaurant');
await promote(owner2,'restaurant');
const restaurant=(await pgClient.query(
  "INSERT INTO restaurants(name,address,owner_id,pickup_enabled,is_open) VALUES('D1 Restaurant','Tala Centro',$1,true,true) RETURNING id",[owner.id]
)).rows[0].id;
const foreign=(await pgClient.query(
  "INSERT INTO restaurants(name,address,owner_id,pickup_enabled,is_open) VALUES('D1 Competitor','Tala Otro',$1,true,true) RETURNING id",[owner2.id]
)).rows[0].id;
// A merchant can update its address, but not self-award sponsored placement.
const sponsored=await call('/owner/restaurant',{
  token:owner.token,method:'PATCH',body:{sponsored:true}});
assert.equal(sponsored.status,403,JSON.stringify(sponsored.json));
const sponsoredRow=await pgClient.query('SELECT sponsored FROM restaurants WHERE id=$1',[restaurant]);
assert.equal(sponsoredRow.rows[0].sponsored,false);
const changedAddress=await call('/owner/restaurant',{
  token:owner.token,method:'PATCH',body:{address:'Centro Tala, Jalisco'}});
assert.equal(changedAddress.status,200,JSON.stringify(changedAddress.json));
assert.equal(changedAddress.json.address,'Centro Tala, Jalisco');
const menu=await pgClient.query(
  "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES ($1,'Taco D1',40.00,15),($1,'Agotando',80.00,5),($1,'Sin stock',60.00,0),($1,'Disponible',30.00,10) RETURNING id,price",
  [restaurant]);
const taco=menu.rows[0].id;
const low=menu.rows[1].id;
assert.equal((await call('/owner/analytics',{token:customer.token})).status,403);
assert.equal((await call('/owner/analytics',{token:owner2.token})).status,200);
assert.equal((await call('/owner/analytics')).status,401);
const empty=await call('/owner/analytics',{token:owner.token});
assert.equal(empty.status,200);
assert.deepEqual(empty.json,{orders:0,delivered:0,gross_sales:0,avg_ticket:0,inventory_low:2});
assert.equal(empty.cache,'private, no-store');
const list0=await call('/owner/employees',{token:owner.token});
assert.equal(list0.status,200);
assert.deepEqual(list0.json,[]);
const query=(email,role)=>'/owner/employees?email='+encodeURIComponent(email)+
  (role===undefined?'':'&role='+encodeURIComponent(role));
assert.equal((await call('/owner/employees',{token:employee.token})).status,403);
assert.equal((await call(query(employee.email,'cashier'),
    {token:customer.token,method:'POST'})).status,403);
assert.equal((await call(query('missing@example.test'),
    {token:owner.token,method:'POST'})).status,404);
assert.equal((await call(query(employee.email,'SUPERADMIN'),
    {token:owner.token,method:'POST'})).status,400);
assert.equal((await call('/owner/employees',{token:owner.token,method:'POST',
    body:{email:employee.email,role:'manager'}})).status,422);
// Python owner.py uses query params for email/role, not JSON.
const inserted=await call(query(employee.email.toUpperCase()+' ','cashier'),
    {token:owner.token,method:'POST'});
assert.equal(inserted.status,200,JSON.stringify(inserted.json));
assert.equal(inserted.json.email,employee.email);
assert.equal(inserted.json.name,'D1 employee');
assert.equal(inserted.json.role,'cashier');
const changed=await call(query(employee.email,'manager'),
    {token:owner.token,method:'POST'});
assert.equal(changed.status,200);
assert.equal(changed.json.id,inserted.json.id);
assert.equal(changed.json.role,'manager');
const samePair=await Promise.all(Array.from({length:3},()=>call(query(third.email,'kitchen'),
    {token:owner.token,method:'POST'})));
assert.ok(samePair.every(x=>x.status===200));
assert.ok(samePair.every(x=>x.json.id===samePair[0].json.id));
assert.equal((await call(query(employee.email,'kitchen'),
    {token:owner2.token,method:'POST'})).status,200);
const roster=await call('/owner/employees',{token:owner.token});
assert.equal(roster.status,200);
assert.equal(roster.json.length,2);
assert.ok(roster.json.some(x=>x.id===inserted.json.id && x.role==='manager'));
assert.equal(roster.cache,'private, no-store');
const foreignRoster=await call('/owner/employees',{token:owner2.token});
assert.equal(foreignRoster.status,200);
assert.equal(foreignRoster.json.length,1);
assert.equal(foreignRoster.json[0].role,'kitchen');
assert.notEqual(foreignRoster.json[0].id,inserted.json.id);
const memberships=await pgClient.query(
  'SELECT COUNT(*)::int n FROM restaurant_employees WHERE restaurant_id=$1 AND user_id=$2',
  [restaurant,third.id]);
assert.equal(memberships.rows[0].n,1);
// Staff membership follows Python model and is not an implicit auth role.
assert.equal((await call('/owner/kds',{token:employee.token})).status,403);
const makeOrder=async(ref,id)=>{
  const order=await call('/orders',{token:customer.token,method:'POST',body:{
    restaurant_id:restaurant,address:'Recoger en Tala',payment_method:'cash',
    order_type:'pickup',client_reference:ref,
    items:[{menu_item_id:id,quantity:1}]
  }});
  assert.equal(order.status,201,JSON.stringify(order.json));
  return order.json;
};
const first=await makeOrder('owner-d1-sale-1',taco);
const second=await makeOrder('owner-d1-sale-2',low);
const awaiting=await makeOrder('owner-d1-pending',taco);
const initial=await call('/owner/analytics',{token:owner.token});
assert.equal(initial.status,200);
assert.equal(initial.json.orders,3);
assert.equal(initial.json.delivered,0);
assert.equal(initial.json.gross_sales,0);
assert.equal(initial.json.inventory_low,2);
assert.deepEqual((await call('/owner/analytics',{token:owner2.token})).json,
  {orders:0,delivered:0,gross_sales:0,avg_ticket:0,inventory_low:0});
const advance=async order=>{
  for(const status of ['confirmed','preparing','ready']){
    const res=await call('/owner/orders/'+order.id+'/status',{token:owner.token,
      method:'PATCH',body:{status}});
    assert.equal(res.status,200,JSON.stringify(res.json));
  }
  const kds=await call('/owner/kds',{token:owner.token});
  assert.equal(kds.status,200);
  assert.ok(kds.json.ready.some(x=>x.id===order.id));
  const completed=await call('/owner/orders/'+order.id+'/complete',{token:owner.token,
    method:'POST',body:{pin:order.delivery_pin}});
  assert.equal(completed.status,200,JSON.stringify(completed.json));
  assert.equal(completed.json.status,'delivered');
};
await advance(first);
await advance(second);
const counted=await call('/owner/analytics',{token:owner.token});
assert.equal(counted.status,200,JSON.stringify(counted.json));
assert.equal(counted.json.orders,3);
assert.equal(counted.json.delivered,2);
// First subtotal 40 + 7% = 42.8 ; second subtotal 80 + 7% = 85.6
assert.equal(counted.json.gross_sales,128.4);
assert.equal(counted.json.avg_ticket,64.2);
assert.equal(counted.json.inventory_low,2);
const otherSale=await pgClient.query(
  "INSERT INTO orders(user_id,restaurant_id,address,total,status) VALUES ($1,$2,'Tala',500.00,'delivered') RETURNING id",
  [customer.id,foreign]);
assert.equal(otherSale.rowCount,1);
const still=await call('/owner/analytics',{token:owner.token});
assert.equal(still.json.gross_sales,128.4);
const other=await call('/owner/analytics',{token:owner2.token});
assert.equal(other.json.orders,1);
assert.equal(other.json.delivered,1);
assert.equal(other.json.gross_sales,500);
assert.equal(other.json.avg_ticket,500);
const pending=(await call('/owner/orders',{token:owner.token})).json;
assert.ok(pending.some(x=>x.id===awaiting.id&&x.status==='received'));
assert.equal((await call('/owner/orders',{token:employee.token})).status,403);
console.log('NODE_OWNER_PYTHON_ANALYTICS_GROSS_DELIVERED_ONLY=PASS');
console.log('NODE_OWNER_EMPLOYEE_QUERY_UPSERT_CONCURRENT_AND_ISOLATION=PASS');
console.log('NODE_OWNER_CASH_PICKUP_KDS_ANALYTICS_END_TO_END=PASS');
console.log('NODE_OWNER_EMPLOYMENT_DOES_NOT_GRANT_AUTH_ROLE=PASS');
await pgClient.end();
