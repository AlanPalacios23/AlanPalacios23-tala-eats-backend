// E4 functional contracts, CI-only disposable PostgreSQL15/Redis8.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const dbUrl=String(process.env.DATABASE_URL??'');
const redisUrl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||
 !dbUrl.includes('127.0.0.1:15435/tala_node_stage')||
 !redisUrl.includes('127.0.0.1:16379/0'))throw Error('E4_DISPOSABLE_CI_ONLY');
const redis=new Redis(redisUrl);
let cursor='0';
do{
 const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);
 cursor=next;
}while(cursor!=='0');
redis.disconnect();
const client=new pg.Client({connectionString:dbUrl});
await client.connect();
const base='http://127.0.0.1:18190/api/v1';
async function call(path,{token,method='GET',body}={}){
 const res=await fetch(base+path,{method,headers:{
  'content-type':'application/json','x-talaeats-client':'customer-mobile',
  ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}
 return {status:res.status,json,cache:res.headers.get('cache-control')};
}
const pwd='E4-Wallet-Read-CI-Only-2026!';
async function register(label){
 const email='e4.'+process.pid+'.'+label+'@example.test';
 const r=await call('/auth/register',{method:'POST',
  body:{email,name:'E4 '+label,password:pwd}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return {id:r.json.user.id,email,token:r.json.access_token};
}
async function promote(who,role){
 await client.query('UPDATE users SET role=$1 WHERE id=$2',[role,who.id]);
 const r=await call('/auth/login',{method:'POST',body:{email:who.email,password:pwd}});
 assert.equal(r.status,200,JSON.stringify(r.json));
 who.token=r.json.access_token;
}
const alice=await register('alice');
const bob=await register('bob');
const admin=await register('admin');
const merchant=await register('merchant');
await promote(admin,'admin');
await promote(merchant,'restaurant');
const api=(who,path)=>call('/platform'+path,{token:who?.token});
const ref=(await client.query('SELECT referral_code FROM loyalty_accounts WHERE user_id=$1',[alice.id])).rows[0].referral_code;
await client.query('UPDATE loyalty_accounts SET wallet_balance=123.45, points=345, plus_member=true WHERE user_id=$1',[alice.id]);
for(let i=1;i<=105;i++){
 await client.query(
 'INSERT INTO wallet_transactions(user_id,kind,amount,balance_after,reference_type,reference_id,description,idempotency_key,created_at)'+
 " VALUES($1,'gift_card',1.00,123.45,'test',$2,'Synthetic CI only',$3,$4)",
 [alice.id,'e4-'+i,'e4-'+alice.id+'-'+i,new Date(Date.UTC(2026,9,19,0,i))]);
}
const bobTx=(await client.query(
 'INSERT INTO wallet_transactions(user_id,kind,amount,balance_after,reference_type,reference_id,description,idempotency_key)'+
 " VALUES($1,'gift_card',5.00,5.00,'test','bob','Private Bob',$2) RETURNING id",
 [bob.id,'e4-bob-'+bob.id])).rows[0].id;
assert.equal((await api(merchant,'/wallet')).status,403);
assert.equal((await api(undefined,'/wallet')).status,401);
const summary=await api(alice,'/wallet');
assert.equal(summary.status,200,JSON.stringify(summary.json));
assert.equal(summary.cache,'private, no-store');
assert.equal(summary.json.balance,'123.45');
assert.equal(summary.json.points,345);
assert.equal(summary.json.plus_member,true);
assert.equal(summary.json.referral_code,ref);
assert.equal(summary.json.transactions.length,20);
assert.equal(summary.json.transactions[0].reference_id,'e4-105');
assert.equal(summary.json.transactions[19].reference_id,'e4-86');
assert.equal(summary.json.transactions[0].amount,'1.00');
const hist=await api(alice,'/wallet/transactions');
assert.equal(hist.status,200);
assert.equal(hist.json.length,100);
assert.equal(hist.json[0].reference_id,'e4-105');
assert.equal(hist.json[99].reference_id,'e4-6');
assert.equal((await api(bob,'/wallet/transactions')).json[0].id,bobTx);
assert.equal((await api(admin,'/wallet/transactions')).json.length,0);
assert.equal((await api(merchant,'/wallet/transactions')).status,403);

const restaurantIds=[];
for(let i=0;i<8;i++){
 const sponsor=(i===0||i===3||i===6);
 const rating=i===6?'5.00':i===3?'4.99':i===0?'4.98':'4.20';
 const row=await client.query(
  'INSERT INTO restaurants(name,address,is_open,sponsored,rating) VALUES($1,$2,$3,$4,$5) RETURNING id',
  ['E4 Shop '+i,'Tala',i!==7,sponsor,rating]);
 restaurantIds.push(row.rows[0].id);
}
assert.equal((await api(merchant,'/recommendations')).status,403);
const rec=await api(alice,'/recommendations');
assert.equal(rec.status,200,JSON.stringify(rec.json));
assert.equal(rec.json.engine,'rules');
assert.equal(rec.json.restaurants.length,6);
assert.equal(rec.cache,'private, no-store');
assert.deepEqual(rec.json.restaurants.slice(0,3).map(x=>x.id),
 [restaurantIds[6],restaurantIds[3],restaurantIds[0]]);
assert.ok(rec.json.restaurants.every(x=>x.is_open));
assert.equal((await api(admin,'/recommendations')).status,200);

const group='E4GROUP';
async function addOrder(who,status,total,when,code=group){
 const out=await client.query(
  'INSERT INTO orders(user_id,restaurant_id,status,group_code,total,address,created_at)'+
  " VALUES($1,$2,$3,$4,$5,'Tala CI',$6) RETURNING id",
  [who.id,restaurantIds[0],status,code,total,when]);
 return out.rows[0].id;
}
const a1=await addOrder(alice,'received','25.50','2026-10-19T08:00:00Z');
const b1=await addOrder(bob,'delivered','40.00','2026-10-19T08:01:00Z');
const a2=await addOrder(alice,'confirmed','100.00','2026-10-19T08:02:00Z');
await addOrder(alice,'received','50.00','2026-10-19T08:03:00Z','OTHER');
const mine=await api(alice,'/groups/'+group);
assert.equal(mine.status,200,JSON.stringify(mine.json));
assert.deepEqual(mine.json.map(x=>x.id),[a1,a2]);
assert.deepEqual(mine.json.map(x=>x.total),['25.50','100.00']);
assert.equal(mine.json[0].scheduled_for,null);
assert.equal(mine.cache,'private, no-store');
assert.deepEqual((await api(bob,'/groups/'+group)).json.map(x=>x.id),[b1]);
assert.deepEqual((await api(admin,'/groups/'+group)).json.map(x=>x.id),[a1,b1,a2]);
assert.deepEqual((await api(merchant,'/groups/'+group)).json,[]);
assert.equal((await api(undefined,'/groups/'+group)).status,401);
assert.equal((await api(alice,'/groups/TOOLONGGROUPCODE')).status,422);

const referral=await api(alice,'/referral');
assert.equal(referral.status,200);
assert.equal(referral.json.code,ref);
assert.match(referral.json.reward_rule,/Código persistente listo/);
assert.equal(referral.cache,'private, no-store');
assert.equal((await api(admin,'/referral')).status,403);
assert.equal((await api(merchant,'/referral')).status,403);
const state=(await client.query('SELECT points,wallet_balance,plus_member FROM loyalty_accounts WHERE user_id=$1',[alice.id])).rows[0];
assert.equal(state.points,345);
assert.equal(state.wallet_balance,'123.45');
assert.equal(state.plus_member,true);
assert.equal((await client.query(
 'SELECT count(*)::int n FROM wallet_transactions WHERE user_id=$1',[alice.id]
 )).rows[0].n,105);
console.log('NODE_E4_WALLET_20_100_HISTORY_PRIVATE_READ_ONLY=PASS');
console.log('NODE_E4_RECOMMENDATIONS_SPONSORED_RATING_OPEN=PASS');
console.log('NODE_E4_GROUP_OWNERSHIP_ADMIN_AND_REFERRAL=PASS');
console.log('NODE_E4_NO_WALLET_MUTATION_OR_PAYOUT=PASS');
await client.end();
