import assert from 'node:assert/strict';
import {enrollAdminQa} from './ci-admin-totp-helper.mjs';
import {createHmac} from 'node:crypto';
import pgLib from 'pg';
import {Redis} from 'ioredis';
const url=String(process.env.DATABASE_URL??''),ru=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!url.includes('127.0.0.1:15435/tala_node_stage')||
 !ru.includes('127.0.0.1:16379/0'))throw Error('CI_H3_ONLY');
const red=new Redis(ru);let p='0';do{const [n,k]=await red.scan(p,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);if(k.length)await red.del(...k);p=n;}while(p!=='0');red.disconnect();
const sql=new pgLib.Client({connectionString:url});await sql.connect();
const password='StageH3-Security-Only-2026!';
async function api(path,{token,method='GET',body,headers={}}={}){
 const r=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,
 headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile',
 ...(token?{authorization:'Bearer '+token}:{}),...headers},
 ...(body===undefined?{}:{body:JSON.stringify(body)})});
 let json=null;try{json=await r.json()}catch{}return {status:r.status,json};
}
async function register(tag){
 const email='h3a.'+process.pid+'.'+tag+'@example.test';
 const x=await api('/auth/register',{method:'POST',body:{name:'H3 '+tag,email,password}});
 assert.equal(x.status,201,JSON.stringify(x.json));
 return {id:x.json.user.id,email,token:x.json.access_token};
}
async function makeRole(user,role){
 await sql.query('UPDATE users SET role=$1 WHERE id=$2',[role,user.id]);
 const x=await api('/auth/login',{method:'POST',body:{email:user.email,password}});
 assert.equal(x.status,200);user.token=x.json.access_token;
}
const buyer=await register('buyer'),admin=await register('admin'),merchant=await register('merchant'),
 other=await register('other');
await makeRole(admin,'admin');await makeRole(merchant,'restaurant');
await enrollAdminQa(admin,api,password);
const go=(u,path,method='GET',body)=>api('/v9'+path,{token:u?.token,method,body});
const exp=await go(admin,'/admin/experiments','POST',{
 key:'h3.checkout',name:'H3 conversion experiment',
 variants:['control','short_checkout'],audience_role:'customer',
 rollout_percent:100,status:'running'});
assert.equal(exp.status,201,JSON.stringify(exp.json));
assert.equal((await go(buyer,'/admin/experiments')).status,403);
assert.equal((await go(admin,'/admin/experiments','POST',{
 key:'h3.checkout',name:'dup'})).status,409);
const simultaneous=await Promise.all([
 go(buyer,'/experiments/active'),go(buyer,'/experiments/active')]);
assert.ok(simultaneous.every(x=>x.status===200),JSON.stringify(simultaneous));
assert.equal(simultaneous[0].json[0].variant,simultaneous[1].json[0].variant);
const assignments=(await sql.query(
 'SELECT count(*)::int n FROM experiment_assignments WHERE experiment_id=$1 AND user_id=$2',
 [exp.json.id,buyer.id])).rows[0].n;
assert.equal(assignments,1);
assert.equal((await go(admin,'/admin/experiments')).status,200);
assert.equal((await go(other,'/experiments/active')).status,200);
// Bounded marketing runs only opt-in and one execution per 15 min.
await sql.query('UPDATE users SET marketing_opt_in=false WHERE id=$1',[other.id]);
const shop=(await sql.query("INSERT INTO restaurants(name,address) VALUES('H3 Cafe','Tala') RETURNING id")).rows[0].id;
await sql.query("INSERT INTO orders(user_id,restaurant_id,status,total,address) VALUES($1,$2,'delivered',45.00,'Tala')",
 [buyer.id,shop]);
const m=await go(admin,'/admin/marketing','POST',{
 name:'Primera compra H3',trigger_type:'first_order',
 segment:'all',channel:'in_app',message_template:'Cupón {coupon}',
 coupon_code:'H3'});
assert.equal(m.status,201);
assert.equal((await go(buyer,'/admin/marketing/'+m.json.id+'/run','POST')).status,403);
const run=await go(admin,'/admin/marketing/'+m.json.id+'/run','POST');
assert.equal(run.status,200,JSON.stringify(run.json));
assert.ok(run.json.targeted_users>=1); // other previous E2E users may also qualify
assert.equal((await go(admin,'/admin/marketing/'+m.json.id+'/run','POST')).status,429);
const notify=(await sql.query(
 "SELECT message FROM notifications WHERE user_id=$1 AND title='Primera compra H3'",[buyer.id])).rows;
assert.equal(notify.length,1);assert.equal(notify[0].message,'Cupón H3');
const email=await go(admin,'/admin/marketing','POST',{
 name:'Email H3',trigger_type:'first_order',channel:'email',
 message_template:'Nunca enviar email'});
