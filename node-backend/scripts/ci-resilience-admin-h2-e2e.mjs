import assert from 'node:assert/strict';
import pgLib from 'pg';
import {Redis} from 'ioredis';
const url=String(process.env.DATABASE_URL??''),rurl=String(process.env.REDIS_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||!url.includes('127.0.0.1:15435/tala_node_stage')||
 !rurl.includes('127.0.0.1:16379/0'))throw Error('H2_DISPOSABLE_ONLY');
const red=new Redis(rurl);let c='0';do{const [next,keys]=await red.scan(c,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);if(keys.length)await red.del(...keys);c=next;}while(c!=='0');red.disconnect();
const db=new pgLib.Client({connectionString:url});await db.connect();
async function api(path,{token,method='GET'}={}){
 const x=await fetch('http://127.0.0.1:18190/api/v1'+path,{method,
  headers:{'x-talaeats-client':'customer-mobile',...(token?{authorization:'Bearer '+token}:{})}});
 let json=null;try{json=await x.json()}catch{}return {status:x.status,json};}
const pwd='H2-Only-Staging-Tests!';
async function create(name){const email='h2.'+process.pid+'.'+name+'@example.test';
 const res=await fetch('http://127.0.0.1:18190/api/v1/auth/register',{
 method:'POST',headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile'},
 body:JSON.stringify({name,email,password:pwd})});assert.equal(res.status,201);
 const payload=await res.json();return {id:payload.user.id,email,token:payload.access_token};}
const admin=await create('admin'),customer=await create('customer');
await db.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);
const login=await fetch('http://127.0.0.1:18190/api/v1/auth/login',{
 method:'POST',headers:{'content-type':'application/json','x-talaeats-client':'customer-mobile'},
 body:JSON.stringify({email:admin.email,password:pwd})});
assert.equal(login.status,200);admin.token=(await login.json()).access_token;
const path='/resilience',go=(u,p,method='GET')=>api(path+p,{token:u?.token,method});
for(const p of ['/status','/alerts','/dlq','/ledger/balance','/slo','/infrastructure']){
 assert.equal((await go(customer,p)).status,403,'role: '+p);
 assert.equal((await go(null,p)).status,401,'auth: '+p);
}
const status=await go(admin,'/status');
assert.equal(status.status,200);assert.equal(status.json.implementation,'node-stage');
assert.ok(status.json.outbox.pending>=0);
assert.equal(status.json.runtime.sampled,false);
const ledgerBefore=(await db.query('SELECT count(*)::int n FROM financial_ledger_entries')).rows[0].n;
const row=(await db.query(
 "INSERT INTO dead_letter_jobs(source,source_id,kind,payload_json,error)"+
 " VALUES('outbox','order-88','order.updated',$1,'Synthetic CI only') RETURNING id",
 [JSON.stringify({order_id:88,sample:true})])).rows[0].id;
const source=await go(admin,'/dlq?limit=10');
assert.equal(source.status,200);assert.ok(source.json.some(x=>x.id===row));
assert.equal((await go(customer,'/dlq/'+row+'/retry','POST')).status,403);
const retry=await go(admin,'/dlq/'+row+'/retry','POST');
assert.equal(retry.status,200,JSON.stringify(retry.json));
assert.equal(retry.json.status,'pending');
assert.equal((await go(admin,'/dlq/'+row+'/retry','POST')).status,409);
assert.equal((await db.query(
 'SELECT count(*)::int n FROM event_outbox WHERE event_key=$1',['dlq-retry:'+row])).rows[0].n,1);
await db.query(
 "INSERT INTO payment_reconciliations(provider,provider_payment_id,status)"+
 " VALUES('stripe','ci-h2','mismatch')");
const eval1=await go(admin,'/alerts/evaluate','POST');
assert.equal(eval1.status,200,JSON.stringify(eval1.json));
assert.ok(eval1.json.created+eval1.json.updated>=1);
const eval2=await go(admin,'/alerts/evaluate','POST');
assert.equal(eval2.status,200);
assert.ok(eval2.json.updated>=1);
const alerts=await go(admin,'/alerts');
assert.equal(alerts.status,200);
assert.ok(alerts.json.some(x=>x.key==='node.stage.payment_mismatch'));
assert.equal((await db.query(
 "SELECT count(*)::int n FROM system_alerts WHERE alert_key='node.stage.payment_mismatch' AND status='open'"
 )).rows[0].n,1);
const order=(await db.query(
 "INSERT INTO restaurants(name,address) VALUES('H2 Test','Tala') RETURNING id")).rows[0].id;
const customerOrder=(await db.query(
 "INSERT INTO orders(user_id,restaurant_id,address) VALUES($1,$2,'Tala') RETURNING id",
 [customer.id,order])).rows[0].id;
await db.query(
 'INSERT INTO financial_ledger_entries(order_id,user_id,account,direction,amount,kind,idempotency_key)'+
 " VALUES($1,$2,'h2-clearing','credit',3.15,'ci',$3),($1,$2,'h2-clearing','debit',1.05,'ci',$4)",
 [customerOrder,customer.id,'h2-credit-'+customerOrder,'h2-debit-'+customerOrder]);
const balance=await go(admin,'/ledger/balance');
assert.equal(balance.status,200);
assert.equal(balance.json.append_only,true);
assert.equal(balance.json.balances['h2-clearing'],'2.10');
const slo=await go(admin,'/slo');
assert.equal(slo.status,200);
assert.equal(slo.json.metrics_sampled,false);
assert.equal(slo.json.healthy,false);
const infra=await go(admin,'/infrastructure');
assert.equal(infra.status,200);
assert.equal(infra.json.stage_only,true);
assert.equal(infra.json.postgis_available,false);
assert.equal(infra.json.immutable_ledger,true);
const old=(await db.query(
 "INSERT INTO system_alerts(alert_key,message,status,resolved_at)"+
 " VALUES('h2.old.resolved','Old', 'resolved',NOW()-INTERVAL '100 days') RETURNING id")).rows[0].id;
const older=(await db.query(
 "INSERT INTO dead_letter_jobs(source,kind,status,resolved_at)"+
 " VALUES('qa','system.cleanup','retried',NOW()-INTERVAL '100 days') RETURNING id")).rows[0].id;
const retention=await go(admin,'/retention/run?limit=50','POST');
assert.equal(retention.status,200,JSON.stringify(retention.json));
assert.ok(retention.json.deleted_alerts>=1);
assert.ok(retention.json.deleted_dlq>=1);
assert.equal(retention.json.deleted_financial_records,0);
assert.equal((await db.query('SELECT count(*)::int n FROM system_alerts WHERE id=$1',[old])).rows[0].n,0);
assert.equal((await db.query('SELECT count(*)::int n FROM dead_letter_jobs WHERE id=$1',[older])).rows[0].n,0);
assert.equal((await db.query('SELECT count(*)::int n FROM financial_ledger_entries')).rows[0].n,ledgerBefore+2);
console.log('NODE_H2_ADMIN_RESILIENCE_STATUS_ALERTS_DLQ_RBAC=PASS');
console.log('NODE_H2_DLQ_RETRY_ONCE_OUTBOX_ATOMIC=PASS');
console.log('NODE_H2_ALERT_EVALUATION_IDEMPOTENT_AND_SLO_UNSAMPLED=PASS');
console.log('NODE_H2_LEDGER_BALANCE_AND_SAFE_RETENTION_NO_MONEY_DELETE=PASS');
await db.end();
