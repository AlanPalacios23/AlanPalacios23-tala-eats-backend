// E1 customer API end-to-end. Disposable GitHub Actions PostgreSQL15/Redis8 ONLY.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const base='http://127.0.0.1:18190/api/v1';
if(process.env.GITHUB_ACTIONS!=='true'||
 !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage')||
 !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0')||
 process.env.PLATFORM_E1_ENABLED!=='true')
 throw Error('PLATFORM_E1_CI_ONLY_GUARD');
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
// New Node process may not be listening immediately after background launch.
for(let attempt=0;attempt<50;attempt++){
  try{
    const response=await fetch(base+'/ready');
    if(response.ok && (await response.json()).ready===true)break;
  }catch{}
  if(attempt===49)throw Error('PLATFORM_E1_API_NOT_READY');
  await new Promise(resolve=>setTimeout(resolve,250));
}
const password='E1-Customer-Synthetic-Pass-2026!';
async function req(path,{token,method='GET',body}={}){
 const response=await fetch(base+path,{
  method,headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
    ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
 });
 let json=null;try{json=await response.json()}catch{}
 return {status:response.status,json,cache:response.headers.get('cache-control')};
}
async function register(name){
 const email='e1.'+process.pid+'.'+name+'@example.test';
 const response=await req('/auth/register',{method:'POST',body:{
   email,name:'E1 '+name,password,
 }});
 assert.equal(response.status,201,JSON.stringify(response.json));
 return {id:response.json.user.id,token:response.json.access_token,email};
}
async function promote(user,role){
 await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,user.id]);
 const login=await req('/auth/login',{method:'POST',body:{email:user.email,password}});
 assert.equal(login.status,200,JSON.stringify(login.json));
 user.token=login.json.access_token;
}
const a=await register('a'),b=await register('b'),driver=await register('driver');
await promote(driver,'driver');
const api=(who,path,method='GET',body)=>req('/platform'+path,{token:who?.token,method,body});
assert.equal((await api(null,'/addresses')).status,401);
assert.equal((await api(driver,'/addresses')).status,403);
assert.equal((await api(driver,'/favorites')).status,403);
assert.equal((await api(a,'/addresses','POST',{address:'bad'})).status,422);
assert.equal((await api(a,'/addresses','POST',{address:'Calle Uno 2',lat:91})).status,422);
const first=await api(a,'/addresses','POST',{label:'Casa',address:'Calle Uno 21'});
assert.equal(first.status,201,JSON.stringify(first.json));
assert.equal(first.json.is_default,false);
assert.equal(first.json.lat,null);
assert.equal(first.cache,'private, no-store');
const concurrent=await Promise.all([
 api(a,'/addresses','POST',{label:'Casa',address:'Calle Dos 22',is_default:true}),
 api(a,'/addresses','POST',{label:'Trabajo',address:'Calle Tres 3',is_default:true}),
 api(a,'/addresses','POST',{label:'Familia',address:'Calle Cuatro 4',is_default:true}),
]);
assert.ok(concurrent.every(x=>x.status===201),JSON.stringify(concurrent));
let addresses=(await api(a,'/addresses')).json;
assert.equal(addresses.length,4);
assert.equal(addresses.filter(x=>x.is_default).length,1);
const dbDefault=(await db.query(
 'SELECT count(*)::int n FROM addresses WHERE user_id=$1 AND is_default=true',[a.id])).rows[0].n;
