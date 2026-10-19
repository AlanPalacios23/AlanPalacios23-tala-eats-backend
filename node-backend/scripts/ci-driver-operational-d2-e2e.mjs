// Synthetic-only D2 driver complete contract E2E on GitHub Actions PG15/Redis8.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const base='http://127.0.0.1:18190/api/v1';
if(process.env.GITHUB_ACTIONS!=='true'||
 !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage')||
 !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0')||
 process.env.STAGE_DRIVER_DELIVERY_ENABLED!=='true')throw Error('D2_CI_ONLY_GUARD');
const redis=new Redis(process.env.REDIS_URL);
let cursor='0';
do {
 const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);cursor=next;
} while(cursor!=='0');
redis.disconnect();
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
async function request(path,{token,method='GET',body}={}) {
 const result=await fetch(base+path,{method,
 headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
   ...(token?{authorization:'Bearer '+token}:{})},
 ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await result.json()}catch{}
 return {status:result.status,json,cache:result.headers.get('cache-control')};
}
const password='Stage-Driver-Synthetic-2026!';
async function register(label){
 const email='d2.'+process.pid+'.'+label+'@example.test';
 const r=await request('/auth/register',{method:'POST',
   body:{name:'Driver D2 '+label,email,password}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return {id:r.json.user.id,email,token:r.json.access_token};
}
async function promote(user,role){
 await client.query('UPDATE users SET role=$1 WHERE id=$2',[role,user.id]);
 const login=await request('/auth/login',{method:'POST',
   body:{email:user.email,password}});
 assert.equal(login.status,200,JSON.stringify(login.json));
 user.token=login.json.access_token;
}
const driver1=await register('one');
const driver2=await register('two');
const customer=await register('customer');
const outsider=await register('outsider');
await promote(driver1,'driver');await promote(driver2,'driver');
const restaurantId=(await client.query(
 "INSERT INTO restaurants(name,address,lat,lng) VALUES('D2 Tala','Tala Centro',20.6534,-103.704) RETURNING id",
)).rows[0].id;
async function fixture(ref, trusted=true){
 const q=await client.query(
 'INSERT INTO orders(user_id,restaurant_id,status,payment_status,payment_method,order_type,'+
 ' address,delivery_pin,total,driver_earning,tip,delivery_lat,delivery_lng,distance_km,'+
 ' ready_at,client_reference) VALUES($1,$2,\'ready\',\'pending\',\'cash\',\'delivery\','+
 ' \'Casa cliente\',\'7235\',101.00,24.00,3.00,20.654,-103.705,2.8,now(),$3) RETURNING id',
 [customer.id,restaurantId,ref]);
 const id=q.rows[0].id;
 if(trusted)await client.query(
 'INSERT INTO order_events(order_id,status,metadata_json) VALUES($1,$2,$3)',
 [id,'received',JSON.stringify({stage_driver_fixture:true})]);
 return id;
}
const first=await fixture('d2-order-1');
const second=await fixture('d2-order-2');
const untrusted=await fixture('d2-order-untrusted',false);
const api=(who,path,method='GET',body)=>request('/driver'+path,
 {token:who.token,method,body});
assert.equal((await api(customer,'/dashboard')).status,403);
const before=await api(driver1,'/dashboard');
assert.equal(before.status,200,JSON.stringify(before.json));
assert.equal(before.json.profile.is_online,false);
assert.equal(before.json.active,null);
assert.equal(before.json.last_7_days.length,7);
assert.equal(before.cache,'private, no-store');
assert.deepEqual((await api(driver1,'/available')).json,[]);
assert.equal((await api(driver1,'/location','PATCH',{lat:190,lng:0})).status,422);
const gps=await api(driver1,'/location','PATCH',{lat:20.6534,lng:-103.704});
assert.equal(gps.status,200,JSON.stringify(gps.json));
assert.equal(gps.json.current_lat,20.6534);
assert.equal((await api(driver1,'/availability','PATCH',{is_online:'true'})).status,422);
const online=await Promise.all([
 api(driver1,'/availability','PATCH',{is_online:true}),
 api(driver2,'/availability','PATCH',{is_online:true}),
]);
assert.ok(online.every(x=>x.status===200),JSON.stringify(online));
const assigned=(await client.query(
 'SELECT id,driver_id,status FROM orders WHERE id=ANY($1::int[]) ORDER BY id',
 [[first,second,untrusted]])).rows;
assert.equal(assigned.filter(x=>x.driver_id!==null).length,2);
assert.equal(assigned.find(x=>x.id===untrusted).driver_id,null);
const dash1=(await api(driver1,'/dashboard')).json;
const dash2=(await api(driver2,'/dashboard')).json;
assert.ok(dash1.active?.id&&dash2.active?.id&&dash1.active.id!==dash2.active.id);
assert.equal(dash1.active.restaurant.name,'D2 Tala');
assert.equal(dash1.active.customer.name,'Driver D2 customer');
assert.equal(dash1.active.earning,27);
assert.equal((await api(driver1,'/availability','PATCH',{is_online:false})).status,409);
assert.equal((await api(driver1,'/orders/'+dash2.active.id+'/status','PATCH',{status:'picked_up'})).status,403);
assert.equal((await api(driver1,'/orders/'+untrusted+'/accept','POST')).status,409);
assert.equal((await api(driver1,'/orders/'+dash2.active.id+'/accept','POST')).status,409);
const assignedId=dash1.active.id;
const transition=(next)=>api(driver1,'/orders/'+assignedId+'/status','PATCH',{status:next});
assert.equal((await transition('on_the_way')).status,409);
assert.equal((await transition('picked_up')).status,200);
assert.equal((await transition('picked_up')).status,409);
assert.equal((await transition('on_the_way')).status,200);
assert.equal((await api(driver1,'/orders/'+assignedId+'/complete','POST',{pin:'9999'})).status,400);
const completed=await Promise.all([
 api(driver1,'/orders/'+assignedId+'/complete','POST',{pin:'7235',lat:20.654,lng:-103.705}),
 api(driver1,'/orders/'+assignedId+'/complete','POST',{pin:'7235',lat:20.654,lng:-103.705}),
]);
assert.ok(completed.every(x=>x.status===200&&x.json.status==='delivered'),JSON.stringify(completed));
assert.ok(completed.every(x=>!Object.hasOwn(x.json,'delivery_pin')));
const proof=(await client.query(
 'SELECT driver_id,pin_verified FROM delivery_proofs WHERE order_id=$1',[assignedId])).rows;
assert.equal(proof.length,1);
assert.equal(proof[0].driver_id,driver1.id);
assert.equal(proof[0].pin_verified,true);
const events=(await client.query(
 "SELECT COUNT(*)::int n FROM order_events WHERE order_id=$1 AND status='delivered'",
 [assignedId])).rows[0].n;
assert.equal(events,1);
const wallet=(await client.query(
 'SELECT points FROM loyalty_accounts WHERE user_id=$1',[customer.id])).rows[0];
assert.equal(wallet.points,10);
const profile=(await client.query(
 'SELECT total_deliveries,earnings_today FROM driver_profiles WHERE user_id=$1',
 [driver1.id])).rows[0];
assert.equal(profile.total_deliveries,1);
assert.equal(profile.earnings_today,'27.00');
const after=(await api(driver1,'/dashboard')).json;
assert.equal(after.today.deliveries,1);
assert.equal(after.today.earnings,27);
assert.equal(after.recent[0].id,assignedId);
assert.equal(after.active,null);
assert.equal((await api(driver1,'/availability','PATCH',{is_online:false})).status,200);
assert.equal((await api(customer,'/orders/'+assignedId+'/complete','POST',{pin:'7235'})).status,403);
assert.equal((await api(outsider,'/location','PATCH',{lat:20,lng:-103})).status,403);
assert.equal((await api(driver2,'/orders/'+assignedId+'/complete','POST',{pin:'7235'})).status,403);
console.log('NODE_D2_ATOMIC_TWO_DRIVER_ASSIGNMENT=PASS');
console.log('NODE_D2_DRIVER_DASHBOARD_LOCATION_AND_STATUS=PASS');
console.log('NODE_D2_PIN_PROOF_AND_LOYALTY_EXACTLY_ONCE=PASS');
console.log('NODE_D2_UNTRUSTED_ORDER_AND_TENANT_BLOCKED=PASS');
await client.end();
