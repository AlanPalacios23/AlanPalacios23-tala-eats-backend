import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../dist/auth/crypto.js';
if(process.env.NODE_ENV!=='staging'||process.env.CI!=='true')throw Error('RC94_STAGE_ONLY');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const base='http://127.0.0.1:18190/api/v1/auth';
const post=async(path,data,form=false)=>{
 const r=await fetch(base+path,{method:'POST',
 headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json'},
 body:form?new URLSearchParams(data):JSON.stringify(data)});
 return {status:r.status,text:await r.text()};
};
try{
 for(const role of ['customer','restaurant','driver']){
  const email='rc94-'+randomUUID().slice(0,8)+'@example.test';
  const password='OldPassword-RC94!';
  await pool.query('INSERT INTO users(name,email,role,password_hash) VALUES($1,$2,$3,$4)',
   ['RC94 '+role,email,role,await hashPassword(password)]);
  const old=await post('/login',{email,password});
  assert.equal(old.status,200);
  const oldToken=JSON.parse(old.text).access_token;
  const unknown=await post('/password/forgot',{email:'missing-'+randomUUID().slice(0,8)+'@example.test'});
  const asked=await post('/password/forgot',{email});
  assert.equal(asked.status,202);
  assert.equal(unknown.status,202);
  assert.equal(unknown.text,asked.text);
  const rows=await pool.query(
   "SELECT text_body FROM email_outbox WHERE to_email=$1 AND subject='Restablece tu contraseña de Tala Eats'",[email]);
  assert.equal(rows.rowCount,1);
  const token=/reset-page\?token=([A-Za-z0-9_-]+)/.exec(rows.rows[0].text_body)?.[1];
  assert.ok(token);
  const page=await fetch(base+'/password/reset-page?token='+token);
  assert.equal(page.status,200);
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  const newPassword='NewPassword-RC94!';
  const done=await post('/password/reset-page',{token,password:newPassword,confirm:newPassword},true);
  assert.equal(done.status,200,done.text);
  const oldSession=await fetch(base+'/me',{headers:{authorization:'Bearer '+oldToken}});
  assert.equal(oldSession.status,401);
  assert.equal((await post('/login',{email,password})).status,401);
  assert.equal((await post('/login',{email,password:newPassword})).status,200);
  assert.equal((await post('/password/reset',{token,password:newPassword})).status,400);
  // Same address is capped at 3 reset requests per 15 minutes, even with
  // another source IP. HTTP stays indistinguishable from an unknown user.
  for(let j=0;j<3;j++)assert.equal((await post('/password/forgot',{email})).status,202);
  const budget=await pool.query(
   "SELECT COUNT(*)::int AS count FROM email_outbox WHERE to_email=$1 AND subject='Restablece tu contraseña de Tala Eats'",[email]);
  assert.equal(budget.rows[0].count,3);
  console.log('RC94_RESET_ROLE_'+role.toUpperCase()+'=PASS');
 }
}finally{await pool.end()}
