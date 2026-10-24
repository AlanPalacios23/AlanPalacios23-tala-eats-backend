/**
 * RC8.7 CASH DELIVERY — full customer/merchant/driver/ledger HTTP E2E.
 * Disposable PG15/Redis8 in GitHub Actions ONLY. No real charges/payouts.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import {Redis} from 'ioredis';
const u=process.env.DATABASE_URL??'';
const red=process.env.REDIS_URL??'';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.NODE_ENV!=='staging'||
   !u.includes('127.0.0.1:15435/tala_node_stage')||
   !red.includes('127.0.0.1:16379/0')||
   process.env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true'||
   process.env.STAGE_DRIVER_DELIVERY_ENABLED!=='true'||
   process.env.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true'||
   process.env.COMMERCIAL_PRICING_V162_ENABLED!=='true'||
   process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false')
  throw Error('RC87_CASH_DELIVERY_DISPOSABLE_CI_ONLY');
const base='http://127.0.0.1:18190/api/v1';
const db=new pg.Client({connectionString:u});
const redis=new Redis(red);
try{
 await db.connect();
 let cursor='0';
 do{
   const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
   if(keys.length)await redis.del(...keys);
   cursor=next;
 }while(cursor!=='0');
 for(let i=0,ready=false;i<60&&!ready;i++){
  try{
    const r=await fetch(base+'/ready');ready=r.status===200&&(await r.json()).ready===true;
  }catch{}
  if(ready)break;await new Promise(r=>setTimeout(r,200));
  if(i===59)throw Error('RC87_DELIVERY_API_NOT_READY');
 }
 const call=async(path,{token,method='GET',body}={})=>{
   const response=await fetch(base+path,{method,
     headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
      ...(token?{authorization:'Bearer '+token}:{})},
     ...(body===undefined?{}:{body:JSON.stringify(body)})});
   return {code:response.status,data:await response.json().catch(()=>null)};
 };
 const pwd='RC87-Disposable-Pass-2026!';
 const register=async name=>{
   const email='rc87.delivery.'+process.pid+'.'+name+'@example.test';
   const r=await call('/auth/register',{method:'POST',body:{name,email,password:pwd}});
   assert.equal(r.code,201,JSON.stringify(r.data));
   return {id:r.data.user.id,email,token:r.data.access_token};
 };
 const promote=async(a,role)=>{
   await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,a.id]);
   const login=await call('/auth/login',{method:'POST',body:{email:a.email,password:pwd}});
   assert.equal(login.code,200,JSON.stringify(login.data));
   a.token=login.data.access_token;
 };
 const customer=await register('buyer');
 const owner=await register('owner');
 const courier=await register('courier');
 const intruder=await register('intruder');
 await promote(owner,'restaurant');
 await promote(courier,'driver');
 const rest=(await db.query(
   "INSERT INTO restaurants(name,address,is_open,pickup_enabled,verification_status,commercial_plan,lat,lng,delivery_radius_km) VALUES('RC87 Delivery','Tala Jalisco',true,true,'verified','START',20.6501,-103.7105,7.0) RETURNING id"
 )).rows[0].id;
 await db.query('UPDATE restaurants SET owner_id=$1 WHERE id=$2',[owner.id,rest]);
 const item=(await db.query(
   "INSERT INTO menu_items(restaurant_id,name,price,stock,is_available) VALUES($1,'Platillo RC87',100.00,8,true) RETURNING id",
   [rest])).rows[0].id;
 const coords={delivery_lat:20.6701,delivery_lng:-103.7105};
 const rows=[{menu_item_id:item,quantity:1,options:''}];
 const methods=await call('/orders/payment-methods',{token:customer.token});
 assert.equal(methods.code,200);
 assert.equal(methods.data.delivery_checkout_supported,true);
 assert.equal(methods.data.delivery_cash_supported,true);
 assert.equal(methods.data.delivery_stripe_supported,false);
 // Unverified driver cannot go online.
 assert.equal((await call('/driver/availability',{method:'PATCH',
    token:courier.token,body:{is_online:true}})).code,403);
 await call('/driver/profile',{token:courier.token});
 await db.query('UPDATE driver_profiles SET is_verified=true WHERE user_id=$1',[courier.id]);
 assert.equal((await call('/driver/availability',{method:'PATCH',
    token:courier.token,body:{is_online:true}})).code,200);
 const quoteBody={restaurant_id:rest,order_type:'delivery',payment_method:'cash',
   ...coords,items:rows,tip:'5.00',coupon_code:''};
 const quote=await call('/orders/delivery-quote',{method:'POST',
   token:customer.token,body:quoteBody});
 assert.equal(quote.code,200,JSON.stringify(quote.data));
 assert.equal(quote.data.currency,'MXN');
 assert.equal(quote.data.quote_is_binding,false);
 assert.equal(quote.data.inventory_reserved,false);
 assert.equal(quote.data.shipping_is_road_routing,false);
 assert.ok(quote.data.distance_km>2&&quote.data.distance_km<3);
 assert.ok(Number(quote.data.delivery_fee)>35);
 assert.equal(quote.data.subtotal,'100.00');
 assert.equal(quote.data.service_fee,'7.00');
 assert.equal(Number(quote.data.total),
   100+Number(quote.data.delivery_fee)+7+5);
 assert.equal((await call('/orders/delivery-quote',{method:'POST',
   token:customer.token,body:{...quoteBody,delivery_lat:20.91}})).code,409);
 assert.equal((await call('/orders/delivery-quote',{method:'POST',
   token:customer.token,body:{...quoteBody,payment_method:'stripe'}})).code,422);
 const orderBody={...quoteBody,client_reference:'rc87-'+process.pid,
   address:'Calle de prueba, Tala',notes:''};
 const deniedCard=await call('/orders',{method:'POST',token:customer.token,
   body:{...orderBody,payment_method:'stripe'}});
 assert.equal(deniedCard.code,503,JSON.stringify(deniedCard.data));
 const submitted=await call('/orders',{method:'POST',token:customer.token,body:orderBody});
 assert.equal(submitted.code,201,JSON.stringify(submitted.data));
 const o=submitted.data;
 assert.equal(o.order_type,'delivery');
 assert.equal(o.payment_status,'pending');
 assert.equal(o.status,'received');
 assert.equal(Number(o.total),Number(quote.data.total));
 assert.equal(Number(o.delivery_fee),Number(quote.data.delivery_fee));
 assert.equal(o.delivery_lat,coords.delivery_lat);
 assert.equal(o.delivery_lng,coords.delivery_lng);
 const duplicate=await call('/orders',{method:'POST',token:customer.token,body:orderBody});
 assert.equal(duplicate.code,201);
 assert.equal(duplicate.data.id,o.id);
 const recovered=await call('/orders/by-reference/'+orderBody.client_reference,
   {token:customer.token});
 assert.equal(recovered.code,200);
 assert.equal(recovered.data.id,o.id);
 assert.equal((await db.query('SELECT stock FROM menu_items WHERE id=$1',
   [item])).rows[0].stock,7);
 assert.equal((await call('/orders/'+o.id,{token:intruder.token})).code,403);
 for(const status of ['confirmed','preparing','ready']){
   const r=await call('/owner/orders/'+o.id+'/status',{method:'PATCH',
     token:owner.token,body:{status}});
   assert.equal(r.code,200,JSON.stringify(r.data));
 }
 const dispatch=await call('/driver/dashboard',{token:courier.token});
 assert.equal(dispatch.code,200,JSON.stringify(dispatch.data));
 assert.equal(dispatch.data.active?.id,o.id,
   'Restaurant READY must auto-assign its cash delivery to verified online driver');
 assert.equal(dispatch.data.active?.status,'assigned');
 // A second claim must not assign the same order again.
 assert.equal((await call('/driver/orders/'+o.id+'/accept',{
   method:'POST',token:courier.token})).code,409);
 for(const status of ['picked_up','on_the_way']){
   const changed=await call('/driver/orders/'+o.id+'/status',{
     method:'PATCH',token:courier.token,body:{status}});
   assert.equal(changed.code,200,JSON.stringify(changed.data));
 }
 assert.equal((await call('/driver/orders/'+o.id+'/complete',{method:'POST',
   token:customer.token,body:{pin:o.delivery_pin}})).code,403);
 const wrong=o.delivery_pin==='0000'?'0001':'0000';
 assert.equal((await call('/driver/orders/'+o.id+'/complete',{method:'POST',
   token:courier.token,body:{pin:wrong}})).code,400);
 const proof=()=>call('/driver/orders/'+o.id+'/complete',{method:'POST',
   token:courier.token,body:{pin:o.delivery_pin}});
 const finals=await Promise.all([proof(),proof()]);
 assert.ok(finals.every(x=>x.code===200&&x.data.status==='delivered'),
  JSON.stringify(finals));
 const actual=(await db.query(
   'SELECT total::text,cash_collected::text,status,payment_status,driver_id FROM orders WHERE id=$1',[o.id])).rows[0];
 assert.equal(actual.status,'delivered');
 assert.equal(actual.payment_status,'paid');
 assert.equal(actual.cash_collected,actual.total);
 assert.equal(actual.driver_id,courier.id);
 const ledger=(await db.query(
   "SELECT account,direction,amount::text,kind FROM financial_ledger_entries WHERE order_id=$1 AND kind='cash_delivery_collection'",
   [o.id])).rows;
 assert.deepEqual(ledger,[{account:'cash_collected_by_driver',direction:'credit',
    amount:actual.total,kind:'cash_delivery_collection'}]);
 const delivered=(await db.query(
   "SELECT COUNT(*)::int AS n FROM order_events WHERE order_id=$1 AND status='delivered'",[o.id])).rows[0].n;
 assert.equal(delivered,1);
 assert.equal((await db.query('SELECT COUNT(*)::int n FROM delivery_proofs WHERE order_id=$1',
  [o.id])).rows[0].n,1);
 assert.equal((await call('/driver/orders/'+o.id+'/complete',{method:'POST',
    token:courier.token,body:{pin:wrong}})).code,409);
 console.log('RC87_CUSTOMER_DELIVERY_QUOTE_AND_ATOMIC_ORDER=PASS');
 console.log('RC87_GEO_RADIUS_DRIVER_AUTH_AND_INVENTORY=PASS');
 console.log('RC87_OWNER_TO_VERIFIED_DRIVER_TO_PIN=PASS');
 console.log('RC87_DELIVERY_CASH_EXACTLY_ONCE_LEDGER=PASS');
 console.log('LIVE_PAYMENT_AND_PAYOUT_WRITES=ZERO');
}finally{redis.disconnect();await db.end().catch(()=>{});}
