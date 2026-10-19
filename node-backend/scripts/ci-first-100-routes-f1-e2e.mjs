// F1: 35 real Python contracts -> Node staging. PostgreSQL15 Redis8 CI ONLY.
// Synthetic users, no actual payment capture, checkout to consumers disabled.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const url=String(process.env.DATABASE_URL??'');
const rurl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||
 !url.includes('127.0.0.1:15435/tala_node_stage')||
 !rurl.includes('127.0.0.1:16379/0'))throw Error('F1_DISPOSABLE_ONLY');
const redis=new Redis(rurl);
let cur='0';do{
 const [next,keys]=await redis.scan(cur,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);cur=next;
}while(cur!=='0');redis.disconnect();
const sql=new pg.Client({connectionString:url});
await sql.connect();
async function api(path,{token,method='GET',body}={}){
 const res=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,headers:{
  'content-type':'application/json','x-talaeats-client':'customer-mobile',
  ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}
 return {status:res.status,json,cache:res.headers.get('cache-control')};
}
const password='F1-First-100-Stage-Only!';
async function register(tag){
 const email='f1.'+process.pid+'.'+tag+'@example.test';
 const r=await api('/auth/register',{method:'POST',
  body:{email,name:'F1 '+tag,password}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return {id:r.json.user.id,token:r.json.access_token,email};
}
async function promote(u,role){
 await sql.query('UPDATE users SET role=$1 WHERE id=$2',[role,u.id]);
 const r=await api('/auth/login',{method:'POST',body:{email:u.email,password}});
 assert.equal(r.status,200,JSON.stringify(r.json));
 u.token=r.json.access_token;
}
const admin=await register('admin');
const customer=await register('customer');
const outsider=await register('outsider');
const driver=await register('driver');
const merchant=await register('merchant');
await promote(admin,'admin');await promote(driver,'driver');await promote(merchant,'restaurant');
const get=(who,path)=>api(path,{token:who?.token});
const denied=async path=>{
 assert.equal((await get(customer,path)).status,403,'not RBAC: '+path);
 assert.equal((await get(undefined,path)).status,401,'not auth: '+path);
};
const shop=(await sql.query(
 "INSERT INTO restaurants(name,address,lat,lng,market_code,brand_name,branch_code,is_open,eta_min)"+
 " VALUES('F1 Branch','Tala Centro',20.6534,-103.704,'TALA-JAL','F1Brand','MAIN',true,15) RETURNING id"
)).rows[0].id;
const shop2=(await sql.query(
 "INSERT INTO restaurants(name,address,lat,lng,market_code,brand_name,branch_code,is_open,eta_min)"+
 " VALUES('F1 Branch 2','Ameca Centro',20.55,-104.0,'TALA-JAL','F1Brand','AMECA',true,45) RETURNING id"
)).rows[0].id;
const item=(await sql.query(
 "INSERT INTO menu_items(restaurant_id,name,price,stock,availability_schedule_json,price_schedule_json)"+
 " VALUES($1,'Pizza horaria',40.00,10,$2,$3) RETURNING id",
 [shop,JSON.stringify({windows:[{days:[0,1,2,3,4,5,6],start:'00:00',end:'23:59'}]}),
 JSON.stringify({windows:[{days:[0,1,2,3,4,5,6],start:'00:00',end:'23:59',price:44.5}]})]
)).rows[0].id;
const order=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,total,subtotal,platform_commission,service_fee,"+
 " platform_revenue,contribution_margin,restaurant_payout,driver_earning,driver_id,status,address,estimated_minutes)"+
 " VALUES($1,$2,50.00,46.00,5.00,4.00,9.00,7.00,41.00,0.00,$3,'delivered','Calle Tala',20) RETURNING id",
 [customer.id,shop,driver.id])).rows[0].id;
