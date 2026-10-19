// E2 functional customer: active promotions/coupons + review one delivered order.
// Synthetic PG15 Redis8 GitHub Actions ONLY; no coupon redemption/financial writes.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const base='http://127.0.0.1:18190/api/v1';
if(process.env.GITHUB_ACTIONS!=='true'||
 !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage')||
 !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0')||
 process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false')
 throw Error('PLATFORM_E2_DISPOSABLE_CI_ONLY');
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
const pass='Platform-E2-Only-2026!';
async function call(path,{token,method='GET',body}={}){
  const response=await fetch(base+path,{
    method,headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
      ...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  let json=null;try{json=await response.json()}catch{}
  return {status:response.status,json};
}
async function register(label){
  const email='platformE2.'+process.pid+'.'+label+'@example.test';
  const r=await call('/auth/register',{method:'POST',body:{
    name:'E2 '+label,email,password:pass,
  }});
  assert.equal(r.status,201,JSON.stringify(r.json));
  return {token:r.json.access_token,id:r.json.user.id,email};
}
async function promote(u,role){
  await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,u.id]);
  const r=await call('/auth/login',{method:'POST',
    body:{email:u.email,password:pass}});
  assert.equal(r.status,200);
  u.token=r.json.access_token;
}
const alice=await register('alice');
const bob=await register('bob');
const merchant=await register('merchant');
await promote(merchant,'restaurant');
const restaurant=(await db.query(
  "INSERT INTO restaurants(name,address) VALUES('Tala E2 Reviews','Tala Centro') RETURNING id",
)).rows[0].id;
await db.query(
  'INSERT INTO promotions(restaurant_id,title,discount_percent,active,sponsored) VALUES'+
  "($1,'E2 Sponsored',15,true,true),"+
  "($1,'E2 Organic',10,true,false),"+
  "($1,'E2 Inactive',20,false,true)",[restaurant],
);
await db.query(
  "INSERT INTO coupons(code,discount_type,value,min_order,active,description) VALUES"+
  "('E2WELCOME','percent',15.00,70.00,true,'Bienvenido'),"+
  "('E2HIDDEN','percent',50.00,10.00,false,'Oculto')",
);
const promos=await call('/platform/promotions');
assert.equal(promos.status,200,JSON.stringify(promos.json));
assert.equal(promos.json.filter(x=>x.title==='E2 Inactive').length,0);
const sponsored=promos.json.find(x=>x.title==='E2 Sponsored');
const organic=promos.json.find(x=>x.title==='E2 Organic');
assert.ok(sponsored&&organic);
assert.ok(promos.json.indexOf(sponsored)<promos.json.indexOf(organic));
assert.equal(sponsored.restaurant_id,restaurant);
assert.equal(sponsored.discount_percent,15);
const coupons=await call('/platform/coupons');
assert.equal(coupons.status,200,JSON.stringify(coupons.json));
assert.equal(coupons.json.some(x=>x.code==='E2HIDDEN'),false);
const welcome=coupons.json.find(x=>x.code==='E2WELCOME');
assert.ok(welcome);
assert.equal(Number(welcome.value),15);
assert.equal(Number(welcome.min_order),70);
async function seedOrder(owner,status){
  return (await db.query(
    'INSERT INTO orders(user_id,restaurant_id,address,status,payment_method,payment_status)'+
    ' VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [owner.id,restaurant,'E2 domicilio',status,'cash',
     status==='delivered'?'paid':'pending'],
  )).rows[0].id;
}
const done=await seedOrder(alice,'delivered');
const done2=await seedOrder(alice,'delivered');
const waiting=await seedOrder(alice,'received');
const other=await seedOrder(bob,'delivered');
const review=(who,body)=>call('/platform/reviews',{method:'POST',token:who.token,body});
const firstInput={order_id:done,restaurant_rating:5,comment:'Todo excelente'};
assert.equal((await review(merchant,firstInput)).status,403);
assert.equal((await review(alice,{...firstInput,restaurant_rating:0})).status,422);
assert.equal((await review(alice,{...firstInput,restaurant_rating:6})).status,422);
assert.equal((await review(alice,{...firstInput,driver_rating:8})).status,422);
assert.equal((await review(alice,{...firstInput,comment:'x'.repeat(1001)})).status,422);
assert.equal((await review(alice,{...firstInput,order_id:waiting})).status,400);
assert.equal((await review(alice,{...firstInput,order_id:other})).status,400);
assert.equal((await review(alice,{...firstInput,order_id:99999999})).status,400);
const created=await review(alice,firstInput);
assert.equal(created.status,201,JSON.stringify(created.json));
assert.equal(created.json.order_id,done);
assert.equal(created.json.restaurant_id,restaurant);
assert.equal(created.json.restaurant_rating,5);
assert.equal(created.json.driver_rating,null);
assert.equal(created.json.comment,'Todo excelente');
assert.ok(created.json.created_at.includes('T'));
assert.equal((await review(alice,firstInput)).status,409);
const raced=await Promise.all([
  review(alice,{order_id:done2,restaurant_rating:4,comment:'Bien'}),
  review(alice,{order_id:done2,restaurant_rating:3,comment:'Regular'}),
  review(alice,{order_id:done2,restaurant_rating:5,comment:'Excelente'}),
]);
assert.deepEqual(raced.map(x=>x.status).sort(),[201,409,409],JSON.stringify(raced));
const records=await db.query(
  'SELECT count(*)::int n FROM reviews WHERE user_id=$1 AND order_id=ANY($2::int[])',
  [alice.id,[done,done2]]);
assert.equal(records.rows[0].n,2);
const outside=await db.query('SELECT count(*)::int n FROM reviews WHERE user_id=$1',[bob.id]);
assert.equal(outside.rows[0].n,0);
const payments=await db.query('SELECT count(*)::int n FROM financial_ledger_entries WHERE order_id=ANY($1::int[])',[[done,done2]]);
assert.equal(payments.rows[0].n,0);
const ordered=await db.query(
 'SELECT count(*)::int n FROM orders WHERE id=ANY($1::int[]) AND status=$2',
 [[done,done2],'delivered']);
assert.equal(ordered.rows[0].n,2);
console.log('NODE_E2_ACTIVE_PROMOTIONS_AND_COUPONS_PYTHON_PUBLIC=PASS');
console.log('NODE_E2_REVIEW_OWN_DELIVERED_ONLY_ROLE_AND_RATING_CHECKS=PASS');
console.log('NODE_E2_REVIEW_CONCURRENT_UNIQUE_ONE_WINNER=PASS');
console.log('NODE_E2_NO_WALLET_PSP_OR_FINANCIAL_WRITES=PASS');
await db.end();
