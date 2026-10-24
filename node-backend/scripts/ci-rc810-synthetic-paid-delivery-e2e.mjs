/**
 * RC8.10: synthetic signed-receipt BOUNDARY test, not a real Stripe charge.
 * Only GitHub Actions disposable Postgres/Redis. We impersonate the *database
 * output* of a previously verified Stripe webhook: no HTTP endpoint can do so.
 * Testing provider signatures is separate from this delivery-state E2E.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import Redis from 'ioredis';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.NODE_ENV!=='staging'||
   !process.env.DATABASE_URL?.includes('127.0.0.1:15435/tala_node_stage')||
   !process.env.REDIS_URL?.includes('127.0.0.1:16379/0')||
   process.env.STAGE_DELIVERY_STRIPE_TEST_ENABLED!=='true'||
   process.env.STAGE_DELIVERY_CASH_CHECKOUT_ENABLED!=='true'||
   !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')||
   process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false')
 throw Error('RC810_DISPOSABLE_TEST_ONLY_NO_LIVE_PSP');
const base='http://127.0.0.1:18190/api/v1';
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const redis=new Redis(process.env.REDIS_URL);
try{
 await db.connect();
 for(let i=0;i<60;i++){
   try{const r=await fetch(base+'/ready');if(r.status===200&&(await r.json()).ready)break;}catch{}
   if(i===59)throw Error('API_NOT_READY');
   await new Promise(resolve=>setTimeout(resolve,250));
 }
 const call=async(path,{token,method='GET',body}={})=>{
   const r=await fetch(base+path,{method,headers:{
      'content-type':'application/json',
      ...(token?{authorization:'Bearer '+token}:{})},
     ...(body===undefined?{}:{body:JSON.stringify(body)})});
   return {code:r.status,data:await r.json().catch(()=>null)};
 };
 const pwd='RC810-Isolated-Test-2026!';
 const register=async name=>{
   const email='rc810.'+process.pid+'.'+name+'@example.test';
   const r=await call('/auth/register',{method:'POST',
      body:{name,email,password:pwd}});
   assert.equal(r.code,201,JSON.stringify(r.data));
   return {id:r.data.user.id,email,token:r.data.access_token};
 };
 const promote=async(actor,role)=>{
   await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,actor.id]);
   const r=await call('/auth/login',{method:'POST',
     body:{email:actor.email,password:pwd}});
   assert.equal(r.code,200,JSON.stringify(r.data));
   actor.token=r.data.access_token;
 };
 const buyer=await register('buyer'),seller=await register('merchant');
 const driver=await register('courier');
 await promote(seller,'restaurant');
 await promote(driver,'driver');
 const rest=(await db.query(
   "INSERT INTO restaurants(name,address,is_open,pickup_enabled,verification_status,commercial_plan,lat,lng,delivery_radius_km) VALUES('RC810 Synthetic Paid','Tala Jalisco',true,true,'verified','START',20.6501,-103.7105,8.0) RETURNING id"
 )).rows[0].id;
 await db.query('UPDATE restaurants SET owner_id=$1 WHERE id=$2',[seller.id,rest]);
 const item=(await db.query(
   "INSERT INTO menu_items(restaurant_id,name,price,stock,is_available) VALUES($1,'Platillo TEST',100.00,9,true) RETURNING id",[rest])).rows[0].id;
 await call('/driver/profile',{token:driver.token});
 await db.query('UPDATE driver_profiles SET is_verified=true WHERE user_id=$1',[driver.id]);
 assert.equal((await call('/driver/availability',{method:'PATCH',
    token:driver.token,body:{is_online:true}})).code,200);
 assert.equal((await call('/driver/location',{method:'PATCH',
    token:driver.token,body:{lat:20.6502,lng:-103.7104}})).code,200);
 const methods=await call('/orders/payment-methods',{token:buyer.token});
 assert.equal(methods.data.delivery_stripe_supported,true);
 const quoteBody={restaurant_id:rest,order_type:'delivery',
   payment_method:'stripe',delivery_lat:20.6701,delivery_lng:-103.7105,
   items:[{menu_item_id:item,quantity:1,options:''}],coupon_code:'',tip:'5.00'};
 const quote=await call('/orders/delivery-quote',{
    method:'POST',token:buyer.token,body:quoteBody});
 assert.equal(quote.code,200,JSON.stringify(quote.data));
 assert.equal(quote.data.payment_method,'stripe');
 assert.ok(Number(quote.data.total)>120);
 const order=await call('/orders',{method:'POST',token:buyer.token,
   body:{...quoteBody,address:'Calle de prueba, Tala',notes:'',
     client_reference:'rc810-test-'+process.pid}});
 assert.equal(order.code,201,JSON.stringify(order.data));
 let id=order.data.id;
 let finalOrder=order.data;
 assert.equal(order.data.status,'awaiting_payment');
 assert.equal(order.data.payment_status,'pending');
 assert.equal(order.data.total,quote.data.total);
 // No merchant order visible nor actionable BEFORE webhook/receipt.
 const ownerList=await call('/owner/orders',{token:seller.token});
 assert.equal(ownerList.code,200);
 assert.ok(!ownerList.data.some(x=>x.id===id),
   'unpaid order must be hidden from merchant processing');
 assert.equal((await call('/owner/orders/'+id+'/status',{
    method:'PATCH',token:seller.token,body:{status:'confirmed'}})).code,503);
 assert.equal((await call('/driver/orders/'+id+'/accept',{
    method:'POST',token:driver.token})).code,409);
 assert.equal((await call('/payments/stripe/orders/'+id+'/status',{
    token:buyer.token})).data.confirmed_by_server,false);
 // Simulated provider callback state: untrusted 'paid' alone is denied.
 // NEVER expose a route to force this state. Only in disposable CI database.
 await db.query("UPDATE orders SET payment_status='paid',status='received' WHERE id=$1",[id]);
 const confirm=()=>call('/owner/orders/'+id+'/status',{
    method:'PATCH',token:seller.token,body:{status:'confirmed'}});
 assert.equal((await confirm()).code,503);
 const amountCents=Number(quote.data.total.replace('.',''));
 const wrong=((amountCents-1)/100).toFixed(2);
 await db.query(
   "INSERT INTO financial_ledger_entries (order_id,user_id,restaurant_id,account,direction,amount,kind,description,idempotency_key) VALUES($1,$2,$3,'stripe_test_collected','credit',$4,'stripe_test_payment','Synthetic wrong amount',$5)",
   [id,buyer.id,rest,wrong,'order:'+id+':stripe-test:collected']);
 assert.equal((await confirm()).code,503);
 const statusMismatch=await call('/payments/stripe/orders/'+id+'/status',{
    token:buyer.token});
 assert.equal(statusMismatch.data.confirmed_by_server,false);
 const rejectedOwner=await call('/owner/orders',{token:seller.token});
 assert.equal(rejectedOwner.code,200);
 assert.ok(!rejectedOwner.data.some(x=>x.id===id),
   'no forged paid flag/wrong settlement in merchant orders');
 const deniedKds=await call('/owner/kds',{token:seller.token});
 assert.equal(deniedKds.code,200);
 assert.ok(!Object.values(deniedKds.data).some(rows=>
   Array.isArray(rows)&&rows.some(x=>x.id===id)),
   'no forged receipt in kitchen board');
 // NEVER mutate the immutable ledger. The wrong-amount order stays HELD.
 // Create a SECOND order, as if a verified signed webhook had atomically
 // posted its own exact receipt after capture.
 const paid=await call('/orders',{method:'POST',token:buyer.token,
   body:{...quoteBody,address:'Calle de prueba, Tala',notes:'',
     client_reference:'rc810-verified-'+process.pid}});
 assert.equal(paid.code,201,JSON.stringify(paid.data));
 id=paid.data.id;
 finalOrder=paid.data;
 assert.equal(paid.data.status,'awaiting_payment');
 await db.query("UPDATE orders SET payment_status='paid',status='received' WHERE id=$1",[id]);
 await db.query(
   "INSERT INTO financial_ledger_entries (order_id,user_id,restaurant_id,account,direction,amount,kind,description,idempotency_key) VALUES($1,$2,$3,'stripe_test_collected','credit',$4,'stripe_test_payment','Synthetic exact amount',$5)",
   [id,buyer.id,rest,quote.data.total,'order:'+id+':stripe-test:collected']);
 const trusted=await call('/payments/stripe/orders/'+id+'/status',{
   token:buyer.token});
 assert.equal(trusted.data.confirmed_by_server,true);
 // Actual Stripe signed webhook path tested elsewhere. This is an isolated
 // state-machine safety test starting only after the correct immutable receipt.
 for(const next of ['confirmed','preparing','ready']){
   const moved=next==='confirmed'?await confirm():
      await call('/owner/orders/'+id+'/status',{method:'PATCH',
        token:seller.token,body:{status:next}});
   assert.equal(moved.code,200,JSON.stringify(moved.data));
 }
 const panel=await call('/driver/dashboard',{token:driver.token});
 assert.equal(panel.code,200,JSON.stringify(panel.data));
 assert.equal(panel.data.active?.id,id);
 assert.equal(panel.data.active?.status,'assigned');
 assert.equal(panel.data.active?.payment_method,'stripe');
 assert.equal(panel.data.active?.payment_status,'paid');
 for(const next of ['picked_up','on_the_way']){
   const moved=await call('/driver/orders/'+id+'/status',{
      method:'PATCH',token:driver.token,body:{status:next}});
   assert.equal(moved.code,200,JSON.stringify(moved.data));
 }
 const wrongPin=finalOrder.delivery_pin==='0000'?'0001':'0000';
 assert.equal((await call('/driver/orders/'+id+'/complete',{method:'POST',
    token:driver.token,body:{pin:wrongPin}})).code,400);
 const prove=()=>call('/driver/orders/'+id+'/complete',{
   method:'POST',token:driver.token,body:{pin:finalOrder.delivery_pin}});
 const done=await Promise.all([prove(),prove()]);
 assert.ok(done.every(v=>v.code===200&&v.data.status==='delivered'),
   JSON.stringify(done));
 const final=(await db.query(
   'SELECT status,payment_status,cash_collected::text FROM orders WHERE id=$1',
   [id])).rows[0];
 assert.equal(final.status,'delivered');
 assert.equal(final.payment_status,'paid');
 assert.equal(Number(final.cash_collected),0);
 const cash=(await db.query(
   "SELECT COUNT(*)::int AS n FROM financial_ledger_entries WHERE order_id=$1 AND kind='cash_delivery_collection'",[id])).rows[0].n;
 assert.equal(cash,0);
 const proof=(await db.query(
   'SELECT COUNT(*)::int AS n FROM delivery_proofs WHERE order_id=$1',[id])).rows[0].n;
 assert.equal(proof,1);
 const delivered=(await db.query(
   "SELECT COUNT(*)::int AS n FROM order_events WHERE order_id=$1 AND status='delivered'",
   [id])).rows[0].n;
 assert.equal(delivered,1);
 console.log('RC810_UNPAID_CARD_DELIVERY_MERCHANT_DENIED=PASS');
 console.log('RC810_FALSE_PAID_OR_WRONG_LEDGER_DENIED=PASS');
 console.log('RC810_SIMULATED_TEST_RECEIPT_READY_TO_DRIVER=PASS');
 console.log('RC810_CARD_DELIVERY_PIN_WITH_ZERO_CASH=PASS');
 console.log('LIVE_PAYMENT_AND_PAYOUT_WRITES=ZERO');
}finally{
 redis.disconnect();
 await db.end().catch(()=>{});
}
