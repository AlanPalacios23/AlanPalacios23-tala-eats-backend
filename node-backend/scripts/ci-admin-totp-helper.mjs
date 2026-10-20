// Internal disposable PG15/Redis8 GitHub Actions QA helper. Not shipped in dist.
// This helper never enrolls real accounts or fetches production credentials.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
const pg=String(process.env.DATABASE_URL??'');
const redis=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true' ||
 !pg.includes('127.0.0.1:15435/tala_node_stage') ||
 !redis.includes('127.0.0.1:16379/0'))throw Error('ADMIN_QA_HELPER_CI_ONLY');

function totp(secret){
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 let n=0,bits=0;const bytes=[];
 for(const ch of secret.toUpperCase().replace(/=+$/,'')){
  const v=alphabet.indexOf(ch);if(v<0)throw Error('QA_INVALID_TOTP_SECRET');
  n=(n<<5)|v;bits+=5;
  if(bits>=8){bytes.push((n>>>(bits-=8))&255);n&=(1<<bits)-1;}
 }
 const counter=Buffer.alloc(8);
 counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
 const off=digest.at(-1)&15;
 return String((digest.readUInt32BE(off)&0x7fffffff)%1000000).padStart(6,'0');
}
export async function enrollAdminQa(account,call,password){
 const setup=await call('/v9/security/2fa/setup',{token:account.token,method:'POST'});
 assert.equal(setup.status,200,JSON.stringify(setup.json));
 const confirm=await call('/v9/security/2fa/confirm',{
  token:account.token,method:'POST',body:{code:totp(setup.json.secret)}});
 assert.equal(confirm.status,200,JSON.stringify(confirm.json));
 // Old signed sessions are deliberately insufficient after enrolling TOTP.
 const login=await call('/auth/login',{method:'POST',body:{
  email:account.email,password,otp:totp(setup.json.secret)}});
 assert.equal(login.status,200,JSON.stringify(login.json));
 account.token=login.json.access_token;
}
