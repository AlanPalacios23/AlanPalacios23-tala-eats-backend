// Isolated PG15/Redis8 Phase B contract E2E. Synthetic identities only.
// No public network, production DB or PSP financial writes.
import assert from 'node:assert/strict';
import pg from 'pg';

const base='http://127.0.0.1:18190/api/v1';
const headers={'content-type':'application/json','x-talaeats-client':'customer-mobile'};
const password='Stage-Only-Pass-2026!';
async function call(path, opts={}) {
  const r=await fetch(base+path,opts);
  let body=null;try{body=await r.json()}catch{}
  return {status:r.status,body,headers:r.headers};
}
function opts(token,method='GET',body) {
  return {method,headers:{...headers,...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})};
}
async function ready() {
  for(let i=0;i<40;i++) {
    try{const r=await call('/ready');if(r.status===200&&r.body?.ready)return;}catch{}
    await new Promise(k=>setTimeout(k,300));
  }
  throw Error('API_NOT_READY');
}
await ready();
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
const name='market.'+process.pid+'.';
async function register(role) {
  const email=name+role+'@example.test';
  const r=await call('/auth/register',opts(null,'POST',{name:'Tala '+role,email,password}));
  assert.equal(r.status,201,JSON.stringify(r.body));
  if(role!=='customer') {
    const update=await client.query('UPDATE users SET role=$1 WHERE id=$2',[role,r.body.user.id]);
    assert.equal(update.rowCount,1);
    const login=await call('/auth/login',opts(null,'POST',{email,password}));
    assert.equal(login.status,200);
    return {id:r.body.user.id,token:login.body.access_token};
  }
  return {id:r.body.user.id,token:r.body.access_token};
}
const buyer=await register('customer');
const owner=await register('restaurant');
const otherOwner=await register('admin'); // RBAC admin without ownership.
const driver=await register('driver');

const inserted=await client.query(
  `INSERT INTO restaurants(name,description,cuisine,is_open,owner_id,address,market_code)
   VALUES ('Tala Taquería','Local','Mexicana',true,$1,'Centro de Tala','TALA-JAL')
   RETURNING id`,[owner.id]
);
const rid=inserted.rows[0].id;
const insertedOther=await client.query(
  `INSERT INTO restaurants(name,cuisine,is_open,owner_id,address,market_code)
   VALUES ('Ameca Cocina','Local',false,$1,'Centro de Ameca','AMECA-JAL')
   RETURNING id`,[otherOwner.id]
);
const otherId=insertedOther.rows[0].id;

const list=await call('/restaurants?limit=2&offset=0');
assert.equal(list.status,200);
assert.equal(list.body.length,2);
assert.equal(list.body[0].id,rid); // open sorts first
assert.equal(list.body[0].market_code,'TALA-JAL');
assert.equal(typeof list.body[0].delivery_fee,'string');
// Real Flutter Usuarios uses market_code + pagination; no mixing between
// Tala and Ameca, even with more than one page.
const talaOnly=await call('/restaurants?market_code=TALA-JAL&limit=1&offset=0');
assert.equal(talaOnly.status,200,JSON.stringify(talaOnly.body));
assert.equal(talaOnly.body.length,1);
assert.equal(talaOnly.body[0].id,rid);
const talaNext=await call('/restaurants?market_code=TALA-JAL&limit=1&offset=1');
assert.equal(talaNext.status,200);
assert.deepEqual(talaNext.body,[]);
const amecaOnly=await call('/restaurants?market_code=AMECA-JAL&limit=1&offset=0');
assert.equal(amecaOnly.status,200,JSON.stringify(amecaOnly.body));
assert.equal(amecaOnly.body.length,1);
assert.equal(amecaOnly.body[0].id,otherId);
const noMarket=await call('/restaurants?market_code=CUISILLOS-JAL');
assert.equal(noMarket.status,200);
assert.deepEqual(noMarket.body,[]);
assert.equal((await call('/restaurants?market_code=../AMECA-JAL')).status,422);
assert.equal((await call('/restaurants?market_code[]=AMECA-JAL')).status,422);
assert.equal((await call('/restaurants?limit=201')).status,422);
assert.equal((await call('/restaurants/999999')).status,404);
const anonProfile=await call('/owner/restaurant');
assert.equal(anonProfile.status,401);
assert.equal((await call('/owner/restaurant',opts(buyer.token))).status,403);

const create=await call('/owner/menu',opts(owner.token,'POST',{
  name:'Taco de asada',price:'28.50',stock:8,category:'Tacos',
  description:'Tortilla de maíz',is_available:true,
}));
assert.equal(create.status,201,JSON.stringify(create.body));
const mid=create.body.id;
assert.equal(typeof create.body.price,'string');
assert.equal(Number(create.body.price),28.5);
assert.equal(create.body.restaurant_id,rid);
assert.equal((await call('/owner/menu',opts(owner.token,'POST',{name:'A',price:'0.00'}))).status,422);
assert.equal((await call('/owner/menu/'+mid,opts(buyer.token,'PATCH',{stock:0}))).status,403);
const updated=await call('/owner/menu/'+mid,opts(owner.token,'PATCH',{stock:0,is_available:false}));
assert.equal(updated.status,200);
assert.equal(updated.body.stock,0);
assert.equal(updated.body.is_available,false);
assert.equal(Number(updated.body.price),28.5); // PATCH never resets price.
const detail=await call('/restaurants/'+rid);
assert.equal(detail.status,200);
assert.equal(detail.body.menu_items.length,1);
assert.equal(detail.body.menu_items[0].stock,0);
assert.equal((await call('/owner/restaurant',opts(owner.token))).status,200);

