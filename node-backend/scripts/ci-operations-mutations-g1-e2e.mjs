// G1: operational write parity smoke and adversarial ACL on PG15/Redis8.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
const pgUrl=String(process.env.DATABASE_URL??''),ru=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!pgUrl.includes('127.0.0.1:15435/tala_node_stage')||
 !ru.includes('127.0.0.1:16379/0'))throw Error('G1_CI_ONLY');
const redis=new Redis(ru);let c='0';do{const [n,keys]=await redis.scan(c,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);if(keys.length)await redis.del(...keys);c=n;}while(c!=='0');redis.disconnect();
const db=new pg.Client({connectionString:pgUrl});await db.connect();
const pwd='G1-Operations-Test-Only!';
async function call(path,{token,method='GET',body}={}){
 const res=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,
  headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
   ...(token?{authorization:'Bearer '+token}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await res.json()}catch{}
 return {status:res.status,json};
}
async function user(name){
 const email='g1.'+process.pid+'.'+name+'@example.test';
 const x=await call('/auth/register',{method:'POST',body:{email,name:'G1 '+name,password:pwd}});
 assert.equal(x.status,201,JSON.stringify(x.json));
 return {email,token:x.json.access_token,id:x.json.user.id};
}
async function promote(who,role){
 await db.query('UPDATE users SET role=$1 WHERE id=$2',[role,who.id]);
 const x=await call('/auth/login',{method:'POST',body:{email:who.email,password:pwd}});
 assert.equal(x.status,200,JSON.stringify(x.json));who.token=x.json.access_token;
}
const admin=await user('admin'),alice=await user('alice'),bob=await user('bob'),
 owner=await user('owner'),driver=await user('driver');
await promote(admin,'admin');await promote(owner,'restaurant');await promote(driver,'driver');
const req=(who,path,method='GET',body)=>call(path,{token:who?.token,method,body});
const denied=async(path,method='GET',body)=>{
 const x=await req(alice,path,method,body);assert.equal(x.status,403,JSON.stringify(x.json));
 assert.equal((await req(null,path,method,body)).status,401);
};
// Create and update one active onboarding request under concurrent requests.
const profile={entity_type:'restaurant',business_name:'Mercado G1',documents:[]};
const a=await Promise.all([
 req(alice,'/operations/onboarding','POST',profile),
 req(alice,'/operations/onboarding','POST',profile),
]);
assert.ok(a.every(x=>x.status===201),JSON.stringify(a));
assert.equal(a[0].json.id,a[1].json.id);
assert.equal((await req(bob,'/operations/onboarding/mine')).json.length,0);
assert.equal((await req(alice,'/operations/onboarding/mine')).json.length,1);
await denied('/operations/admin/onboarding');
const all=(await req(admin,'/operations/admin/onboarding')).json;
assert.ok(all.some(x=>x.id===a[0].json.id));
await denied('/operations/admin/onboarding/'+a[0].json.id,'PATCH',{status:'approved'});
const approved=await req(admin,'/operations/admin/onboarding/'+a[0].json.id,'PATCH',{
 status:'approved',notes:'Verified'});
assert.equal(approved.status,200,JSON.stringify(approved.json));
assert.equal(approved.json.status,'approved');
assert.equal((await req(alice,'/operations/onboarding','POST',profile)).status,401); // old JWT revoked by role change
const ownedShop=(await db.query('SELECT id,is_open FROM restaurants WHERE owner_id=$1',[alice.id])).rows;
assert.equal(ownedShop.length,1);assert.equal(ownedShop[0].is_open,false);
const duplicate=await req(bob,'/operations/onboarding','POST',profile);
assert.equal(duplicate.status,201);
// Customer-owned account for follow-up
const restaurant=(await db.query(
 "INSERT INTO restaurants(name,address,owner_id) VALUES('G1 Brand','Tala', $1) RETURNING id",[owner.id])).rows[0].id;
const order=(await db.query(
 "INSERT INTO orders(user_id,restaurant_id,total,status,address) VALUES($1,$2,50.00,'ready','Tala') RETURNING id",
 [bob.id,restaurant])).rows[0].id;