assert.equal(dbDefault,1);
assert.equal(addresses[0].is_default,true);
const bAddr=await api(b,'/addresses','POST',{
 address:'Otra persona 45',is_default:true,lat:20.65,lng:-103.7,
});
assert.equal(bAddr.status,201);
assert.equal((await api(b,'/addresses/'+first.json.id,'PATCH',{address:'Intento ilegal 99'})).status,404);
assert.equal((await api(b,'/addresses/'+first.json.id,'DELETE')).status,404);
assert.equal((await api(driver,'/addresses/'+first.json.id,'PATCH',{address:'Intento ajeno 99'})).status,404);
assert.equal((await api(a,'/addresses/'+first.json.id,'PATCH',{label:'Oficina',lat:-91})).status,422);
const promoteDefault=await api(a,'/addresses/'+first.json.id,'PATCH',{
 label:'Casa favorita',is_default:true,lat:20.6534,lng:-103.704,
});
assert.equal(promoteDefault.status,200,JSON.stringify(promoteDefault.json));
assert.equal(promoteDefault.json.is_default,true);
assert.equal(promoteDefault.json.lat,20.6534);
assert.equal(promoteDefault.json.lng,-103.704);
addresses=(await api(a,'/addresses')).json;
assert.equal(addresses.filter(x=>x.is_default).length,1);
assert.equal(addresses[0].id,first.json.id);
const deleted=await api(a,'/addresses/'+first.json.id,'DELETE');
assert.equal(deleted.status,204);
assert.equal(deleted.json,null);
addresses=(await api(a,'/addresses')).json;
assert.equal(addresses.length,3);
assert.equal(addresses.filter(x=>x.is_default).length,1);
const lowest=Math.min(...concurrent.map(x=>x.json.id));
assert.equal(addresses[0].id,lowest); // Python deletion chooses lowest ID
assert.equal((await api(a,'/addresses/99999999','DELETE')).status,404);
assert.equal((await api(b,'/addresses')).json.length,1);
const restaurant=(await db.query(
 "INSERT INTO restaurants(name,address,market_code,is_open) VALUES('Tala E1','Centro Tala','TALA-JAL',true) RETURNING id",
)).rows[0].id;
assert.deepEqual((await api(a,'/favorites')).json,[]);
assert.equal((await api(a,'/favorites/99999999','POST')).status,404);
assert.equal((await api(b,'/favorites/'+restaurant,'POST')).json.favorite,true);
const toggles=await Promise.all([
 api(a,'/favorites/'+restaurant,'POST'),
 api(a,'/favorites/'+restaurant,'POST'),
]);
assert.ok(toggles.every(x=>x.status===200),JSON.stringify(toggles));
assert.deepEqual(toggles.map(x=>x.json.favorite).sort(),[false,true]);
assert.deepEqual((await api(a,'/favorites')).json,[]);
assert.equal((await api(b,'/favorites')).json[0].id,restaurant);
assert.equal((await api(a,'/favorites/'+restaurant,'POST')).json.favorite,true);
const restaurants=(await api(a,'/favorites')).json;
assert.equal(restaurants.length,1);
assert.equal(restaurants[0].name,'Tala E1');
assert.equal(restaurants[0].market_code,'TALA-JAL');
assert.equal(restaurants[0].is_open,true);
assert.equal((await api(driver,'/favorites/'+restaurant,'POST')).status,403);
const scope=(await db.query(
 'SELECT count(*)::int n FROM favorites WHERE user_id=$1 AND restaurant_id=$2',
 [a.id,restaurant])).rows[0].n;
assert.equal(scope,1);
const notifications=await Promise.all(Array.from({length:52},(_,i)=>db.query(
 'INSERT INTO notifications(user_id,kind,title,message,is_read,created_at)'+
 ' VALUES($1,$2,$3,$4,false,now()+($5::int * interval \'1 second\')) RETURNING id',
 [a.id,'system','E1 notice '+i,'Message '+i,i],
)));
const bNotification=(await db.query(
 "INSERT INTO notifications(user_id,kind,title,message,is_read) VALUES($1,'order','B-only','Secret B',false) RETURNING id",
 [b.id])).rows[0].id;
const myNotifs=await api(a,'/notifications');
assert.equal(myNotifs.status,200);
assert.equal(myNotifs.cache,'private, no-store');
assert.equal(myNotifs.json.length,50); // Python limit=50
assert.equal(myNotifs.json[0].title,'E1 notice 51');
assert.equal(myNotifs.json[0].is_read,false);
assert.equal((await api(a,'/notifications/'+bNotification+'/read','PATCH')).status,404);
assert.equal((await api(b,'/notifications/'+notifications[0].rows[0].id+'/read','PATCH')).status,404);
const read=await api(a,'/notifications/'+notifications[0].rows[0].id+'/read','PATCH');
assert.equal(read.status,200);
assert.equal(read.json.is_read,true);
assert.ok(read.json.created_at.includes('T'));
const unreadBefore=(await db.query(
 'SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND is_read=false',[a.id]
)).rows[0].n;
const all=await api(a,'/notifications/read-all','POST');
assert.equal(all.status,200);
assert.equal(all.json.updated,unreadBefore); // Includes any register/welcome notices.
assert.equal((await api(a,'/notifications/read-all','POST')).json.updated,0);
assert.equal((await api(b,'/notifications')).json.length,1);
assert.equal((await api(b,'/notifications')).json[0].is_read,false);
assert.equal((await api(driver,'/notifications')).status,200);
assert.equal((await api(driver,'/notifications')).json.length,0);
const otherUnread=(await db.query(
 'SELECT is_read FROM notifications WHERE id=$1',[bNotification])).rows[0].is_read;
assert.equal(otherUnread,false);
console.log('NODE_E1_CUSTOMER_ADDRESSES_ATOMIC_DEFAULT_AND_CROSS_TENANT=PASS');
console.log('NODE_E1_FAVORITES_CONCURRENT_TOGGLE_AND_ROLE_SCOPING=PASS');
console.log('NODE_E1_NOTIFICATIONS_50_LIMIT_MARK_READ_READALL_IDEMPOTENT=PASS');
console.log('NODE_E1_PLATFORM_NO_FINANCIAL_WRITES_OR_PRODUCTION=PASS');
await db.end();