const active=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,total,subtotal,platform_commission,status,address,estimated_minutes)"+
 " VALUES($1,$2,20.00,18.00,2.00,'ready','Tala',30) RETURNING id",
 [customer.id,shop])).rows[0].id;
await sql.query(
 "INSERT INTO service_zones(name,center_lat,center_lng,radius_km,surcharge,min_order,active)"+
 " VALUES('Tala F1',20.6534,-103.704,7,3.50,30.00,true),('Zona apagada',20.65,-103.70,8,9.00,20.00,false)");
await sql.query(
 "INSERT INTO feature_flags(key,description,enabled,rollout_percent,audience_role)"+
 " VALUES('f1.customer','Clientes',true,100,'customer'),('f1.admin','Administración',true,100,'admin'),('f1.disabled','Off',false,100,'all')");
await sql.query(
 "INSERT INTO fraud_flags(user_id,order_id,reason,severity,resolved)"+
 " VALUES($1,$2,'Prueba de riesgo','high',false)",[customer.id,active]);
await sql.query(
 "INSERT INTO verification_records(entity_type,entity_id,status,notes)"+
 " VALUES('restaurant',$1,'pending','Revisión de CI')",[shop]);
await sql.query(
 "INSERT INTO operational_incidents(order_id,incident_type,title,status)"+
 " VALUES($1,'delay','Entrega retrasada','open')",[active]);
await sql.query(
 "INSERT INTO system_settings(key,value,value_type) VALUES('v11.canary_percent','25','integer')"+
 " ON CONFLICT(key) DO UPDATE SET value='25'");
await sql.query(
 "INSERT INTO product_events(user_id,event_name,route)"+
 " VALUES($1,'app_open','/'),($1,'search','/buscar'),($1,'checkout_completed','/finalizado')",[customer.id]);
await sql.query(
 "INSERT INTO financial_ledger_entries(order_id,restaurant_id,user_id,account,direction,amount,kind,idempotency_key)"+
 " VALUES($1,$2,$3,'platform','credit',9.00,'order_checkout',$4)",
 [order,shop,customer.id,'f1-ledger-'+order]);
await sql.query(
 "INSERT INTO wallet_transactions(user_id,kind,amount,balance_after,idempotency_key)"+
 " VALUES($1,'gift_card',5.00,5.00,$2)",[customer.id,'f1-wallet-'+customer.id]);

// ADMIN: six meaningful protected read routes with pagination and privacy.
for(const path of ['/admin/stats','/admin/users','/admin/orders','/admin/fraud',
 '/admin/verifications','/admin/wallet/'+customer.id])await denied(path);
let response=await get(admin,'/admin/stats');
assert.equal(response.status,200,JSON.stringify(response.json));
assert.ok(response.json.users>=5);
assert.ok(response.json.active_orders>=1);
assert.ok(response.json.fraud_flags>=1);
assert.match(response.json.gross_sales,/^\d+\.\d{2}$/);
assert.equal(response.cache,'private, no-store');
response=await get(admin,'/admin/users?limit=2&offset=0');
assert.equal(response.status,200);assert.equal(response.json.length,2);
assert.ok(response.json.every(x=>!Object.hasOwn(x,'password_hash')&&!Object.hasOwn(x,'totp_secret')));
assert.equal((await get(admin,'/admin/users?limit=201')).status,422);
response=await get(admin,'/admin/orders?limit=10');
assert.equal(response.status,200);
const orderResponse=response.json.find(x=>x.id===order);
assert.equal(orderResponse.total,'50.00');
assert.ok(!Object.hasOwn(orderResponse,'delivery_pin'));
assert.ok(!Object.hasOwn(orderResponse,'inventory_reserved_json'));
response=await get(admin,'/admin/fraud');
assert.equal(response.status,200);
assert.ok(response.json.some(x=>x.reason==='Prueba de riesgo'));
assert.equal((await get(admin,'/admin/verifications')).json.some(x=>x.notes==='Revisión de CI'),true);
response=await get(admin,'/admin/wallet/'+customer.id);
assert.equal(response.status,200);
assert.ok(response.json.transactions.some(x=>x.kind==='gift_card'&&x.amount==='5.00'));
assert.equal((await get(admin,'/admin/wallet/99999999')).status,404);

