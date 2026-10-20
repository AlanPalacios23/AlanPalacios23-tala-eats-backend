// ADMIN P0 E2E. GitHub Actions private synthetic PG15/Redis8 ONLY.
// MFA-verified login, helpdesk tenant isolation, audited replies and safe archive.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import pg from 'pg';
const url=String(process.env.DATABASE_URL??'');
if(process.env.GITHUB_ACTIONS!=='true' ||
 !url.includes('127.0.0.1:15435/tala_node_stage') ||
 !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0'))
 throw Error('ADMIN_QA_CI_ONLY');
const db=new pg.Client({connectionString:url});
await db.connect();
const base='http://127.0.0.1:18190/api/v1';
const secret='Admin-Stage-CI-Only-Password-2026!';
async function call(route,{token,method='GET',body}={}){
 const r=await fetch(base+route,{
  method,headers:{'content-type':'application/json',
   ...(token?{authorization:'Bearer '+token}:{}),
   'x-talaeats-client':'admin-ci'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
 });
 let json=null;try{json=await r.json();}catch{}
 return{status:r.status,json,cache:r.headers.get('cache-control')};
}
async function ready(){
 for(let i=0;i<50;i++){
  try{const r=await call('/ready');if(r.status===200&&r.json?.ready)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 throw Error('ADMIN_QA_API_NOT_READY');
}
await ready();
async function register(role){
 const email='admin.qa.'+process.pid+'.'+role+'@example.test';
 const r=await call('/auth/register',{method:'POST',body:{
  email,name:'QA '+role,password:secret}});
 assert.equal(r.status,201,JSON.stringify(r.json));
 return{id:r.json.user.id,email,token:r.json.access_token};
}
async function login(who,otp){
 return call('/auth/login',{method:'POST',body:{
  email:who.email,password:secret,...(otp?{otp}:{})}});
}
function totp(secretBase32){
 const symbols='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 let value=0,bits=0;
 const bytes=[];
 for(const ch of secretBase32.toUpperCase().replace(/=+$/,'')){
  const p=symbols.indexOf(ch);if(p<0)throw Error('INVALID_BASE32');
  value=(value<<5)|p;bits+=5;
  if(bits>=8){bytes.push((value>>>(bits-=8))&255);value&=(1<<bits)-1;}
 }
 const t=Math.floor(Date.now()/30000);
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(t));
 const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
 const offset=digest[digest.length-1]&15;
 return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
const admin=await register('admin'),owner=await register('owner'),
 customer=await register('customer'),other=await register('other');
await db.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);
await db.query("UPDATE users SET role='restaurant' WHERE id=$1",[owner.id]);
admin.token=(await login(admin)).json?.access_token;
owner.token=(await login(owner)).json?.access_token;
assert.ok(admin.token && owner.token);
assert.equal((await call('/admin/stats',{token:admin.token})).status,403);
assert.equal((await call('/admin/support',{token:customer.token})).status,403);
const setup=await call('/v9/security/2fa/setup',{token:admin.token,method:'POST'});
assert.equal(setup.status,200,JSON.stringify(setup.json));
const otp=totp(setup.json.secret);
const confirm=await call('/v9/security/2fa/confirm',{
 token:admin.token,method:'POST',body:{code:otp}});
assert.equal(confirm.status,200,JSON.stringify(confirm.json));
assert.equal((await call('/admin/stats',{token:admin.token})).status,403,
 'Old pre-enrollment JWT MUST NOT grant admin access');
assert.equal((await login(admin)).status,401);
assert.equal((await login(admin,'999999')).status,401);
const verified=await login(admin,totp(setup.json.secret));
assert.equal(verified.status,200,JSON.stringify(verified.json));
admin.token=verified.json.access_token;
assert.equal((await call('/admin/stats',{token:admin.token})).status,200);
const created=await call('/platform/support',{token:customer.token,method:'POST',body:{
 category:'general',message:'El pedido de pruebas necesita una respuesta profesional.'}});
assert.equal(created.status,201,JSON.stringify(created.json));
const ticketId=created.json.id;
const unauthList=await call('/platform/support',{token:other.token});
assert.equal(unauthList.status,200);
assert.equal(unauthList.json.some(x=>x.id===ticketId),false);
const tickets=await call('/admin/support',{token:admin.token});
assert.equal(tickets.status,200,JSON.stringify(tickets.json));
assert.equal(tickets.cache,'private, no-store');
assert.ok(tickets.json.some(x=>x.id===ticketId&&x.customer_email===customer.email));
const claimed=await call('/admin/support/'+ticketId,{
 token:admin.token,method:'PATCH',body:{status:'in_progress'}});
assert.equal(claimed.status,200,JSON.stringify(claimed.json));
const reply='Revisamos tu reporte y el equipo de Tala Eats hará seguimiento.';
const resolved=await call('/admin/support/'+ticketId,{
 token:admin.token,method:'PATCH',body:{status:'resolved',reply}});
assert.equal(resolved.status,200,JSON.stringify(resolved.json));
assert.equal(resolved.json.admin_reply,reply);
assert.equal((await call('/admin/support/'+ticketId,{
 token:admin.token,method:'PATCH',body:{status:'resolved',reply}})).status,409);
const mine=await call('/platform/support',{token:customer.token});
assert.equal(mine.status,200);
assert.ok(mine.json.some(x=>x.id===ticketId&&x.admin_reply===reply));
const notices=await db.query(
 "SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='support'",[customer.id]);
assert.equal(notices.rows[0].n,1);
const shop=(await db.query(
 "INSERT INTO restaurants(name,owner_id,is_open,market_code) VALUES('QA Closed Shop',$1,true,'TALA-JAL') RETURNING id",
 [owner.id])).rows[0].id;
const archiveBody={confirm_name:'QA Closed Shop',
 reason:'Negocio de pruebas inactivo, sin pedidos activos.'};
const archive=()=>call('/admin/restaurants/'+shop+'/archive',{
 token:admin.token,method:'PATCH',body:archiveBody});
assert.equal((await archive()).status,409);
await db.query('UPDATE restaurants SET is_open=false WHERE id=$1',[shop]);
const pending=(await db.query(
 "INSERT INTO orders(user_id,restaurant_id,status,address) VALUES($1,$2,'received','Tala') RETURNING id",
 [customer.id,shop])).rows[0].id;
assert.equal((await archive()).status,409);
await db.query("UPDATE orders SET status='delivered' WHERE id=$1",[pending]);
const archived=await archive();
assert.equal(archived.status,200,JSON.stringify(archived.json));
assert.equal(archived.json.verification_status,'archived');
assert.equal((await call('/restaurants/'+shop)).status,404);
assert.equal((await call('/owner/restaurant',{token:owner.token})).status,404);
const archivedList=await call('/admin/restaurants?filter=archived',{token:admin.token});
assert.equal(archivedList.status,200,JSON.stringify(archivedList.json));
assert.ok(archivedList.json.some(x=>x.id===shop));
assert.equal((await archive()).status,409);
const preserved=(await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE id=$1',[pending])).rows[0].n;
assert.equal(preserved,1);
console.log('NODE_ADMIN_MFA_VERIFIED_JWT_HELPDESK_AND_ARCHIVE=PASS');
await db.end();
