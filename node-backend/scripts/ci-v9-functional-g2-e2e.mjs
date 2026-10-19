// G2 V9 twenty real routes, disposable PG15+Redis8 only.
import assert from 'node:assert/strict';
import pg from 'pg';
import {Redis} from 'ioredis';
const url=String(process.env.DATABASE_URL??''),ru=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!url.includes('127.0.0.1:15435/tala_node_stage')||
 !ru.includes('127.0.0.1:16379/0'))throw Error('V9_G2_CI_ONLY');
const redis=new Redis(ru);let cur='0';do{
 const [next,keys]=await redis.scan(cur,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
 if(keys.length)await redis.del(...keys);cur=next;
}while(cur!=='0');redis.disconnect();
const sql=new pg.Client({connectionString:url});await sql.connect();
const password='V9-G2-Strict-Route-Test!';
async function call(path,{token,method='GET',body}={}){
 const res=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,
  headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
  ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}
 return {status:res.status,json};
}
async function person(tag){
 const email='g2.'+process.pid+'.'+tag+'@example.test';
 const r=await call('/auth/register',{method:'POST',body:{name:'G2 '+tag,email,password}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return {id:r.json.user.id,email,token:r.json.access_token};
}
async function promote(u,role){
 await sql.query('UPDATE users SET role=$1 WHERE id=$2',[role,u.id]);
 const x=await call('/auth/login',{method:'POST',body:{email:u.email,password}});
 assert.equal(x.status,200);u.token=x.json.access_token;
}
const admin=await person('admin'),shopUser=await person('shop'),customer=await person('customer'),
 stranger=await person('stranger'),driver=await person('driver');
await promote(admin,'admin');await promote(shopUser,'restaurant');await promote(driver,'driver');
const go=(u,p,m='GET',body)=>call('/v9'+p,{token:u?.token,method:m,body});
const store=(await sql.query(
 "INSERT INTO restaurants(name,address,owner_id,cuisine,rating,is_open)"+
 " VALUES('G2 Café Saludable','Centro Tala',$1,'Desayuno café',4.99,true) RETURNING id",
 [shopUser.id])).rows[0].id;
const otherStore=(await sql.query(
 "INSERT INTO restaurants(name,address,cuisine,is_open)"+
 " VALUES('G2 Otro','Centro Tala','Comida mexicana',true) RETURNING id")).rows[0].id;
const menu=(await sql.query(
 "INSERT INTO menu_items(restaurant_id,name,description,category,price,stock,dietary_tags)"+
 " VALUES($1,'Ensalada proteína','Pollo saludable','Ensalada',90.00,10,'healthy') RETURNING id",
 [store])).rows[0].id;
const extra=(await sql.query(
 "INSERT INTO menu_items(restaurant_id,name,category,price,stock)"+
 " VALUES($1,'Agua natural','Bebidas',15.00,10) RETURNING id",
 [store])).rows[0].id;
const event=await go(null,'/events','POST',{event_name:'restaurant_view',
 session_id:'session-g2',route:'/restaurantes/g2',properties:{source:'CI'}});
assert.equal(event.status,202,JSON.stringify(event.json));
assert.deepEqual(event.json,{accepted:true});
assert.equal((await go(null,'/events','POST',{event_name:'x'})).status,422);
const find=await go(null,'/search?q=ensalada%20saludable&max_price=100&limit=20');
assert.equal(find.status,200,JSON.stringify(find.json));
assert.equal(find.json.intent.healthy,true);
assert.ok(find.json.results.some(x=>x.restaurant.id===store&&
 x.items.some(y=>y.id===menu)));
assert.equal((await go(null,'/search?limit=55')).status,200); // clamp Python max? if bound not 422?
const unmatched=await go(null,'/search?q=ensalada&max_price=10');
assert.equal(unmatched.status,200);
assert.ok(!unmatched.json.results.some(x=>x.items.some(y=>y.id===menu)));
assert.equal((await go(null,'/search?max_price=invalid')).status,422);
const fav=await call('/platform/favorites/'+store,{token:customer.token,method:'POST'});
assert.equal(fav.status,200);
const recommendation=await go(customer,'/recommendations');
assert.equal(recommendation.status,200);
assert.ok(recommendation.json.restaurants.some(x=>x.id===store&&x.reason==='Favorito'));
assert.equal((await go(null,'/recommendations')).status,401);
const delivered=[];
for(let i=0;i<3;i++){
 const rest=i===2?otherStore:store;
 delivered.push((await sql.query(
  'INSERT INTO orders(user_id,restaurant_id,status,total,address,created_at,delivered_at)'+
  " VALUES($1,$2,'delivered',35.00,'Tala CI',NOW(),NOW()) RETURNING id",
  [customer.id,rest])).rows[0].id);
}
const missions=await go(customer,'/loyalty/missions');
assert.equal(missions.status,200);
assert.equal(missions.json.find(x=>x.key==='three_orders').claimable,true);
assert.equal(missions.json.find(x=>x.key==='two_restaurants').claimable,true);
const concurrent=await Promise.all([
 go(customer,'/loyalty/missions/three_orders/claim','POST'),
 go(customer,'/loyalty/missions/three_orders/claim','POST'),
]);
assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409],JSON.stringify(concurrent));
const points=(await sql.query('SELECT points FROM loyalty_accounts WHERE user_id=$1',[customer.id])).rows[0].points;
assert.equal(points,100);
const refs=(await sql.query(
 "SELECT count(*)::int n FROM wallet_transactions WHERE user_id=$1 AND kind='mission_reward'",
 [customer.id])).rows[0].n;
