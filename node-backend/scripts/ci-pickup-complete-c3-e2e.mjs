// C3: synthetic pickup PIN proof and loyalty idempotency.
// Run only in disposable GitHub Actions PG15/Redis8; never Kali.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const base='http://127.0.0.1:18190/api/v1';
const headers={'content-type':'application/json','x-talaeats-client':'customer-mobile'};
const password='C3-Synthetic-Only-2026!';
if(process.env.GITHUB_ACTIONS!=='true' ||
   !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage') ||
   !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0'))
  throw Error('C3_CI_ONLY_GUARD');
const redis=new Redis(process.env.REDIS_URL);
let cursor='0';
do{
  const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
  if(keys.length)await redis.del(...keys);
  cursor=next;
}while(cursor!=='0');
redis.disconnect();
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
async function call(path,{token,method='GET',body}={}){
  const res=await fetch(base+path,{method,
    headers:{...headers,...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  let json=null;try{json=await res.json()}catch{}
  return {status:res.status,json};
}
async function register(label) {
  const email='c3.'+process.pid+'.'+label+'@example.test';
  const r=await call('/auth/register',{method:'POST',
    body:{name:'C3 '+label,email,password}});
  assert.equal(r.status,201,JSON.stringify(r.json));
  return {id:r.json.user.id,email,token:r.json.access_token};
}
async function promote(u,role) {
  const changed=await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,u.id]);
  assert.equal(changed.rowCount,1);
  const login=await call('/auth/login',{method:'POST',
    body:{email:u.email,password}});
  assert.equal(login.status,200);
  u.token=login.json.access_token;
}
const customer=await register('customer');
const owner=await register('owner');
const stranger=await register('stranger');
const otherMerchant=await register('othermerchant');
await promote(owner,'restaurant');
await promote(otherMerchant,'restaurant');
const restaurant=await db.query(
  "INSERT INTO restaurants(name,is_open,pickup_enabled,address,owner_id) VALUES('C3 Taqueria',true,true,'Tala Centro',$1) RETURNING id",[owner.id]);
const rid=restaurant.rows[0].id;
const item=await db.query(
  "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,'Taco de prueba',40.00,20) RETURNING id",[rid]);
const mid=item.rows[0].id;
let refnum=0;
async function order(){
  refnum++;
  const p={restaurant_id:rid,address:'Recoger mostrador',
    items:[{menu_item_id:mid,quantity:1}],
    payment_method:'cash',order_type:'pickup',client_reference:'C3-'+refnum};
  const r=await call('/orders',{token:customer.token,method:'POST',body:p});
  assert.equal(r.status,201,JSON.stringify(r.json));
  assert.equal(r.json.payment_status,'pending');
  return r.json;
}
const ownerStatus=(id,status)=>call('/owner/orders/'+id+'/status',
  {token:owner.token,method:'PATCH',body:{status}});
const complete=(id,pin,token=owner.token,photo='')=>call('/owner/orders/'+id+'/complete',
  {token,method:'POST',body:{pin,photo_url:photo}});
async function ready(orderId){
  for(const status of ['confirmed','preparing','ready']){
    const res=await ownerStatus(orderId,status);
    assert.equal(res.status,200,JSON.stringify(res.json));
  }
}
const first=await order();
assert.match(first.delivery_pin,/^\d{4}$/);
assert.equal((await complete(first.id,first.delivery_pin)).status,409); // not ready
await ready(first.id);
assert.equal((await complete(first.id,first.delivery_pin,customer.token)).status,403);
assert.equal((await complete(first.id,first.delivery_pin,otherMerchant.token)).status,403);
assert.equal((await complete(first.id,'00000')).status,422);
const wrong=first.delivery_pin==='0000'?'0001':'0000';
assert.equal((await complete(first.id,wrong)).status,400);
const results=await Promise.all([
  complete(first.id,first.delivery_pin),
  complete(first.id,first.delivery_pin),
  complete(first.id,first.delivery_pin),
]);
assert.ok(results.every(x=>x.status===200&&x.json?.status==='delivered'),
  JSON.stringify(results.map(x=>[x.status,x.json?.detail])));
assert.ok(results.every(x=>Object.hasOwn(x.json,'delivery_pin')===false));
assert.ok(results.every(x=>x.json.payment_status==='paid'));
const orderAfter=await db.query(
  'SELECT status,payment_status,total,cash_collected,delivered_at,inventory_restored_at FROM orders WHERE id=$1',[first.id]);
assert.equal(orderAfter.rows[0].status,'delivered');
assert.equal(orderAfter.rows[0].payment_status,'paid');
assert.equal(orderAfter.rows[0].cash_collected,orderAfter.rows[0].total);
assert.ok(orderAfter.rows[0].delivered_at);
assert.equal(orderAfter.rows[0].inventory_restored_at,null);
async function proof(orderId) {
  const result=await db.query('SELECT driver_id,pin_verified,photo_url FROM delivery_proofs WHERE order_id=$1',[orderId]);
  assert.equal(result.rowCount,1);
  assert.equal(result.rows[0].driver_id,owner.id);
  assert.equal(result.rows[0].pin_verified,true);
  const ev=await db.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND status='delivered'",[orderId]);
  assert.equal(ev.rows[0].n,1);
  const out=await db.query('SELECT count(*)::int n FROM event_outbox WHERE event_key=$1',['order:'+orderId+':delivered']);
  assert.equal(out.rows[0].n,1);
  const metric=await db.query("SELECT count(*)::int n FROM product_events WHERE event_name='order_delivered' AND properties_json LIKE $1",
    ['%"order_id":'+orderId+'%']);
  assert.equal(metric.rows[0].n,1);
}
await proof(first.id);
const loyalty=async()=> (await db.query(
 'SELECT points,tier,streak_days,wallet_balance FROM loyalty_accounts WHERE user_id=$1',[customer.id])).rows[0];
let points=await loyalty();
assert.equal(points.points,4);
assert.equal(points.tier,'BRONZE');
assert.equal(points.streak_days,1);
assert.equal(points.wallet_balance,'0.00');
assert.equal((await call('/orders/'+first.id+'/cancel',{method:'POST',token:customer.token})).status,503);
const second=await order();
await ready(second.id);
assert.equal((await complete(second.id,second.delivery_pin)).status,200);
await proof(second.id);
points=await loyalty();
assert.equal(points.points,8);
assert.equal(points.streak_days,2);
const rateLimitOrder=await order();
await ready(rateLimitOrder.id);
const invalid=rateLimitOrder.delivery_pin==='0000'?'0001':'0000';
for(let i=0;i<5;i++){
  const got=await complete(rateLimitOrder.id,invalid);
  assert.equal(got.status,400,JSON.stringify(got.json));
}
const throttled=await complete(rateLimitOrder.id,rateLimitOrder.delivery_pin);
assert.equal(throttled.status,429);
const untouched=await db.query('SELECT status,payment_status,cash_collected FROM orders WHERE id=$1',[rateLimitOrder.id]);
assert.equal(untouched.rows[0].status,'ready');
assert.equal(untouched.rows[0].payment_status,'pending');
assert.equal(untouched.rows[0].cash_collected,'0.00');
assert.equal((await db.query('SELECT count(*)::int n FROM delivery_proofs WHERE order_id=$1',[rateLimitOrder.id])).rows[0].n,0);
const finalLoyalty=await loyalty();
assert.equal(finalLoyalty.points,8);
console.log('NODE_C3_PICKUP_PIN_PROOF_AND_RBAC=PASS');
console.log('NODE_C3_DOUBLE_COMPLETE_POINTS_STREAK_ONCE=PASS');
console.log('NODE_C3_BRUTE_FORCE_PIN_LIMIT_429_FAILCLOSED=PASS');
console.log('NODE_C3_OUTBOX_METRICS_ORDER_PAYMENT_SYNTHETIC=PASS');
await db.end();
