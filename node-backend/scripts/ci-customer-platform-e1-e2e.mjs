// Customer Platform E1 contract E2E, CI-only PostgreSQL15 + Redis8.
// Addresses, favorites, notifications and bootstrapped loyalty, never money.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
if(process.env.GITHUB_ACTIONS!=='true'||
  !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage')||
  !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0'))
  throw Error('PLATFORM_E1_DISPOSABLE_CI_ONLY');
const base='http://127.0.0.1:18190/api/v1';
const redis=new Redis(process.env.REDIS_URL);
let cur='0';
do {
 const [next,keys]=await redis.scan(cur,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);
 cur=next;
} while(cur!=='0');
redis.disconnect();
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
async function call(path,{token,method='GET',body}={}){
 const response=await fetch(base+path,{method,
  headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
   ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await response.json()}catch{}
 return {status:response.status,json,cache:response.headers.get('cache-control')};
}
const password='Platform-Only-E1-Pass-2026!';
async function account(name){
 const email='e1.'+process.pid+'.'+name+'@example.test';
 const res=await call('/auth/register',{method:'POST',
  body:{name:'E1 '+name,email,password}});
 assert.equal(res.status,201,JSON.stringify(res.json));
 return {id:res.json.user.id,token:res.json.access_token,email};
}
const alice=await account('alice');
const bob=await account('bob');
const merchant=await account('merchant');
await db.query("UPDATE users SET role='restaurant' WHERE id=$1",[merchant.id]);
const relog=await call('/auth/login',{method:'POST',
 body:{email:merchant.email,password}});
assert.equal(relog.status,200);
merchant.token=relog.json.access_token;
const platform=(who,path,method='GET',body)=>call('/platform'+path,{
 token:who?.token,method,body});
const initial=await platform(alice,'/bootstrap');
assert.equal(initial.status,200,JSON.stringify(initial.json));
assert.equal(initial.json.user.id,alice.id);
assert.equal(initial.json.user.email,alice.email);
const aliceInitialUnread=initial.json.unread_notifications;
assert.ok(Number.isInteger(aliceInitialUnread)&&aliceInitialUnread>=0);
assert.equal(initial.json.online_payments,false);
assert.equal(initial.json.google_signin,false);
assert.equal(initial.json.wallet.points,0);
assert.equal(initial.cache,'private, no-store');
assert.equal((await platform(undefined,'/bootstrap')).status,401);
const loyalty=await platform(alice,'/loyalty');
assert.equal(loyalty.status,200);
assert.equal(loyalty.json.points,0);
assert.equal(loyalty.json.tier,'BRONZE');
assert.equal(Number(loyalty.json.wallet_balance),0);
assert.equal((await platform(merchant,'/loyalty')).status,403);

const addresses=await platform(alice,'/addresses');
assert.equal(addresses.status,200);
assert.deepEqual(addresses.json,[]);
assert.equal((await platform(merchant,'/addresses')).status,403);
assert.equal((await platform(alice,'/addresses','POST',{
 label:'Casa',address:'A'
})).status,422);
const a=await platform(alice,'/addresses','POST',{
 label:'Casa',address:'Calle Libertad 10 Tala',lat:20.6502,lng:-103.703,is_default:true});
assert.equal(a.status,201,JSON.stringify(a.json));
assert.equal(a.json.is_default,true);
const b=await platform(alice,'/addresses','POST',{
 label:'Trabajo',address:'Parque industrial Tala',is_default:false});
assert.equal(b.status,201);
assert.equal((await platform(bob,'/addresses/'+a.json.id,'PATCH',{
 address:'Robada 112'
})).status,404);
assert.equal((await platform(bob,'/addresses/'+a.json.id,'DELETE')).status,404);
assert.equal((await platform(alice,'/addresses/'+b.json.id,'PATCH',{
 lat:200
})).status,422);
const modified=await platform(alice,'/addresses/'+b.json.id,'PATCH',{
 is_default:true,label:'Oficina'});
assert.equal(modified.status,200);
assert.equal(modified.json.is_default,true);
assert.equal(modified.json.label,'Oficina');
assert.equal((await platform(alice,'/addresses')).json.find(x=>x.id===a.json.id).is_default,false);
const pair=await Promise.all([
 platform(alice,'/addresses','POST',{
  label:'Temporal1',address:'Tala calle uno',is_default:true}),
 platform(alice,'/addresses','POST',{
  label:'Temporal2',address:'Tala calle dos',is_default:true}),
]);
assert.ok(pair.every(x=>x.status===201),JSON.stringify(pair));
let rows=(await platform(alice,'/addresses')).json;
assert.equal(rows.filter(x=>x.is_default).length,1);
const defaults=(await db.query('SELECT COUNT(*)::int n FROM addresses WHERE user_id=$1 AND is_default=true',
 [alice.id])).rows[0].n;
assert.equal(defaults,1);
const latest=rows.find(x=>x.is_default);
assert.equal((await platform(alice,'/addresses/'+latest.id,'DELETE')).status,204);
rows=(await platform(alice,'/addresses')).json;
assert.equal(rows.length,3);
assert.equal(rows.filter(x=>x.is_default).length,1);
assert.equal(rows.find(x=>x.is_default).id,a.json.id); // replacement by smallest id
const bobList=await platform(bob,'/addresses');
assert.deepEqual(bobList.json,[]);

const rest=(await db.query(
 "INSERT INTO restaurants(name,address,market_code) VALUES('Favorito E1 Tala','Tala Centro','TALA-JAL') RETURNING id"
)).rows[0].id;
assert.equal((await platform(alice,'/favorites')).json.length,0);
assert.equal((await platform(merchant,'/favorites')).status,403);
assert.equal((await platform(alice,'/favorites/999999','POST')).status,404);
assert.deepEqual((await platform(alice,'/favorites/'+rest,'POST')).json,{favorite:true});
const favoriteList=await platform(alice,'/favorites');
assert.equal(favoriteList.status,200);
assert.equal(favoriteList.json.length,1);
assert.equal(favoriteList.json[0].id,rest);
assert.equal(favoriteList.json[0].name,'Favorito E1 Tala');
assert.deepEqual((await platform(bob,'/favorites')).json,[]);
assert.deepEqual((await platform(alice,'/favorites/'+rest,'POST')).json,{favorite:false});
const concurrentFav=await Promise.all([
 platform(alice,'/favorites/'+rest,'POST'),
 platform(alice,'/favorites/'+rest,'POST'),
]);
assert.equal(concurrentFav.filter(x=>x.status===200).length,2);
assert.deepEqual(concurrentFav.map(x=>x.json.favorite).sort(),[false,true]);
assert.deepEqual((await platform(alice,'/favorites')).json,[]);
const saved=(await db.query(
 'SELECT COUNT(*)::int n FROM favorites WHERE user_id=$1 AND restaurant_id=$2',
 [alice.id,rest])).rows[0].n;
assert.equal(saved,0);

const n1=(await db.query(
 "INSERT INTO notifications(user_id,kind,title,message) VALUES($1,'order','Pedido recibido','Listo') RETURNING id",
 [alice.id])).rows[0].id;
const n2=(await db.query(
 "INSERT INTO notifications(user_id,kind,title,message) VALUES($1,'system','Aviso','Mensaje 2') RETURNING id",
 [alice.id])).rows[0].id;
const bobInitialUnread=(await platform(bob,'/bootstrap')).json.unread_notifications;
const outsider=(await db.query(
 "INSERT INTO notifications(user_id,kind,title,message) VALUES($1,'system','Privado','Bob') RETURNING id",
 [bob.id])).rows[0].id;
assert.equal((await platform(bob,'/notifications/'+n1+'/read','PATCH')).status,404);
assert.equal((await platform(alice,'/notifications/'+outsider+'/read','PATCH')).status,404);
const notifications=await platform(alice,'/notifications');
assert.equal(notifications.status,200);
assert.equal(notifications.json.length,aliceInitialUnread+2);
assert.equal(notifications.json[0].id,n2);
assert.equal(notifications.json[0].is_read,false);
assert.equal(notifications.cache,'private, no-store');
assert.equal((await platform(alice,'/bootstrap')).json.unread_notifications,aliceInitialUnread+2);
const read=await platform(alice,'/notifications/'+n1+'/read','PATCH');
assert.equal(read.status,200);
assert.equal(read.json.is_read,true);
assert.equal((await platform(alice,'/bootstrap')).json.unread_notifications,aliceInitialUnread+1);
assert.deepEqual((await platform(alice,'/notifications/read-all','POST')).json,{updated:aliceInitialUnread+1});
assert.deepEqual((await platform(alice,'/notifications/read-all','POST')).json,{updated:0});
assert.equal((await platform(alice,'/bootstrap')).json.unread_notifications,0);
assert.equal((await platform(bob,'/notifications')).json.length,bobInitialUnread+1);
assert.equal((await platform(bob,'/notifications')).json[0].is_read,false);
console.log('NODE_E1_CUSTOMER_ADDRESS_DEFAULT_AND_TENANT_ISOLATION=PASS');
console.log('NODE_E1_FAVORITES_CONCURRENT_TOGGLE_AND_PRIVACY=PASS');
console.log('NODE_E1_NOTIFICATIONS_READ_ALL_AND_BOOTSTRAP_UNREAD=PASS');
console.log('NODE_E1_LOYALTY_READ_ONLY_AND_NO_PAYMENT_WRITES=PASS');
await db.end();
