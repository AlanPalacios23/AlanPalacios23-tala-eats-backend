import assert from 'node:assert/strict';
import {enrollAdminQa} from './ci-admin-totp-helper.mjs';
import pgLib from 'pg';
import {Redis} from 'ioredis';
const url=String(process.env.DATABASE_URL??''),rurl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!url.includes('127.0.0.1:15435/tala_node_stage')||
 !rurl.includes('127.0.0.1:16379/0'))throw Error('CI_PRIVATE_DB_ONLY');
const red=new Redis(rurl);let c='0';do{const [n,k]=await red.scan(c,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);if(k.length)await red.del(...k);c=n;}while(c!=='0');red.disconnect();
const db=new pgLib.Client({connectionString:url});await db.connect();
async function api(path,{token,method='GET',body}={}){
 const res=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,
 headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
 ...(token?{authorization:'Bearer '+token}:{})},
 ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}return {status:res.status,json};}
async function user(name){const email='h1b.'+process.pid+'.'+name+'@example.test';
 const v=await api('/auth/register',{method:'POST',body:{name,email,password:'H1-Private-CI-Only!'}});
 assert.equal(v.status,201,JSON.stringify(v.json));return {id:v.json.user.id,email,token:v.json.access_token};}
async function change(x,role){
 await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,x.id]);
 const r=await api('/auth/login',{method:'POST',body:{email:x.email,password:'H1-Private-CI-Only!'}});
 assert.equal(r.status,200);x.token=r.json.access_token;}
const admin=await user('admin'),buyer=await user('buyer'),
 merchant=await user('merchant'),outsider=await user('outsider');
await change(admin,'admin');await change(merchant,'restaurant');
await enrollAdminQa(admin,api,'H1-Private-CI-Only!');
const go=(u,p,m='GET',body)=>api(p,{token:u?.token,method:m,body});
const store=(await db.query("INSERT INTO restaurants(name,address,owner_id) VALUES('H1 Test Store','Tala',$1) RETURNING id",[merchant.id])).rows[0].id;
async function menu(name,price){
 return (await db.query('INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,$2,$3,10) RETURNING id',
 [store,name,price])).rows[0].id;}
const original=await menu('Item principal','35.00'),
 same=await menu('Reemplazo mismo precio','35.00'),
 cheaper=await menu('Reemplazo descuento','25.00'),
 expensive=await menu('Reemplazo más caro','50.00');
const order=(await db.query(
 "INSERT INTO orders(user_id,restaurant_id,status,total,address) VALUES($1,$2,'preparing',70.00,'Tala') RETURNING id",
 [buyer.id,store])).rows[0].id;
const line=(await db.query(
 "INSERT INTO order_items(order_id,menu_item_id,name_snapshot,quantity,unit_price) VALUES($1,$2,'Item principal',2,35.00) RETURNING id",
 [order,original])).rows[0].id;
const base='/v11/orders/'+order;
assert.equal((await go(outsider,base+'/substitutions')).status,403);
assert.equal((await go(buyer,'/v11/merchant/orders/'+order+'/substitutions','POST',{
 order_item_id:line,replacement_menu_item_id:same})).status,403);
assert.equal((await go(merchant,'/v11/merchant/orders/'+order+'/substitutions','POST',{
 order_item_id:line,replacement_menu_item_id:expensive})).status,400);
const sameRequest=await go(merchant,'/v11/merchant/orders/'+order+'/substitutions','POST',{
 order_item_id:line,replacement_menu_item_id:same,issue_type:'quality'});
assert.equal(sameRequest.status,201,JSON.stringify(sameRequest.json));
assert.equal(sameRequest.json.original_amount,'70.00');
assert.equal(sameRequest.json.replacement_amount,'70.00');
const cheaperRequest=await go(merchant,'/v11/merchant/orders/'+order+'/substitutions','POST',{
 order_item_id:line,replacement_menu_item_id:cheaper});
assert.equal(cheaperRequest.status,201);
assert.equal(cheaperRequest.json.replacement_amount,'50.00');
assert.equal((await go(buyer,base+'/substitutions')).json.length,2);
assert.equal((await go(buyer,base+'/substitutions/'+cheaperRequest.json.id+'/respond','POST',{
 action:'accept'})).status,503);
const accepted=await go(buyer,base+'/substitutions/'+sameRequest.json.id+'/respond','POST',{
 action:'accept'});
assert.equal(accepted.status,200,JSON.stringify(accepted.json));
assert.equal(accepted.json.resolution,'replacement_accepted');
assert.equal((await go(buyer,base+'/substitutions/'+sameRequest.json.id+'/respond','POST',{
 action:'accept'})).status,404);
const updated=(await db.query('SELECT menu_item_id,unit_price FROM order_items WHERE id=$1',[line])).rows[0];
assert.equal(updated.menu_item_id,same);assert.equal(updated.unit_price,'35.00');
const wallet=(await db.query('SELECT refunded_amount FROM orders WHERE id=$1',[order])).rows[0];
assert.equal(wallet.refunded_amount,'0.00');
const events=(await db.query("SELECT count(*)::int n FROM event_outbox WHERE event_type='order.substitution' AND aggregate_id=$1",
 [String(order)])).rows[0].n;
assert.equal(events,3);
assert.equal((await go(outsider,base+'/refunds')).status,403);
await db.query(
 "INSERT INTO refund_adjustments(order_id,created_by_user_id,amount,reason,status,idempotency_key) VALUES($1,$2,0,'CI synthetic','pending',$3)",
 [order,admin.id,'ci-h1-'+order]);
const refunds=await go(buyer,base+'/refunds');
assert.equal(refunds.status,200);
assert.equal(refunds.json.length,1);assert.equal(refunds.json[0].amount,'0.00');
assert.equal((await go(buyer,'/v11/merchant/kds-pro')).status,403);
const kds=await go(merchant,'/v11/merchant/kds-pro');
assert.equal(kds.status,200,JSON.stringify(kds.json));
assert.equal(kds.json.restaurant.id,store);
assert.equal(kds.json.lanes.preparing.length,1);
assert.equal((await go(buyer,'/v11/admin/command-center')).status,403);
const center=await go(admin,'/v11/admin/command-center');
assert.equal(center.status,200);
assert.ok(center.json.operations.active_orders>=1);
assert.equal(center.json.integrations.payments.configured,false);
assert.equal(center.json.runtime.traffic_sampled,false);
assert.equal((await db.query(
 'SELECT count(*)::int n FROM financial_ledger_entries WHERE order_id=$1',
 [order])).rows[0].n,0);
console.log('NODE_H1_SUBSTITUTION_EQUAL_PRICE_ONLY_ONCE_OUTBOX=PASS');
console.log('NODE_H1_REFUND_READ_ONLY_AND_KDS_ADMIN_ACL=PASS');
await db.end();
