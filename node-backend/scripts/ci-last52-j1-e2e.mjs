// J1: 52 Python route contracts. All writes here target disposable PG15/Redis8.
// Some financial routes intentionally fail closed (503), NOT functionally done.
import assert from 'node:assert/strict';
import pgLib from 'pg';
import {Redis} from 'ioredis';
const url=String(process.env.DATABASE_URL??''),rurl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!url.includes('127.0.0.1:15435/tala_node_stage')||
 !rurl.includes('127.0.0.1:16379/0'))throw Error('J1_CI_ONLY');
const red=new Redis(rurl);let c='0';do{const [n,k]=await red.scan(c,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);if(k.length)await red.del(...k);c=n;}while(c!=='0');red.disconnect();
const db=new pgLib.Client({connectionString:url});await db.connect();
const secret='J1-Disposable-Only-2026!';
async function request(path,{token,method='GET',body,headers={},binary}={}){
 const isFile=binary instanceof FormData;
 const res=await fetch('http://127.0.0.1:18190'+(path.startsWith('/api/v1/')?path:'/api/v1'+path),{
  method,headers:{'x-talaeats-client':'customer-mobile',
   ...(token?{authorization:'Bearer '+token}:{}),
   ...(isFile?{}:{'content-type':'application/json'}),...headers},
  ...(binary?{body:binary}:body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;
 if(!(res.headers.get('content-type')??'').startsWith('image/')&&
 !(res.headers.get('content-type')??'').startsWith('application/pdf')){
  try{json=await res.json()}catch{}
 }
 return {status:res.status,json,res,cache:res.headers.get('cache-control')};
}
async function user(tag){
 const email='j1.'+process.pid+'.'+tag+'@example.test';
 const x=await request('/auth/register',{method:'POST',
  body:{email,name:'J1 '+tag,password:secret}});
 assert.equal(x.status,201,JSON.stringify(x.json));
 return {id:x.json.user.id,email,token:x.json.access_token};
}
async function promote(x,role){
 await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,x.id]);
 const r=await request('/auth/login',{method:'POST',
  body:{email:x.email,password:secret}});
 assert.equal(r.status,200);x.token=r.json.access_token;
}
const admin=await user('admin'),customer=await user('customer'),
 outsider=await user('outsider'),merchant=await user('merchant'),
 driver=await user('driver'),driverTwo=await user('driver2');
await promote(admin,'admin');await promote(merchant,'restaurant');
await promote(driver,'driver');await promote(driverTwo,'driver');
const go=(x,p,method='GET',body)=>request(p,{token:x?.token,method,body});
const shop=(await db.query(
 "INSERT INTO restaurants(name,address,owner_id,lat,lng)"+
 " VALUES('J1 Store','Centro Tala',$1,20.6534,-103.704) RETURNING id",
 [merchant.id])).rows[0].id;
const item=(await db.query(
 "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,'Tacos J1',39.00,20) RETURNING id",
 [shop])).rows[0].id;
const order=(await db.query(
 "INSERT INTO orders(user_id,restaurant_id,order_type,payment_method,status,total,address)"+
 " VALUES($1,$2,'delivery','cash','ready',39.00,'Tala') RETURNING id",
 [customer.id,shop])).rows[0].id;
// All public configuration responses tell the truth about disabled PSP.
assert.equal((await go(null,'/platform/features')).status,200);
const methods=await go(customer,'/orders/payment-methods');
assert.equal(methods.status,200);
assert.equal(methods.json.production_ready,false);
assert.equal(methods.json.methods.find(x=>x.id==='stripe').enabled,false);
assert.equal(methods.json.digital_provider,'stripe');
assert.equal(methods.json.methods.some(x=>x.id==='mercadopago'),false);
assert.equal((await go(null,'/orders/payment-methods')).status,401);
assert.equal((await go(null,'/payments/config')).json.enabled,false);
assert.equal((await go(null,'/payments/config')).json.provider,'stripe');
assert.equal((await go(null,'/payments/stripe/config')).json.enabled,false);
assert.equal((await go(customer,'/operations/admin/commercial-pricing')).status,403);
const pricing=await go(admin,'/operations/admin/commercial-pricing');
assert.equal(pricing.status,200);assert.equal(pricing.json.enabled,false);
assert.equal((await go(merchant,'/operations/admin/restaurants/'+shop+'/commercial',
 'PATCH',{commission_rate:0.17})).status,403);
const commercial=await go(admin,'/operations/admin/restaurants/'+shop+'/commercial',
 'PATCH',{commission_rate:0.17});
assert.equal(commercial.status,200);
assert.equal(commercial.json.commission_rate,'0.1700');
const sla=await go(admin,'/operations/admin/sla');
assert.equal(sla.status,200);
assert.ok(Object.hasOwn(sla.json,'avg_delivery_minutes'));
// Withdrawal safe views, own recipient only, zero verified available.
assert.equal((await go(customer,'/withdrawals/driver/'+driver.id+'/balance')).status,403);
const balance=await go(driver,'/withdrawals/driver/'+driver.id+'/balance');
assert.equal(balance.status,200);
assert.equal(balance.json.eligible,false);assert.equal(balance.json.available_for_withdrawal,'0.00');
assert.equal((await go(driver,'/withdrawals/driver/'+driverTwo.id+'/balance')).status,403);
assert.equal((await go(merchant,'/withdrawals/restaurant/'+shop+'/history')).status,200);
assert.equal((await go(merchant,'/withdrawals/restaurant/'+shop+'/connect/status')).json.connected,false);
assert.equal((await go(null,'/withdrawals/connect/finish')).status,403);
const referrer=await db.query('SELECT referral_code FROM loyalty_accounts WHERE user_id=$1',[outsider.id]);
const code=referrer.rows[0].referral_code;
assert.equal((await go(customer,'/operations/referrals/apply?code='+code,'POST')).json.status,'pending');
assert.equal((await go(customer,'/operations/referrals/apply?code='+code,'POST')).status,409);
assert.equal((await db.query('SELECT status FROM referral_conversions WHERE referred_user_id=$1',
 [customer.id])).rows[0].status,'pending');
// Missing payment providers MUST fail with 503, no false ack/transition.
const ledgerBefore=(await db.query('SELECT count(*)::int n FROM financial_ledger_entries')).rows[0].n;
const noMoney=[
 ['/payments/stripe/orders/'+order+'/payment-intent','POST',customer],
 ['/payments/stripe/admin/orders/'+order+'/refund','POST',admin],
 ['/payments/stripe/admin/orders/'+order+'/settle','POST',admin],
 ['/payments/stripe/admin/recipients/driver/'+driver.id,'PUT',admin],
 ['/withdrawals/driver/'+driver.id+'/request','POST',driver],
 ['/withdrawals/driver/'+driver.id+'/connect/onboarding','POST',driver],
 ['/operations/admin/payouts/run','POST',admin],
 ['/operations/admin/payouts/999999/mark-paid','POST',admin],
 ['/operations/admin/cash-settlements/run','POST',admin],
 ['/operations/admin/cash-settlements/999999','PATCH',admin],
 ['/operations/plus/subscribe','POST',customer],
 ['/platform/plus/subscribe','POST',customer],
 ['/platform/rewards/redeem','POST',customer],
 ['/platform/gift-cards/redeem','POST',customer],
 ['/admin/wallet/'+customer.id+'/adjust','POST',admin],
 ['/v11/admin/orders/'+order+'/partial-refund','POST',admin],
 ['/v11/admin/payouts/dispatch','POST',admin],
 ['/v9/admin/corporate/1/settle','POST',admin],
 ['/resilience/payments/reconcile','POST',admin],
 ['/resilience/outbox/drain','POST',admin],
];
for(const [p,method,who] of noMoney){
 const v=await go(who,p,method);
 assert.equal(v.status,503,p+' -> '+JSON.stringify(v.json));
}
assert.equal((await go(null,'/payments/stripe/webhook','POST')).status,503);
for (const retired of ['/payments/mercadopago/webhook',
 '/payments/mercadopago/orders/'+order+'/checkout',
 '/payments/mercadopago/orders/'+order+'/refund']) {
  assert.equal((await go(null,retired,'POST')).status,404,
   'Mercado Pago removed from Node runtime: '+retired);
 }
assert.equal((await go(null,'/withdrawals/stripe-connect/webhook','POST')).status,503);
assert.equal((await go(null,'/v11/payouts/webhook','POST')).status,503);
const preview=await go(admin,'/payments/stripe/admin/orders/'+order+'/settlement-preview');
assert.equal(preview.status,200);
assert.equal(preview.json.can_settle,false);
assert.equal((await db.query('SELECT count(*)::int n FROM financial_ledger_entries')).rows[0].n,ledgerBefore);
// Driver offers: create, reject and accept with single assigned slot.
await db.query(
 "INSERT INTO driver_profiles(user_id,is_online,is_verified,rating)"+
 " VALUES($1,true,true,4.90),($2,true,true,4.80)",
 [driver.id,driverTwo.id]);
assert.equal((await go(customer,'/v11/admin/driver-offers/'+order+'/create','POST')).status,403);
const create=await go(admin,'/v11/admin/driver-offers/'+order+'/create','POST');
assert.equal(create.status,200,JSON.stringify(create.json));
assert.equal(create.json.created,2);
const received=await go(driver,'/v11/driver/offers');
assert.equal(received.status,200);
assert.equal(received.json.length,1);
assert.equal((await go(customer,'/v11/driver/offers')).status,403);
const offer=received.json[0].id;
assert.equal((await go(driverTwo,'/v11/driver/offers/'+offer+'/respond',
 'POST',{action:'accept'})).status,404);
const rejected=await go(driver,'/v11/driver/offers/'+offer+'/respond',
 'POST',{action:'reject'});
assert.equal(rejected.status,200);
assert.equal((await go(driver,'/v11/driver/offers/'+offer+'/respond',
 'POST',{action:'reject'})).status,409);
const otherOffer=(await go(driverTwo,'/v11/driver/offers')).json[0].id;
const accept=await go(driverTwo,'/v11/driver/offers/'+otherOffer+'/respond',
 'POST',{action:'accept'});
assert.equal(accept.status,200,JSON.stringify(accept.json));
assert.equal((await go(driverTwo,'/v11/driver/offers/'+otherOffer+'/respond',
 'POST',{action:'accept'})).status,409);
const reassign=await go(admin,'/v9/admin/dispatch/'+order+'/reassign','POST');
assert.equal(reassign.status,200,JSON.stringify(reassign.json));
assert.equal(reassign.json.previous_driver,driverTwo.id);
assert.equal(reassign.json.driver.driver_id,driver.id);
assert.equal((await db.query(
 "SELECT count(*)::int n FROM orders WHERE driver_id=$1 AND status IN ('assigned','picked_up','on_the_way')",
 [driver.id])).rows[0].n,1);
console.log('NODE_J1_52_CONFIG_RBAC_READS_AND_FINANCIAL_FAIL_CLOSED=PASS');
console.log('NODE_J1_REFERRALS_PENDING_AND_DRIVER_OFFERS_SINGLE_ACTIVE=PASS');
// Actual multipart tests (no fake JSON upload). Use real 1x1 PNG.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLypQAAAABJRU5ErkJggg==','base64');
const media=async(who,path,mime='image/png',data=png)=>{
 const body=new FormData();
 body.set('file',new Blob([data],{type:mime}),'test.png');
 return request(path,{token:who?.token,method:'POST',binary:body});
};
const proof=await media(driver,'/uploads/delivery-proof');
assert.equal(proof.status,200,JSON.stringify(proof.json));
assert.equal((await go(driver,proof.json.url)).status,403);
assert.equal((await go(admin,proof.json.url)).status,200);
const document=await media(customer,'/uploads/onboarding-document');
assert.equal(document.status,200,JSON.stringify(document.json));
assert.equal((await go(customer,document.json.url)).status,403);
assert.equal((await go(outsider,document.json.url)).status,403);
await db.query('INSERT INTO onboarding_applications(user_id,entity_type,documents_json) VALUES($1,$2,$3)',
 [customer.id,'driver',JSON.stringify([document.json.url])]);
assert.equal((await go(customer,document.json.url)).status,200);
assert.equal((await go(admin,document.json.url)).status,200);
const cover=await media(merchant,'/uploads/catalog/restaurant-cover');
assert.equal(cover.status,200,JSON.stringify(cover.json));
assert.equal((await go(null,cover.json.url)).status,200);
const catalog=await media(merchant,'/uploads/catalog/menu/'+item);
assert.equal(catalog.status,200,JSON.stringify(catalog.json));
assert.equal((await go(null,catalog.json.url)).status,200);
assert.equal((await media(customer,'/uploads/catalog/menu/'+item)).status,403);
const chat=await media(customer,'/uploads/chat-media/'+order);
assert.equal(chat.status,200,JSON.stringify(chat.json));
assert.equal((await go(customer,chat.json.url)).status,403);
await db.query(
 "INSERT INTO chat_messages(order_id,sender_id,message,media_url,message_type) VALUES($1,$2,'Imagen',$3,'photo')",
 [order,customer.id,chat.json.url]);
assert.equal((await go(customer,chat.json.url)).status,200);
assert.equal((await go(outsider,chat.json.url)).status,403);
assert.equal((await media(customer,'/uploads/chat-media/99999999')).status,404);
const fake=await media(driver,'/uploads/delivery-proof','image/png',Buffer.from('NOT A PNG'));
assert.equal(fake.status,415);
console.log('NODE_J1_MULTIPART_MAGIC_MEDIA_PRIVATE_AUTH_PUBLIC_CATALOG=PASS');
await db.end();