await denied('/operations/admin/zones','POST',{name:'Tala G1',center_lat:20.65,center_lng:-103.7,radius_km:4});
const zone=await req(admin,'/operations/admin/zones','POST',{
 name:'Tala G1',center_lat:20.65,center_lng:-103.7,radius_km:4,
 surcharge:'3.50',min_order:'20.00'});
assert.equal(zone.status,201,JSON.stringify(zone.json));
assert.equal(zone.json.surcharge,'3.50');
assert.equal((await req(admin,'/operations/admin/zones','POST',{
 name:'Tala G1',center_lat:20.65,center_lng:-103.7,radius_km:4})).status,409);
assert.equal((await req(null,'/operations/coverage?lat=20.65&lng=-103.7')).json.covered,true);
await denied('/operations/admin/settings','PUT',{key:'stage.g1',value:'enabled'});
const setting=await req(admin,'/operations/admin/settings','PUT',
 {key:'stage.g1',value:'yes'});
assert.equal(setting.status,200,JSON.stringify(setting.json));
assert.equal(setting.json.value,'yes');
assert.equal((await req(admin,'/operations/admin/settings','PUT',
 {key:'mercadopago_access_token',value:'evil'})).status,403);
const flag=await req(admin,'/operations/admin/flags','PUT',
 {key:'stage.experimental',enabled:true,rollout_percent:100,audience_role:'customer'});
assert.equal(flag.status,200,JSON.stringify(flag.json));
assert.ok((await req(bob,'/operations/flags')).json.some(x=>x.key==='stage.experimental'));
assert.equal((await req(admin,'/operations/admin/flags','PUT',
 {key:'payment.capture',enabled:true})).status,403);
const violation=await req(alice,'/operations/disputes','POST',{
 order_id:order,category:'problema',description:'Esto no es mío'});
assert.equal(violation.status,403);
const dispute=await req(bob,'/operations/disputes','POST',{
 order_id:order,category:'demora',description:'Llegó tarde'});
assert.equal(dispute.status,201,JSON.stringify(dispute.json));
assert.equal((await req(owner,'/operations/disputes')).json.length,0);
assert.ok((await req(bob,'/operations/disputes')).json.some(x=>x.id===dispute.json.id));
await denied('/operations/admin/disputes/'+dispute.json.id,'PATCH',{
 status:'resolved',resolution:'Satisfactorio'});
const noRefund=await req(admin,'/operations/admin/disputes/'+dispute.json.id,'PATCH',
 {status:'resolved',resolution:'Atendido',refund_amount:'5.00'});
assert.equal(noRefund.status,503);
const resolve=await req(admin,'/operations/admin/disputes/'+dispute.json.id,'PATCH',
 {status:'resolved',resolution:'Resuelto',refund_amount:'0'});
assert.equal(resolve.status,200);assert.equal(resolve.json.refund_amount,'0.00');
// Ads never charged. Isolation: 2 shops cannot advertise one another.
assert.equal((await req(owner,'/operations/owner/campaigns')).status,200);
const campaign=await req(owner,'/operations/owner/campaigns','POST',
 {restaurant_id:restaurant,name:'Publicidad interna G1',daily_budget:'45.00'});
assert.equal(campaign.status,201,JSON.stringify(campaign.json));
assert.equal(campaign.json.daily_budget,'45.00');
assert.equal(campaign.json.spent,'0.00');
assert.equal((await req(owner,'/operations/owner/campaigns','POST',
 {restaurant_id:ownedShop[0].id,name:'Intruso',daily_budget:'2'})).status,403);
assert.equal((await req(owner,'/operations/owner/campaigns')).json.length,1);
for(const p of ['/operations/admin/simulations','/operations/admin/payouts',
 '/operations/admin/cash-settlements'])await denied(p);
const sim=await req(admin,'/operations/admin/simulations','POST',
 {scenario:'cancel_before_prep'});