const wrongCoords=await call('/owner/restaurant',opts(owner.token,'PATCH',{lat:20.65}));
assert.equal(wrongCoords.status,422);
const changed=await call('/owner/restaurant',opts(owner.token,'PATCH',{
  address:'Calle Hidalgo 12, Tala',lat:20.6501,lng:-103.7001
}));
assert.equal(changed.status,200,JSON.stringify(changed.body));
assert.equal(changed.body.address,'Calle Hidalgo 12, Tala');
assert.equal(changed.body.lng,-103.7001);
const profile=await call('/driver/profile',opts(driver.token));
assert.equal(profile.status,200,JSON.stringify(profile.body));
assert.equal(profile.body.is_online,false);
assert.equal(profile.body.rating,'5');
assert.equal((await call('/driver/profile',opts(owner.token))).status,403);
assert.equal((await call('/driver/availability',opts(driver.token,'PATCH',{is_online:true}))).status,503);
assert.equal((await call('/driver/location',opts(driver.token,'PATCH',{lat:20,lng:-103}))).status,503);

const order=await client.query(
 `INSERT INTO orders(user_id,restaurant_id,driver_id,address,subtotal,total,
   delivery_pin,client_reference,payment_method,payment_status,status)
  VALUES($1,$2,$3,'Domicilio de prueba',28.50,28.50,'1234','test-ref-789',
    'cash','pending','assigned') RETURNING id`,[buyer.id,rid,driver.id]);
const oid=order.rows[0].id;
await client.query(
  `INSERT INTO order_items(order_id,menu_item_id,name_snapshot,quantity,unit_price)
   VALUES ($1,$2,'Taco de asada',1,28.50)`,[oid,mid]);
const duplicateRef=await client.query(
 `INSERT INTO orders(user_id,restaurant_id,address,client_reference)
 VALUES ($1,$2,'Otro pedido','test-ref-789') RETURNING id`,[otherOwner.id,otherId]);
assert.ok(duplicateRef.rows[0].id!==oid);
await assert.rejects(
  client.query(`INSERT INTO orders(user_id,restaurant_id,address,client_reference)
  VALUES($1,$2,'Duplicado','test-ref-789')`,[buyer.id,rid]),
  /duplicate key value violates unique constraint/
);
const recovered=await call('/orders/by-reference/test-ref-789',opts(buyer.token));
assert.equal(recovered.status,200,JSON.stringify(recovered.body));
assert.equal(recovered.body.id,oid);
assert.equal(recovered.body.delivery_pin,'1234');
assert.equal(recovered.body.items.length,1);
assert.equal(recovered.headers.get('cache-control'),'private, no-store');
assert.equal((await call('/orders/by-reference/test-ref-789',opts(driver.token))).status,404);
assert.equal((await call('/orders/by-reference/invalid!ref',opts(buyer.token))).status,422);
const mine=await call('/orders/mine',opts(buyer.token));
assert.equal(mine.status,200);
assert.equal(mine.body.length,1);
const forbidden=await call('/orders/'+oid,opts(otherOwner.token));
assert.equal(forbidden.status,200); // Python permits ADMIN details.
assert.equal(Object.hasOwn(forbidden.body,'delivery_pin'),false);
const customerDetail=await call('/orders/'+oid,opts(buyer.token));
assert.equal(customerDetail.body.delivery_pin,'1234');
const ownerOrders=await call('/owner/orders',opts(owner.token));
assert.equal(ownerOrders.status,200);
assert.equal(ownerOrders.body.length,1);
assert.equal(Object.hasOwn(ownerOrders.body[0],'delivery_pin'),false);
const driverMine=await call('/driver/mine',opts(driver.token));
assert.equal(driverMine.status,200);
assert.equal(driverMine.body.length,1);
assert.equal(Object.hasOwn(driverMine.body[0],'delivery_pin'),false);
const cart=await call('/orders/'+oid+'/reorder',opts(buyer.token,'POST'));
assert.equal(cart.status,200);
assert.deepEqual(cart.body,{restaurant_id:rid,items:[{menu_item_id:mid,quantity:1}]});
assert.equal((await call('/orders/'+oid+'/reorder',opts(owner.token,'POST'))).status,403);
const kds=await call('/owner/kds',opts(owner.token));
assert.equal(kds.status,200,JSON.stringify(kds.body));
assert.equal(kds.body.assigned?.length,1);
assert.equal(Object.hasOwn(kds.body.assigned[0],'delivery_pin'),false);
assert.equal((await call('/owner/kds',opts(buyer.token))).status,403);
const driverAvailable=await call('/driver/available',opts(driver.token));
assert.equal(driverAvailable.status,200);
assert.deepEqual(driverAvailable.body,[]); // Driver is offline and has active work.
assert.equal((await call('/driver/available',opts(buyer.token))).status,403);
const checkout=await call('/orders',opts(buyer.token,'POST',{
 restaurant_id:rid,items:[{menu_item_id:mid,quantity:1}],address:'Centro'
}));
assert.equal(checkout.status,503);
const afterCheckout=await client.query('SELECT COUNT(*)::int n FROM orders WHERE user_id=$1',[buyer.id]);
assert.equal(afterCheckout.rows[0].n,1); // No order/financial writes from Node API.
const deleted=await call('/owner/menu/'+mid,opts(owner.token,'DELETE'));
assert.equal(deleted.status,409); // Historical order item snapshot integrity.
await client.end();
console.log('NODE_MARKETPLACE_PUBLIC_CATALOG_AND_MENU_OWNER_RBAC=PASS');
console.log('NODE_ORDER_REFERENCE_USER_ISOLATION_PIN_SCOPE=PASS');
console.log('NODE_DRIVER_READ_MODEL_AND_PROTECTED_AVAILABILITY=PASS');
console.log('NODE_FINANCIAL_WRITES_NO_GO=PASS');
