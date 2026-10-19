// G3: V9/V11 collaborative, privacy and bounded administrative contracts.
// Disposable PostgreSQL15 + Redis8 ONLY. Never deploy this seed.
import assert from 'node:assert/strict';
import pgLib from 'pg';
import {Redis} from 'ioredis';
const pgUrl=String(process.env.DATABASE_URL??''),ru=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!pgUrl.includes('127.0.0.1:15435/tala_node_stage')||
 !ru.includes('127.0.0.1:16379/0'))throw Error('G3_CI_ONLY');
const red=new Redis(ru);let cursor='0';do{
 const [next,keys]=await red.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await red.del(...keys);cursor=next;
}while(cursor!=='0');red.disconnect();
const pg=new pgLib.Client({connectionString:pgUrl});await pg.connect();
const password='G3-Stage-Concurrency-Privacy!';
async function call(path,{token,method='GET',body}={}){
 const res=await fetch('http://127.0.0.1:18190/api/v1'+path,{
  method,headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
  ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}
 return {status:res.status,json,cache:res.headers.get('cache-control')};
}
async function signup(tag){
 const email='g3.'+process.pid+'.'+tag+'@example.test';
 const r=await call('/auth/register',{method:'POST',
  body:{email,name:'G3 '+tag,password}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return {id:r.json.user.id,email,token:r.json.access_token};
}
async function promote(u,role){
 await pg.query('UPDATE users SET role=$1 WHERE id=$2',[role,u.id]);
 const s=await call('/auth/login',{method:'POST',body:{email:u.email,password}});
 assert.equal(s.status,200,JSON.stringify(s.json));u.token=s.json.access_token;
}
const alice=await signup('alice'),bob=await signup('bob'),
 admin=await signup('admin'),driver=await signup('driver');
await promote(admin,'admin');await promote(driver,'driver');
const api=(who,path,method='GET',body)=>
 call(path,{token:who?.token,method,body});
const shop=(await pg.query(
 "INSERT INTO restaurants(name,address,market_code,is_open) VALUES('G3 Cocina','Tala','TALA-JAL',true) RETURNING id"
)).rows[0].id;
const foreignShop=(await pg.query(
 "INSERT INTO restaurants(name,address,is_open) VALUES('G3 Otro','Ameca',true) RETURNING id"
)).rows[0].id;
const item=(await pg.query(
 "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,'Tortas G3',42.00,12) RETURNING id",
 [shop])).rows[0].id;
const itemOther=(await pg.query(
 "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,'Aguas G3',20.00,8) RETURNING id",
 [foreignShop])).rows[0].id;
const create=await api(alice,'/v9/groups','POST',{restaurant_id:shop});
assert.equal(create.status,201,JSON.stringify(create.json));
const code=create.json.code;
assert.match(code,/^[A-Z0-9]{12}$/);
assert.equal((await api(null,'/v9/groups/'+code)).status,401);
assert.equal((await api(bob,'/v9/groups/'+code)).json.participants,1);
assert.equal((await api(bob,'/v9/groups/'+code+'/lock','POST')).status,404);
assert.equal((await api(bob,'/v9/groups/'+code+'/checkout-payload')).status,404);
assert.equal((await api(alice,'/v9/groups/INVALID')).status,404);
assert.equal((await api(alice,'/v9/groups','POST',{restaurant_id:9999999})).status,404);
assert.equal((await api(bob,'/v9/groups/'+code+'/items','POST',
 {menu_item_id:itemOther,quantity:1})).status,400);
const both=await Promise.all([
 api(bob,'/v9/groups/'+code+'/items','POST',{menu_item_id:item,quantity:2}),
 api(alice,'/v9/groups/'+code+'/items','POST',{menu_item_id:item,quantity:1}),
]);
assert.ok(both.every(x=>x.status===200),JSON.stringify(both));
const group=await api(alice,'/v9/groups/'+code);
assert.equal(group.status,200);
assert.equal(group.json.items.length,2);
assert.equal(group.json.participants,2);
assert.equal(group.cache,'private, no-store');
const checkout=await api(alice,'/v9/groups/'+code+'/checkout-payload');
assert.equal(checkout.status,200);
assert.deepEqual(checkout.json.items,[{menu_item_id:item,quantity:3,options:''}]);
assert.equal((await api(alice,'/v9/groups/'+code+'/lock','POST')).status,200);
assert.equal((await api(bob,'/v9/groups/'+code+'/items','POST',{
 menu_item_id:item,quantity:3})).status,409);
assert.equal((await api(alice,'/v9/groups/'+code+'/checkout-payload')).json.items[0].quantity,3);
assert.equal((await api(alice,'/v9/admin/corporate','POST',
 {name:'Corp G3'})).status,403);
const corp=await api(admin,'/v9/admin/corporate','POST',{
 name:'Empresa G3 '+process.pid,monthly_budget:'1000.25',cost_center:'TALA'});
assert.equal(corp.status,201,JSON.stringify(corp.json));
assert.equal(corp.json.monthly_budget,'1000.25');
assert.deepEqual((await api(bob,'/v9/corporate/me')).json,[]);
assert.equal((await api(bob,'/v9/corporate/join','POST',{
 join_code:'INVALID'})).status,404);
const joined=await api(bob,'/v9/corporate/join','POST',{
 join_code:corp.json.join_code.toLowerCase(),employee_code:'E001'});
assert.equal(joined.status,200);
assert.equal(joined.json.monthly_budget,'1000.25');
assert.equal((await api(bob,'/v9/corporate/join','POST',{
 join_code:corp.json.join_code,employee_code:'SHOULD_NOT_UPDATE'})).status,200);
const mine=await api(bob,'/v9/corporate/me');
assert.equal(mine.status,200);
assert.equal(mine.json.length,1);
assert.equal(mine.json[0].employee_code,'E001');
assert.equal((await api(alice,'/v9/corporate/me')).json.length,0);
const n=(await pg.query(
 "INSERT INTO orders(user_id,restaurant_id,status,total,address) VALUES($1,$2,'received',22.50,'CI Tala') RETURNING id",
 [bob.id,shop])).rows[0].id;
const exportMine=await api(bob,'/v9/privacy','POST',{request_type:'export'});
assert.equal(exportMine.status,201,JSON.stringify(exportMine.json));
assert.equal(exportMine.json.status,'completed');
assert.equal(exportMine.json.result.profile.id,bob.id);
assert.ok(exportMine.json.result.orders.some(x=>x.id===n&&x.total==='22.50'));
assert.equal(exportMine.cache,'private, no-store');
const privacy=await api(bob,'/v11/privacy/preferences','PUT',{
 marketing_opt_in:false,analytics_opt_in:false});
assert.equal(privacy.status,200,JSON.stringify(privacy.json));
assert.equal(privacy.json.marketing_opt_in,false);
assert.equal(privacy.json.analytics_opt_in,false);
assert.equal((await api(alice,'/v11/privacy/preferences')).status,200);
const erased=await api(alice,'/v9/privacy','POST',{request_type:'delete'});
assert.equal(erased.status,201);
assert.equal(erased.json.status,'pending');
assert.equal((await api(null,'/v9/privacy','POST',{request_type:'delete'})).status,401);
const unsub=await api(alice,'/v9/privacy','POST',{request_type:'marketing_opt_out'});
assert.equal(unsub.status,201);
assert.equal((await api(alice,'/v11/privacy/preferences')).json.marketing_opt_in,false);
const devices=await api(bob,'/v9/security/devices');
assert.equal(devices.status,200);
assert.ok(devices.json.length>=1);
assert.ok(devices.json.some(x=>x.active===true));
const bobSession=devices.json.find(x=>x.active);
assert.equal((await api(alice,'/v9/security/devices/'+bobSession.id,'DELETE')).status,404);
assert.equal((await api(bob,'/v9/security/devices/'+bobSession.id,'DELETE')).status,204);
assert.equal((await api(bob,'/v9/security/devices')).status,401);
// Admin-only CRM, incentives, legacy batching OFF.
assert.equal((await api(alice,'/v9/admin/segments')).status,403);
const seg=await api(admin,'/v9/admin/segments');
assert.equal(seg.status,200);
assert.ok(seg.json.customers.some(x=>x.user_id===alice.id&&x.segment==='new'));
assert.equal((await api(alice,'/v9/admin/marketing','POST',{
 name:'G3 V9',trigger_type:'vip',message_template:'Bienvenido'})).status,403);
const campaign=await api(admin,'/v9/admin/marketing','POST',{
 name:'Retención G3',trigger_type:'vip',channel:'in_app',
 message_template:'Regresa {coupon}',coupon_code:'G3'});
assert.equal(campaign.status,201,JSON.stringify(campaign.json));
assert.equal((await api(admin,'/v9/admin/marketing')).json.some(x=>x.id===campaign.json.id),true);
const inc=await api(admin,'/v9/admin/incentives','POST',{
 title:'Incentivo CI',bonus_per_delivery:'3.50',multiplier:'1.20'});
assert.equal(inc.status,201,JSON.stringify(inc.json));
assert.equal(inc.json.bonus_per_delivery,'3.50');
assert.equal((await api(driver,'/v9/driver/incentives')).json.some(x=>x.id===inc.json.id),true);
assert.equal((await api(alice,'/v9/driver/incentives')).status,403);
assert.equal((await api(alice,'/v9/admin/dispatch/batches')).status,403);
assert.deepEqual((await api(admin,'/v9/admin/dispatch/batches')).json,[]);
assert.equal((await api(admin,'/v9/admin/dispatch/batch-assign','POST')).status,409);
assert.equal((await api(alice,'/v9/admin/restaurants/'+shop+'/market','PATCH')).status,403);
const changed=await api(admin,'/v9/admin/restaurants/'+shop+
 '/market?market_code=AMECA-JAL&brand_name=G3%20Group&branch_code=CENTRO','PATCH');
assert.equal(changed.status,200,JSON.stringify(changed.json));
assert.equal(changed.json.market_code,'AMECA-JAL');
assert.equal(changed.json.branch_code,'CENTRO');
assert.equal((await api(admin,'/v9/admin/restaurants/9999999/market?market_code=TALA','PATCH')).status,404);
assert.equal((await api(null,'/v11/privacy/preferences','PUT',{marketing_opt_in:false})).status,401);
const money=(await pg.query('SELECT count(*)::int n FROM payouts')).rows[0].n;
assert.ok(Number.isInteger(money));
console.log('NODE_G3_GROUP_CART_OWNER_LOCK_CONCURRENT_ITEM_MERGE=PASS');
console.log('NODE_G3_CORPORATE_JOIN_CODES_AND_PRIVATE_MEMBERS=PASS');
console.log('NODE_G3_PRIVACY_EXPORT_CONSENT_AND_REVOKE_DEVICE=PASS');
console.log('NODE_G3_ADMIN_CRM_INCENTIVES_DISABLED_BATCH_MARKET_RBAC=PASS');
await pg.end();