assert.equal(sim.status,201,JSON.stringify(sim.json));
const advance=await req(admin,'/operations/admin/simulations/'+sim.json.id+'/advance','POST');
assert.equal(advance.status,200);
assert.equal(advance.json.current_step,'restaurant_confirm');
const next=await req(admin,'/operations/admin/simulations/'+sim.json.id+'/advance','POST');
assert.equal(next.status,200);
assert.equal(next.json.status,'completed');
assert.equal(next.json.current_step,'cancelled');
const run=await req(admin,'/operations/admin/simulations','POST',{scenario:'happy_path'});
assert.equal(run.status,201);
const whole=await req(admin,'/operations/admin/simulations/'+run.json.id+'/run-all','POST');
assert.equal(whole.status,200);
assert.equal(whole.json.current_step,'settled');
assert.equal((await req(admin,'/operations/admin/simulations')).json.length>=2,true);
assert.equal((await req(admin,'/operations/admin/payouts')).status,200);
assert.equal((await req(admin,'/operations/admin/cash-settlements')).status,200);
const finance=await req(owner,'/operations/owner/finance');
assert.equal(finance.status,200);
assert.equal(finance.json.restaurant_id,restaurant);
assert.equal(finance.json.net_payable,'0.00');
assert.equal((await req(bob,'/operations/owner/finance')).status,403);
assert.equal((await req(driver,'/operations/driver/finance')).status,200);
assert.equal((await req(bob,'/operations/driver/finance')).status,403);
await denied('/admin/restaurants','POST',{name:'New Shop'});
const rest=await req(admin,'/admin/restaurants','POST',{name:'G1 New Shop',owner_email:owner.email});
assert.equal(rest.status,201,JSON.stringify(rest.json));
assert.equal((await req(admin,'/admin/restaurants','POST',{
 name:'No owner',owner_email:'unregistered@example.test'})).status,404);
await denied('/admin/users/'+bob.id+'/active','PATCH');
assert.equal((await req(admin,'/admin/users/'+admin.id+'/active?active=false','PATCH')).status,400);
const off=await req(admin,'/admin/users/'+bob.id+'/active?active=false','PATCH');
assert.equal(off.status,200);
assert.equal(off.json.is_active,false);
assert.equal((await req(bob,'/operations/onboarding/mine')).status,401);
const active=await req(admin,'/admin/users/'+bob.id+'/active?active=true','PATCH');
assert.equal(active.status,200);
const fid=(await db.query(
 "INSERT INTO fraud_flags(user_id,reason) VALUES($1,'G1 review') RETURNING id",
 [alice.id])).rows[0].id;
assert.equal((await req(admin,'/admin/fraud/'+fid+'/resolved','PATCH')).status,200);
const verification=(await db.query(
 "INSERT INTO verification_records(entity_type,entity_id) VALUES('restaurant',$1) RETURNING id",
 [restaurant])).rows[0].id;
assert.equal((await req(admin,'/admin/verifications/'+verification+'?status=approved&notes=ok','PATCH')).status,200);
assert.equal((await req(admin,'/admin/restaurants/'+restaurant+'/verification?status=suspended','PATCH')).json.verification_status,'suspended');
await db.query('INSERT INTO driver_profiles(user_id) VALUES($1)',[driver.id]);
assert.equal((await req(admin,'/admin/drivers/'+driver.id+'/verified?verified=false','PATCH')).json.is_verified,false);
for(const path of ['/admin/fraud/'+fid+'/resolved','/admin/drivers/'+driver.id+'/verified',
 '/admin/verifications/'+verification,'/admin/restaurants/'+restaurant+'/verification'])
 assert.equal((await req(alice,path,'PATCH')).status,403);
const payouts=(await db.query('SELECT count(*)::int n FROM payouts')).rows[0].n;
const ledger=(await db.query('SELECT count(*)::int n FROM financial_ledger_entries')).rows[0].n;
assert.equal(payouts,0);assert.equal(ledger,0);
console.log('NODE_G1_ONBOARDING_ATOMIC_RBAC_AND_APPROVAL=PASS');
console.log('NODE_G1_ZONES_SETTINGS_FEATURE_FLAGS_STRICT_STAGE=PASS');
console.log('NODE_G1_DISPUTES_NO_REFUND_AND_CAMPAIGN_OWNER_ISOLATION=PASS');
console.log('NODE_G1_QA_SIMULATIONS_PAYOUT_FINANCE_READ_ONLY=PASS');
console.log('NODE_G1_ADMIN_VERIFY_FRAUD_ACTIVATION_RBAC=PASS');
await db.end();
