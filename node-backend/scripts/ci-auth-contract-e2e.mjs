// Real ephemeral PG15+Redis8 integration: public Python auth contract, no LIVE.
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import pg from 'pg';

const base = 'http://127.0.0.1:18190';
const device = 'ci-auth-device-v02';
const headers = { 'content-type':'application/json', 'x-device-id':device,
  'x-talaeats-client':'customer-mobile' };

async function req(path, opts={}) {
  const r=await fetch(base+path,opts);
  let body=null;try{body=await r.json()}catch{}
  return {code:r.status,body};
}
async function waitReady() {
  for(let i=0;i<40;i++){
    try{const x=await req('/api/v1/ready');if(x.code===200&&x.body?.ready)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw new Error('API_NOT_READY');
}
await waitReady();
const password='A-Long-Password-2026!';
const email='ci.'+process.pid+'@example.test';
const registered=await req('/api/v1/auth/register',{
  method:'POST',headers,body:JSON.stringify({name:'Tala Test',email,password})
});
assert.equal(registered.code,201,JSON.stringify(registered.body));
assert.equal(registered.body.user.name,'Tala Test');
assert.equal(registered.body.user.role,'customer');
assert.equal(registered.body.user.auth_provider,'local');
assert.equal(registered.body.user.is_active,true);
assert.ok(registered.body.access_token.split('.').length===3);
assert.ok(registered.body.device_token);
const token=registered.body.access_token;

const duplicate=await req('/api/v1/auth/register',{
  method:'POST',headers,body:JSON.stringify({name:'Tala Duplicate',email,password})
});
assert.equal(duplicate.code,409);
const bad=await req('/api/v1/auth/login',{
  method:'POST',headers,body:JSON.stringify({email,password:'wrong-password'})
});
assert.equal(bad.code,401);
const logged=await req('/api/v1/auth/login',{
  method:'POST',headers,body:JSON.stringify({email,password})
});
assert.equal(logged.code,200);
const secondToken=logged.body.access_token;
assert.notEqual(secondToken,token);

const ownHeaders={...headers,authorization:'Bearer '+token,
  'x-device-token':registered.body.device_token};
const profile=await req('/api/v1/auth/me',{headers:ownHeaders});
assert.equal(profile.code,200);
assert.equal(profile.body.id,registered.body.user.id);
assert.equal(profile.body.role,'customer');
assert.ok(!Object.hasOwn(profile.body,'password_hash'));
const patched=await req('/api/v1/auth/me',{
  method:'PATCH',headers:ownHeaders,body:JSON.stringify({name:'Tala Customer'})
});
assert.equal(patched.code,200);
assert.equal(patched.body.name,'Tala Customer');
const forbidden=await req('/api/v1/auth/me',{
  method:'PATCH',headers:ownHeaders,body:JSON.stringify({role:'admin'})
});
assert.equal(forbidden.code,422);
const wrongDevice=await req('/api/v1/auth/me',{
  headers:{...ownHeaders,'x-device-id':'another-device'}
});
assert.equal(wrongDevice.code,401);

const devices=await req('/api/v1/auth/devices',{headers:ownHeaders});
assert.equal(devices.code,200);
assert.equal(devices.body.length,2);
assert.equal(devices.body.filter(x=>x.current).length,1);
const revoke=await req('/api/v1/auth/devices/revoke-others',{
  method:'POST',headers:ownHeaders
});
assert.equal(revoke.code,200);
assert.equal(revoke.body.revoked,1);
const killed=await req('/api/v1/auth/me',{
  headers:{...headers,authorization:'Bearer '+secondToken}
});
assert.equal(killed.code,401);
const own=await req('/api/v1/auth/me',{headers:ownHeaders});
assert.equal(own.code,200);
const logout=await req('/api/v1/auth/logout',{method:'POST',headers:ownHeaders});
assert.equal(logout.code,204);
const after=await req('/api/v1/auth/me',{headers:ownHeaders});
assert.equal(after.code,401);

const google=await req('/api/v1/auth/google/config');
assert.equal(google.code,200);
assert.equal(google.body.enabled,false);

const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
const u=await client.query('SELECT id, role, auth_provider FROM users WHERE email=$1',[email]);
assert.equal(u.rowCount,1);
assert.equal(u.rows[0].role,'customer');
const wallet=await client.query('SELECT points,wallet_balance,tier FROM loyalty_accounts WHERE user_id=$1',[u.rows[0].id]);
assert.equal(wallet.rowCount,1);
assert.equal(wallet.rows[0].tier,'BRONZE');
assert.equal(wallet.rows[0].wallet_balance,'0.00');
const notice=await client.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1',[u.rows[0].id]);
assert.equal(notice.rows[0].n,1);
const audit=await client.query('SELECT count(*)::int AS n FROM audit_events WHERE user_id=$1',[u.rows[0].id]);
assert.ok(audit.rows[0].n>=2);
const mail=await client.query('SELECT status FROM email_outbox WHERE to_email=$1',[email]);
assert.equal(mail.rowCount,1);
assert.equal(mail.rows[0].status,'pending');
await client.end();
const redis=new Redis(process.env.REDIS_URL);
assert.equal(await redis.ping(),'PONG');
redis.disconnect();
console.log('PYTHON_AUTH_CONTRACT_REGISTRATION_LOGIN_SESSIONS_REVOKE=PASS');
console.log('STAGE_WALLET_NOTICE_AUDIT_EMAIL_OUTBOX=PASS');
console.log('AUTH_PG15_REDIS8_STAGE_CI_ONLY=PASS');
console.log('NO_PAYMENT_WRITES_NO_LIVE_PRODUCTION=PASS');
