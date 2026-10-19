import assert from 'node:assert/strict';
import pgLib from 'pg';
import { Redis } from 'ioredis';
const db=String(process.env.DATABASE_URL??''),redisUrl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!db.includes('127.0.0.1:15435/tala_node_stage')||!redisUrl.includes('127.0.0.1:16379/0')) throw Error('CI_ONLY');
const red=new Redis(redisUrl);
let c='0';do{const [next,keys]=await red.scan(c,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);if(keys.length)await red.del(...keys);c=next;}while(c!=='0');red.disconnect();
const sql=new pgLib.Client({connectionString:db});await sql.connect();
async function api(path,{token,method='GET',body}={}){
 const res=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,
 headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',...(token?{authorization:'Bearer '+token}:{})},
 ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}return {status:res.status,json};}
async function make(name){const email='h1a.'+process.pid+'.'+name+'@example.test';
 const res=await api('/auth/register',{method:'POST',body:{name,email,password:'H1-Disposable-Test-2026!'}});
 assert.equal(res.status,201,JSON.stringify(res.json));return {id:res.json.user.id,token:res.json.access_token,email};}
const one=await make('one'),two=await make('two'),admin=await make('admin');
await sql.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);
const login=await api('/auth/login',{method:'POST',body:{email:admin.email,password:'H1-Disposable-Test-2026!'}});
assert.equal(login.status,200);admin.token=login.json.access_token;
const call=(u,path,method='GET',body)=>api(path,{token:u?.token,method,body});
assert.equal((await call(one,'/v11/admin/canary','PUT',{percent:15})).status,403);
assert.equal((await call(admin,'/v11/admin/canary','PUT',{percent:105})).status,422);
assert.deepEqual((await call(admin,'/v11/admin/canary','PUT',{percent:25})).json,{canary_percent:25});
assert.equal((await call(null,'/v11/launch-readiness')).json.canary_percent,25);
assert.equal((await call(null,'/v11/launch-readiness')).json.core_ready,false);
const ep='https://push.example.test/h1/'+process.pid;
const saved=await call(one,'/v11/push/subscriptions','POST',{endpoint:ep,platform:'web'});
assert.equal(saved.status,201,JSON.stringify(saved.json));
assert.ok(!Object.hasOwn(saved.json,'endpoint')&&!Object.hasOwn(saved.json,'auth'));
const changed=await call(two,'/v11/push/subscriptions','POST',{endpoint:ep,platform:'web'});
assert.equal(changed.status,201,JSON.stringify(changed.json));
const rows=(await sql.query('SELECT user_id,active FROM push_subscriptions WHERE endpoint=$1',[ep])).rows;
assert.equal(rows.filter(x=>x.active).length,1);
assert.equal(rows.find(x=>x.active).user_id,two.id);
assert.equal((await call(one,'/v11/push/subscriptions/'+changed.json.id,'DELETE')).status,404);
assert.equal((await call(two,'/v11/push/subscriptions/'+changed.json.id,'DELETE')).status,204);
const store=(await sql.query("INSERT INTO restaurants(name,address,lat,lng,is_open) VALUES('H1 Test Market','Tala Centro',20.65,-103.7,true) RETURNING id")).rows[0].id;
const geo=await call(one,'/v11/maps/geocode','POST',{query:'H1 Test Market'});
assert.equal(geo.status,200,JSON.stringify(geo.json));
assert.equal(geo.json.provider,'local-catalog');
assert.ok(geo.json.results.some(x=>x.label==='H1 Test Market'));
assert.equal((await call(one,'/v11/maps/geocode','POST',{query:'x'})).status,422);
const route=await call(one,'/v11/maps/route','POST',{
 origin_lat:20.65,origin_lng:-103.7,destination_lat:20.66,destination_lng:-103.71});
assert.equal(route.status,200);
assert.equal(route.json.precise_road_route,false);
assert.ok(route.json.distance_km>0);
assert.equal((await call(one,'/v11/maps/route','POST',{
 origin_lat:200,origin_lng:-103.7,destination_lat:20.66,destination_lng:-103.71})).status,422);
const order=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,status,address,total) VALUES($1,$2,'preparing','Tala',35.00) RETURNING id",
 [one.id,store])).rows[0].id;
await sql.query("INSERT INTO order_events(order_id,status) VALUES($1,'received'),($1,'confirmed')",[order]);
const live=await call(one,'/v11/orders/'+order+'/live');
assert.equal(live.status,200);
assert.equal(live.json.driver_location,null);
assert.equal(live.json.route,null);
assert.equal(live.json.timeline.length,2);
assert.equal(live.json.stages.find(x=>x.key==='preparing').active,true);
assert.equal((await call(two,'/v11/orders/'+order+'/live')).status,403);
console.log('NODE_H1_CANARY_PUSH_CROSS_USER_MAPS_PRIVATE_LIVE=PASS');
await sql.end();
