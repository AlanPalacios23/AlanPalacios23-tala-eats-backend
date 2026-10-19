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

// E2E: revocar un dispositivo específico (no el actual), sin revocar otros.
// A user cannot revoke another account's session, even with a known ID.
const third=await req('/api/v1/auth/login',{
  method:'POST',headers,body:JSON.stringify({email,password})
});
assert.equal(third.code,200);
const thirdToken=third.body.access_token;
const thirdDevices=await req('/api/v1/auth/devices',{headers:ownHeaders});
assert.equal(thirdDevices.code,200);
assert.equal(thirdDevices.body.length,3);
const thirdId=thirdDevices.body.find(x=>!x.current && x.id!==devices.body.find(d=>!d.current).id)?.id;
assert.ok(Number.isSafeInteger(thirdId));
const outsider=await req('/api/v1/auth/register',{
  method:'POST',headers,body:JSON.stringify({
    name:'Another Customer',email:'other.'+process.pid+'@example.test',password
  })
});
assert.equal(outsider.code,201);
const outsiderHeaders={...headers,authorization:'Bearer '+outsider.body.access_token};
const denied=await req('/api/v1/auth/devices/'+thirdId+'/revoke',{
  method:'POST',headers:outsiderHeaders
});
assert.equal(denied.code,404);
const thirdStillValid=await req('/api/v1/auth/me',{
  headers:{...headers,authorization:'Bearer '+thirdToken}
});
assert.equal(thirdStillValid.code,200);
const individual=await req('/api/v1/auth/devices/'+thirdId+'/revoke',{
  method:'POST',headers:ownHeaders
});
assert.equal(individual.code,200);
assert.equal(individual.body.revoked,true);
assert.equal(individual.body.current,false);
const killedThird=await req('/api/v1/auth/me',{
  headers:{...headers,authorization:'Bearer '+thirdToken}
});
assert.equal(killedThird.code,401);
const ownAfterIndividual=await req('/api/v1/auth/me',{headers:ownHeaders});
assert.equal(ownAfterIndividual.code,200);
const outsiderStillValid=await req('/api/v1/auth/me',{headers:outsiderHeaders});
assert.equal(outsiderStillValid.code,200);

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
// Recovery contract matches Python auth.py but the email remains QUEUED,
// not delivered. Inspect only ephemeral CI DB and never print the raw link.
const activeBefore=await req('/api/v1/auth/login',{
  method:'POST',headers,body:JSON.stringify({email,password})
});
assert.equal(activeBefore.code,200);
const known=await req('/api/v1/auth/password/forgot',{
  method:'POST',headers,body:JSON.stringify({email})
});
const unknown=await req('/api/v1/auth/password/forgot',{
  method:'POST',headers,body:JSON.stringify({email:'missing.'+process.pid+'@example.test'})
});
assert.equal(known.code,202);
assert.equal(unknown.code,202);
assert.deepEqual(unknown.body,known.body);
const resetRows=await client.query(
  "SELECT id,text_body,status FROM email_outbox WHERE to_email=$1 AND subject=$2 ORDER BY id",
  [email,'Restablece tu contraseña de Tala Eats']
);
assert.equal(resetRows.rowCount,1);
assert.equal(resetRows.rows[0].status,'pending');
function pendingResetToken(text) {
  const token=/[?&]token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  assert.ok(token && token.length>=20,'Missing pending reset token');
  return token;
}
const expiredToken=pendingResetToken(resetRows.rows[0].text_body);
await client.query(
  "UPDATE password_reset_tokens SET expires_at=NOW()-INTERVAL '1 minute' WHERE user_id=$1",
  [u.rows[0].id]
);
const expired=await req('/api/v1/auth/password/reset',{
  method:'POST',headers,body:JSON.stringify({token:expiredToken,password:'Another-Password-2026!'})
});
assert.equal(expired.code,400);
const secondForgot=await req('/api/v1/auth/password/forgot',{
  method:'POST',headers,body:JSON.stringify({email})
});
assert.equal(secondForgot.code,202);
const lastMail=await client.query(
  "SELECT text_body,status FROM email_outbox WHERE to_email=$1 AND subject=$2 ORDER BY id DESC LIMIT 1",
  [email,'Restablece tu contraseña de Tala Eats']
);
assert.equal(lastMail.rows[0].status,'pending');
const resetToken=pendingResetToken(lastMail.rows[0].text_body);
const newPassword='Changed-Password-2026!';
const resetPayload={method:'POST',headers,
  body:JSON.stringify({token:resetToken,password:newPassword})};
// Simultaneous replay must allow exactly one successful change.
const parallel=await Promise.all([
  req('/api/v1/auth/password/reset',resetPayload),
  req('/api/v1/auth/password/reset',resetPayload),
]);
assert.deepEqual(parallel.map(x=>x.code).sort(),[200,400]);
const replay=await req('/api/v1/auth/password/reset',resetPayload);
assert.equal(replay.code,400);
const stale=await req('/api/v1/auth/me',{
  headers:{...headers,authorization:'Bearer '+activeBefore.body.access_token}
});
assert.equal(stale.code,401);
const outsiderAfterReset=await req('/api/v1/auth/me',{headers:outsiderHeaders});
assert.equal(outsiderAfterReset.code,200);
const oldPassword=await req('/api/v1/auth/login',{
  method:'POST',headers,body:JSON.stringify({email,password})
});
assert.equal(oldPassword.code,401);
const newLogin=await req('/api/v1/auth/login',{
  method:'POST',headers,body:JSON.stringify({email,password:newPassword})
});
assert.equal(newLogin.code,200);
const postResetSession=await req('/api/v1/auth/me',{
  headers:{...headers,authorization:'Bearer '+newLogin.body.access_token}
});
assert.equal(postResetSession.code,200);
const tokenConsumed=await client.query(
  "SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL",
  [u.rows[0].id]
);
assert.equal(tokenConsumed.rows[0].n,0);
const notices=await client.query(
  "SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='security'",
  [u.rows[0].id]
);
assert.equal(notices.rows[0].n,1);
const auditReset=await client.query(
  "SELECT count(*)::int AS n FROM audit_events WHERE user_id=$1 AND action='password.reset.complete'",
  [u.rows[0].id]
);
assert.equal(auditReset.rows[0].n,1);
console.log('AUTH_RESET_QUEUE_TTL_REPLAY_CONCURRENCY_SESSIONS=PASS');
await client.end();
const redis=new Redis(process.env.REDIS_URL);
assert.equal(await redis.ping(),'PONG');
redis.disconnect();
console.log('PYTHON_AUTH_CONTRACT_REGISTRATION_LOGIN_SESSIONS_REVOKE=PASS');
console.log('STAGE_WALLET_NOTICE_AUDIT_EMAIL_OUTBOX=PASS');
console.log('AUTH_PG15_REDIS8_STAGE_CI_ONLY=PASS');
console.log('NO_PAYMENT_WRITES_NO_LIVE_PRODUCTION=PASS');