// OPERATIONS: nine source-derived routes including geometry, finance and audit.
for(const path of ['/operations/admin/flags','/operations/admin/settings',
 '/operations/admin/command-center','/operations/admin/finance/summary',
 '/operations/admin/finance/orders/'+order,'/operations/admin/ledger'])
 await denied(path);
response=await get(undefined,'/operations/zones');
assert.equal(response.status,200);
assert.ok(response.json.some(x=>x.name==='Tala F1'&&x.surcharge==='3.50'));
assert.ok(response.json.every(x=>x.active));
response=await get(undefined,'/operations/coverage?lat=20.6534&lng=-103.704');
assert.equal(response.status,200);assert.equal(response.json.covered,true);
assert.ok(response.json.zones.some(x=>x.name==='Tala F1'&&x.min_order==='30.00'));
assert.equal((await get(undefined,'/operations/coverage?lat=0&lng=0')).json.covered,false);
assert.equal((await get(undefined,'/operations/coverage?lat=200&lng=0')).status,422);
response=await get(customer,'/operations/flags');
assert.equal(response.status,200);
assert.deepEqual(response.json.map(x=>x.key),['f1.customer']);
assert.deepEqual((await get(admin,'/operations/admin/flags')).json.map(x=>x.key).filter(x=>x.startsWith('f1.')),
 ['f1.admin','f1.customer','f1.disabled']);
response=await get(admin,'/operations/admin/settings');
assert.equal(response.status,200);
assert.ok(response.json.some(x=>x.key==='v11.canary_percent'&&x.value==='25'));
response=await get(admin,'/operations/admin/command-center');
assert.equal(response.status,200);
assert.ok(response.json.live.active_orders>=1);
assert.ok(response.json.live.open_incidents>=1);
assert.ok(response.json.today.delivered_orders>=0);
response=await get(admin,'/operations/admin/finance/summary');
assert.equal(response.status,200);
assert.ok(Number(response.json.gmv)>=50);
assert.match(response.json.gmv,/^\d+\.\d{2}$/);
response=await get(admin,'/operations/admin/finance/orders/'+order);
assert.equal(response.status,200);
assert.equal(response.json.total,'50.00');
assert.equal(response.json.commission,'5.00');
assert.equal((await get(admin,'/operations/admin/finance/orders/99999999')).status,404);
response=await get(admin,'/operations/admin/ledger?limit=10');
assert.equal(response.status,200);
assert.ok(response.json.some(x=>x.order_id===order&&x.amount==='9.00'));