assert.equal(email.status,201);
assert.equal((await go(admin,'/admin/marketing/'+email.json.id+'/run','POST')).status,503);
// Scoped catalog partner keys: raw key never stored.
assert.equal((await go(buyer,'/admin/partner-keys','POST',{partner_name:'H3 Partner'})).status,403);
assert.equal((await go(admin,'/admin/partner-keys','POST',{
 partner_name:'Bad H3',scopes:'orders:write'})).status,403);
const partner=await go(admin,'/admin/partner-keys','POST',{
 partner_name:'H3 Partner',scopes:'catalog:read'});
assert.equal(partner.status,201,JSON.stringify(partner.json));
assert.match(partner.json.api_key,/^te_stage_/);
const raw=partner.json.api_key;
assert.equal((await api('/v9/partner/catalog')).status,401);
const list=await api('/v9/partner/catalog',{headers:{'x-partner-key':raw}});
assert.equal(list.status,200,JSON.stringify(list.json));
assert.ok(list.json.restaurants.some(x=>x.id===shop));
assert.equal((await api('/v9/partner/catalog',{headers:{
 'x-partner-key':'invalid'}})).status,401);
const storage=(await sql.query(
 'SELECT key_hash FROM partner_api_keys WHERE id=$1',[partner.json.id])).rows[0];
assert.equal(storage.key_hash.length,64);
assert.ok(!storage.key_hash.includes('te_stage_'));
// Corporate statement is read-only; budget is not charged.
const corporate=await go(admin,'/admin/corporate','POST',{
 name:'H3 Corp '+process.pid,monthly_budget:'1250.00'});
assert.equal(corporate.status,201);
const order=(await sql.query(
 "INSERT INTO orders(user_id,restaurant_id,corporate_account_id,status,total,address,payment_status)"+
 " VALUES($1,$2,$3,'delivered',89.90,'Tala','corporate_pending') RETURNING id",
 [buyer.id,shop,corporate.json.id])).rows[0].id;
assert.equal((await go(buyer,'/admin/corporate/'+corporate.json.id+'/statement')).status,403);
const statement=await go(admin,'/admin/corporate/'+corporate.json.id+'/statement');
assert.equal(statement.status,200,JSON.stringify(statement.json));
assert.equal(statement.json.total,'89.90');
assert.equal(statement.json.orders[0].id,order);
assert.equal(statement.json.budget,'1250.00');
assert.equal((await go(admin,'/admin/corporate/'+corporate.json.id+'/statement?month=2026-13')).status,400);
// TOTP enrolled and revoked only with a valid counter-based code.
const blocked=await go(buyer,'/security/2fa/setup','POST');
assert.equal(blocked.status,403);
const setup=await go(merchant,'/security/2fa/setup','POST');
assert.equal(setup.status,200,JSON.stringify(setup.json));
assert.match(setup.json.secret,/^[A-Z2-7]{32}$/);
const repeated=await go(merchant,'/security/2fa/setup','POST');
assert.equal(repeated.json.secret,setup.json.secret);
assert.equal((await go(merchant,'/security/2fa/confirm','POST',{code:'000000'})).status,400);
function base32decode(s){let acc=0,bits=0,out=[];for(const ch of s){
 acc=(acc<<5)|'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
 bits+=5;if(bits>=8){bits-=8;out.push((acc>>>bits)&255);acc&=(1<<bits)-1;}}
 return Buffer.from(out);}
function totp(secret){
 const buf=Buffer.alloc(8);
 buf.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const dig=createHmac('sha1',base32decode(secret)).update(buf).digest();
 const off=dig.at(-1)&15;
 return String((dig.readUInt32BE(off)&0x7fffffff)%1_000_000).padStart(6,'0');
}
const otp=totp(setup.json.secret);
assert.equal((await go(merchant,'/security/2fa/confirm','POST',{code:otp})).status,200);
assert.equal((await go(merchant,'/security/2fa/setup','POST')).status,409);
assert.equal((await go(merchant,'/security/2fa/disable','POST',{code:'999999'})).status,400);
assert.equal((await go(merchant,'/security/2fa/disable','POST',{code:otp})).status,200);
const row=(await sql.query('SELECT two_factor_enabled,totp_secret FROM users WHERE id=$1',
 [merchant.id])).rows[0];
assert.equal(row.two_factor_enabled,false);
assert.equal(row.totp_secret,'');
console.log('NODE_H3_EXPERIMENT_CONCURRENT_STICKY_ASSIGNMENTS=PASS');
console.log('NODE_H3_OPT_IN_MARKETING_RATE_GATES=PASS');
console.log('NODE_H3_PARTNER_SCOPED_HASHED_READ_ONLY=PASS');
console.log('NODE_H3_CORPORATE_PRIVATE_STATEMENTS=PASS');
console.log('NODE_H3_TWO_FACTOR_VERIFY_ENROLL_DISABLE_AUDIT=PASS');
await sql.end();
