// E2E on ephemeral GitHub PG15/Redis8 ONLY. This file must NEVER run on Kali.
// Test cash/pickup stage opt-in, inventory locks, ingredient reservations,
// per-customer idempotency, replay mismatch, immutable ledger and durable outbox.
import assert from 'node:assert/strict';
import pg from 'pg';
const base='http://127.0.0.1:18190/api/v1';
const headers={'content-type':'application/json','x-talaeats-client':'customer-mobile'};
const password='Cash-Pickup-CI-Only-2026!';
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
const call=async(path,{method='GET',token=null,body}={})=>{
  const response=await fetch(base+path,{
    method,headers:{...headers,...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  let json;try{json=await response.json()}catch{json=null}
  return {status:response.status,json};
};
async function ready(){
  for(let i=0;i<40;i++){
    try{const r=await call('/ready');if(r.status===200&&r.json?.ready)return;}catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  throw Error('API_NOT_READY');
}
await ready();
await client.connect();
const prefix='cash.'+process.pid+'.';
async function createCustomer(label) {
  const email=prefix+label+'@example.test';
  const response=await call('/auth/register',{method:'POST',
    body:{name:'Checkout '+label,email,password}});
  assert.equal(response.status,201,JSON.stringify(response.json));
  return {id:response.json.user.id,token:response.json.access_token,email};
}
const a=await createCustomer('a');
const b=await createCustomer('b');
const c=await createCustomer('c');
const merchant=await createCustomer('merchant');
await client.query("UPDATE users SET role='restaurant' WHERE id=$1",[merchant.id]);
const fresh=await call('/auth/login',{method:'POST',body:{email:merchant.email,password}});
assert.equal(fresh.status,200);
merchant.token=fresh.json.access_token;
const rest=await client.query(
  "INSERT INTO restaurants(name,is_open,pickup_enabled,owner_id,address) VALUES('Taqueria CI',true,true,$1,'Centro Tala') RETURNING id",
  [merchant.id]);
const rid=rest.rows[0].id;
const menu=await client.query(
  "INSERT INTO menu_items(restaurant_id,name,price,stock,is_available) VALUES($1,'Taco 500g',25.50,2,true) RETURNING id",
  [rid]);
const mid=menu.rows[0].id;
const ingredient=await client.query(
  "INSERT INTO ingredient_stocks(restaurant_id,name,quantity,unit) VALUES($1,'Carne',4.000,'kg') RETURNING id",
  [rid]);
const iid=ingredient.rows[0].id;
await client.query(
  "INSERT INTO menu_recipes(menu_item_id,ingredient_id,quantity_required) VALUES($1,$2,2.000)",
  [mid,iid]);
const payload=(ref,notes='')=>({
  restaurant_id:rid,address:'Recoger en mostrador',
  items:[{menu_item_id:mid,quantity:1}],notes,
  payment_method:'cash',order_type:'pickup',client_reference:ref,tip:'1.00',
});
async function create(customer,p){
  return call('/orders',{method:'POST',token:customer.token,body:p});
}
// Match the Flutter Usuarios checkout payload exactly.
const mobilePayload=ref=>({
  ...payload(ref),
  items:[{menu_item_id:mid,quantity:1,options:''}],
  coupon_code:'',delivery_lat:null,delivery_lng:null,
});
const blockedCard=await call('/orders',{method:'POST',token:a.token,
  body:{...payload('card-blocked'),payment_method:'stripe'}});
assert.equal(blockedCard.status,503);
const blockedDelivery=await call('/orders',{method:'POST',token:a.token,
  body:{...payload('delivery-blocked'),order_type:'delivery'}});
assert.equal(blockedDelivery.status,503);
const blockedDiscount=await create(a,{...mobilePayload('coupon-blocked'),coupon_code:'WELCOME10'});
assert.equal(blockedDiscount.status,503);
const blockedCoordinates=await create(a,{...mobilePayload('coords-blocked'),delivery_lat:20.6534});
assert.equal(blockedCoordinates.status,503);
const blockedOwner=await create(merchant,payload('merchant-blocked'));
assert.equal(blockedOwner.status,403);
const first=await create(a,mobilePayload('checkout-uniq'));
assert.equal(first.status,201,JSON.stringify(first.json));
const orderId=first.json.id;
assert.equal(first.json.status,'received');
assert.equal(first.json.payment_method,'cash');
assert.equal(first.json.payment_status,'pending');
assert.equal(first.json.order_type,'pickup');
assert.equal(Number(first.json.subtotal),25.50);
assert.equal(Number(first.json.platform_commission),3.83);
assert.equal(Number(first.json.service_fee),1.79);
assert.equal(Number(first.json.restaurant_payout),22.67);
assert.equal(Number(first.json.platform_revenue),5.62);
assert.equal(Number(first.json.total),28.29);
assert.equal(Number(first.json.items[0].unit_price),25.50);
assert.match(first.json.delivery_pin,/^\d{4}$/);
const retryResults=await Promise.all(Array.from({length:4},
  ()=>create(a,payload('checkout-uniq'))));
assert.ok(retryResults.every(x=>x.status===201 && x.json.id===orderId),
  JSON.stringify(retryResults.map(x=>[x.status,x.json?.id])));
const mobileRetry=await create(a,mobilePayload('checkout-uniq'));
assert.equal(mobileRetry.status,201);
assert.equal(mobileRetry.json.id,orderId);
const changed=await create(a,payload('checkout-uniq','otro producto/nota'));
assert.equal(changed.status,409);
const badRef=await create(a,{...payload('checkout-uniq'),tip:'2.00'});
assert.equal(badRef.status,409);
const existingStock=await client.query('SELECT stock FROM menu_items WHERE id=$1',[mid]);
assert.equal(existingStock.rows[0].stock,1);
const existingIngredient=await client.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',[iid]);
assert.equal(existingIngredient.rows[0].quantity,'2.000');
// The two remaining customers contend for the same last product and recipe
// ingredient; conditional SQL updates guarantee exactly one can commit.
const race=await Promise.all([
  create(b,payload('last-b')),
  create(c,payload('last-c')),
]);
assert.deepEqual(race.map(x=>x.status).sort(),[201,400],JSON.stringify(race));
const finalStock=await client.query('SELECT stock FROM menu_items WHERE id=$1',[mid]);
assert.equal(finalStock.rows[0].stock,0);
const finalIngredient=await client.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',[iid]);
assert.equal(finalIngredient.rows[0].quantity,'0.000');
const orderRows=await client.query('SELECT id,user_id,client_reference,inventory_reserved_json FROM orders WHERE restaurant_id=$1',[rid]);
assert.equal(orderRows.rowCount,2);
for(const row of orderRows.rows){
  const reserved=JSON.parse(row.inventory_reserved_json);
  assert.equal(reserved[String(iid)],'2.000');
  const ledger=await client.query(
    'SELECT account,amount FROM financial_ledger_entries WHERE order_id=$1 ORDER BY id',[row.id]);
  assert.deepEqual(ledger.rows.map(x=>x.account).sort(),
    ['contribution_margin','gmv','platform_revenue','restaurant_payable'].sort());
  const outbox=await client.query('SELECT status,event_type FROM event_outbox WHERE event_key=$1',
    ['order:'+row.id+':created']);
  assert.equal(outbox.rowCount,1);
  assert.equal(outbox.rows[0].status,'pending');
  assert.equal(outbox.rows[0].event_type,'order.created');
  const event=await client.query("SELECT metadata_json FROM order_events WHERE order_id=$1 AND status='received'",[row.id]);
  assert.equal(event.rowCount,1);
  assert.match(JSON.parse(event.rows[0].metadata_json).checkout_intent_hmac,/^[a-f0-9]{64}$/);
}
const ledger=await client.query('SELECT id FROM financial_ledger_entries WHERE order_id=$1 LIMIT 1',[orderId]);
await assert.rejects(
  client.query("UPDATE financial_ledger_entries SET amount=0 WHERE id=$1",[ledger.rows[0].id]),
  /STAGE_IMMUTABLE_LEDGER/
);
await assert.rejects(
  client.query("DELETE FROM financial_ledger_entries WHERE id=$1",[ledger.rows[0].id]),
  /STAGE_IMMUTABLE_LEDGER/
);
const last=await create(a,payload('different-ref-stockout'));
assert.equal(last.status,400);
const noPartial=await client.query('SELECT count(*)::int n FROM orders WHERE restaurant_id=$1',[rid]);
assert.equal(noPartial.rows[0].n,2);
const ownerOrders=await call('/owner/orders',{token:merchant.token});
assert.equal(ownerOrders.status,200);
assert.equal(ownerOrders.json.length,2);
assert.equal(ownerOrders.json.some(x=>Object.hasOwn(x,'delivery_pin')),false);
const recovered=await call('/orders/by-reference/checkout-uniq',{token:a.token});
assert.equal(recovered.status,200);
assert.equal(recovered.json.id,orderId);
assert.equal((await call('/orders/by-reference/checkout-uniq',{token:b.token})).status,404);
console.log('STAGE_PICKUP_CASH_ATOMIC_STOCK_RECIPE_RACE=PASS');
console.log('STAGE_ORDER_REFERENCE_HMAC_REPLAY_FINGERPRINT=PASS');
console.log('STAGE_IMMUTABLE_LEDGER_OUTBOX_TRANSACTION=PASS');
console.log('REAL_PSP_AND_KALI_PRODUCTION_NOT_TOUCHED=TRUE');
await client.end();