assert.equal(refs,1);
assert.equal((await go(customer,'/loyalty/missions/invalid/claim','POST')).status,404);
const second=await go(customer,'/loyalty/missions/two_restaurants/claim','POST');
assert.equal(second.status,200,JSON.stringify(second.json));
assert.equal(second.json.points,180);
assert.equal((await go(customer,'/loyalty/missions')).json.every(x=>x.claimed),true);
assert.equal((await go(customer,'/admin/heatmap')).status,403);
const map=await go(admin,'/admin/heatmap?hours=24');
assert.equal(map.status,200,JSON.stringify(map.json));
assert.ok(map.json.points.length>=1);
assert.ok(map.json.points.some(x=>x.orders>=3));
const forecast=await go(admin,'/admin/demand-forecast?hours=5');
assert.equal(forecast.status,200,JSON.stringify(forecast.json));
assert.equal(forecast.json.forecast.length,5);
assert.equal(forecast.json.method,'56d-hourly-moving-average');
const delayed=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,status,address,updated_at)"+
 " VALUES($1,$2,'ready','Tala CI',NOW()-INTERVAL '15 minutes') RETURNING id",
 [customer.id,store])).rows[0].id;
const detected=await go(admin,'/admin/incidents/detect','POST');
assert.equal(detected.status,200,JSON.stringify(detected.json));
const incidents=(await go(admin,'/admin/incidents')).json;
assert.ok(incidents.some(x=>x.order_id===delayed&&x.type==='no_driver'));
const picked=incidents.find(x=>x.order_id===delayed&&x.type==='no_driver');
const resolved=await go(admin,'/admin/incidents/'+picked.id,'PATCH',
 {status:'resolved',note:'QA G2'});
assert.equal(resolved.status,200);
assert.equal((await go(customer,'/admin/incidents')).status,403);
const score=await go(driver,'/driver/score');
assert.equal(score.status,200);
assert.equal(score.json.deliveries,0);
assert.equal((await go(customer,'/driver/score')).status,403);
const st=await go(shopUser,'/merchant/ingredients','POST',{
 name:'Harina',unit:'kg',quantity:'12.250',reorder_level:'3.000',unit_cost:'15.20'});
assert.equal(st.status,201,JSON.stringify(st.json));
const item=st.json.id;
assert.equal((await go(customer,'/merchant/ingredients')).status,403);
assert.ok((await go(shopUser,'/merchant/ingredients')).json.some(x=>x.id===item));
const down=await go(shopUser,'/merchant/ingredients/'+item,'PATCH',{
 quantity_delta:'-4.125',reason:'Producción'});
assert.equal(down.status,200);
assert.equal(down.json.quantity,'8.125');
const across=await go(shopUser,'/merchant/recipes','POST',{
 menu_item_id:menu,ingredient_id:item,quantity_required:'0.250'});
assert.equal(across.status,201,JSON.stringify(across.json));
assert.equal(across.json.quantity_required,'0.250');
const foreignIngredient=(await sql.query(
 "INSERT INTO ingredient_stocks(restaurant_id,name) VALUES($1,'Otro') RETURNING id",
 [otherStore])).rows[0].id;
assert.equal((await go(shopUser,'/merchant/ingredients/'+foreignIngredient,'PATCH',
 {quantity_delta:'1'})).status,404);
assert.equal((await go(shopUser,'/merchant/recipes','POST',
 {menu_item_id:menu,ingredient_id:foreignIngredient,quantity_required:'0.250'})).status,404);
const waste=await go(shopUser,'/merchant/waste','POST',{
 ingredient_id:item,quantity:'1.000',reason:'Producto dañado'});
assert.equal(waste.status,201);
assert.equal(waste.json.estimated_cost,'15.20');
const stock=(await sql.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',[item])).rows[0].quantity;
assert.equal(stock,'7.125');
const upsell=await go(shopUser,'/merchant/upsell/'+menu);
assert.equal(upsell.status,200);
assert.ok(upsell.json.suggestions.some(x=>x.id===extra));
assert.equal((await go(shopUser,'/merchant/upsell/99999999')).status,404);
const intel=await go(shopUser,'/merchant/intelligence');
assert.equal(intel.status,200);
assert.equal(intel.json.restaurant_id,store);
assert.ok(intel.json.delivered>=2);
const kitchen=await go(shopUser,'/merchant/kitchen-forecast?hours=3');
assert.equal(kitchen.status,200);assert.equal(kitchen.json.forecast.length,3);
assert.equal((await go(stranger,'/merchant/intelligence')).status,403);
const risk=await go(admin,'/admin/trust/risk');
assert.equal(risk.status,200);
assert.ok(Array.isArray(risk.json));
assert.equal((await go(customer,'/admin/trust/risk')).status,403);
console.log('NODE_G2_SMART_SEARCH_FAVORITES_RECOMMENDATIONS=PASS');
console.log('NODE_G2_MISSIONS_ATOMIC_POINTS_ONCE=PASS');
console.log('NODE_G2_INCIDENT_HEATMAP_FORECAST_RBAC=PASS');
console.log('NODE_G2_MERCHANT_INVENTORY_RECIPE_WASTE_CROSS_TENANT=PASS');
console.log('NODE_G2_DRIVER_SCORE_AND_ADMIN_TRUST=PASS');
await sql.end();