// V9: loyalty/ETA/geographic branch/menu/funnel/status with true data.
for(const path of ['/v9/admin/funnel','/v9/admin/system-status'])await denied(path);
response=await get(undefined,'/v9/overview');
assert.equal(response.status,200);
assert.equal(response.json.version,'9.0.0-intelligence-growth-automation');
response=await get(customer,'/v9/loyalty/status');
assert.equal(response.status,200);
assert.equal(response.json.tier,'BRONZE');
assert.ok(response.json.progress_score>=25);
response=await get(customer,'/v9/plus/value');
assert.equal(response.status,200);
assert.equal(response.json.active,false);
response=await get(customer,'/v9/orders/'+order+'/eta');
assert.equal(response.status,200);
assert.equal(response.json.eta_minutes,0);
assert.equal((await get(outsider,'/v9/orders/'+order+'/eta')).status,403);
assert.equal((await get(customer,'/v9/orders/99999999/eta')).status,404);
response=await get(undefined,'/v9/markets');
assert.equal(response.status,200);
assert.ok(response.json.some(x=>x.market_code==='TALA-JAL'&&x.restaurants>=2));
response=await get(undefined,'/v9/brands/F1Brand/best-branch?lat=20.6534&lng=-103.704');
assert.equal(response.status,200,JSON.stringify(response.json));
assert.equal(response.json.id,shop);
assert.equal((await get(undefined,'/v9/brands/NOTFOUND/best-branch?lat=20&lng=-103')).status,404);
response=await get(undefined,'/v9/restaurants/'+shop+'/effective-menu');
assert.equal(response.status,200);
const priced=response.json.items.find(x=>x.id===item);
assert.equal(priced.effective_price,'44.50');
assert.equal(priced.available_now,true);
response=await get(admin,'/v9/admin/funnel?days=30');
assert.equal(response.status,200);
assert.equal(response.json.funnel.length,7);
assert.ok(response.json.funnel.find(x=>x.stage==='app_open').events>=1);
assert.equal((await get(admin,'/v9/admin/funnel?days=999')).json.days,180);
response=await get(admin,'/v9/admin/system-status');
assert.equal(response.status,200);
assert.equal(response.json.checks.payments,'not-configured');

// V10: accurate runtime signal (no fake production availability).
assert.equal((await get(undefined,'/v10/overview')).status,200);
assert.equal((await get(undefined,'/v10/runtime')).status,401);
response=await get(customer,'/v10/runtime');
assert.equal(response.status,200);
assert.equal(response.json.role,'customer');
assert.equal(response.json.redis,'ok');
await denied('/v10/admin/stability');
response=await get(admin,'/v10/admin/stability');
assert.equal(response.status,200);
assert.equal(response.json.dependencies.database,'ok');
assert.equal(response.json.traffic.sampled,false);

// V11 metadata/readiness must NEVER assert Node is live-ready.
assert.equal((await get(undefined,'/v11/overview')).status,200);
response=await get(undefined,'/v11/launch-readiness');
assert.equal(response.status,200);
assert.equal(response.json.core_ready,false);
assert.equal(response.json.go_live.online_payments,false);
assert.equal(response.json.canary_percent,25);
await denied('/v11/integrations');
response=await get(admin,'/v11/integrations');
assert.equal(response.status,200);
assert.equal(response.json.payments.configured,false);
assert.equal((await get(undefined,'/v11/release-cohort')).status,401);
response=await get(customer,'/v11/release-cohort');
assert.equal(response.status,200);
assert.equal(response.json.canary_percent,25);
assert.ok(response.json.bucket>=0&&response.json.bucket<100);
assert.deepEqual((await get(undefined,'/v11/push/config')).json,
 {enabled:false,public_key:null});
response=await get(customer,'/v11/privacy/preferences');
assert.equal(response.status,200);
assert.equal(response.json.marketing_opt_in,true);
assert.equal((await get(undefined,'/v11/privacy/preferences')).status,401);
response=await get(undefined,'/v11/mobile/contract');
assert.equal(response.status,200);
assert.equal(response.json.contract_version,'11.0');
assert.ok(response.json.node_stage_notice);
response=await get(undefined,'/v11/performance-budgets');
assert.equal(response.status,200);
assert.equal(response.json.api.p95_ms,1200);
assert.equal(response.json.mobile.lcp_ms,2500);
console.log('NODE_F1_ADMIN_6_ROUTER_CONTRACTS_RBAC_PRIVACY=PASS');
console.log('NODE_F1_OPERATIONS_9_REPORTING_ZONES_LEDGER_GATES=PASS');
console.log('NODE_F1_V9_9_ETA_MARKETS_MENU_LOYALTY=PASS');
console.log('NODE_F1_V10_3_HEALTH_RUNTIME_REAL_REDIS=PASS');
console.log('NODE_F1_V11_8_READINESS_FAIL_CLOSED_PRIVACY=PASS');
await sql.end();
