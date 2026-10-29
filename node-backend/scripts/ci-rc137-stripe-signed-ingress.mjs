/** Stripe SDK HMAC HTTP ingress, synthetic event; never a Stripe API payment. */
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import pg from 'pg';
const u=new URL(process.env.DATABASE_URL??'');
if(process.env.GITHUB_ACTIONS!=='true'||process.env.NODE_ENV!=='staging'||
 u.hostname!=='127.0.0.1'||u.port!=='15435'||
 u.pathname!=='/tala_node_stage'||
 process.env.STRIPE_LIVE_ENABLED!=='false'||
 process.env.STRIPE_FINANCIAL_WRITES_ENABLED!=='false'||
 process.env.STRIPE_CONNECT_TRANSFERS_ENABLED!=='false'||
 !process.env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_'))
 throw Error('RC137_HMAC_DISPOSABLE_ONLY');
const base='http://127.0.0.1:18190/api/v1';
const secret=process.env.STRIPE_WEBHOOK_SECRET;
const now=Math.floor(Date.now()/1000);
const sign=body=>'t='+now+',v1='+createHmac('sha256',secret)
 .update(now+'.'+body).digest('hex');
const id='evt_rc137'+randomUUID().replaceAll('-','');
const payload=JSON.stringify({
 id,object:'event',livemode:false,type:'payment_intent.payment_failed',
 created:now,api_version:'2026-09-30.clover',
 data:{object:{id:'pi_rc137'+randomUUID().replaceAll('-',''),
  object:'payment_intent',currency:'mxn',amount:25300,
  status:'requires_payment_method',metadata:{}}},
});
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
async function send(body,signature){
 const r=await fetch(base+'/webhooks/stripe',{method:'POST',
  headers:{'content-type':'application/json','stripe-signature':signature},
  body,signal:AbortSignal.timeout(4000)});
 return {status:r.status,result:await r.json()};
}
try{
 await client.connect();
 for(let i=0;i<40;i++){
  try{const r=await fetch(base+'/ready');if(r.status===200)break;}catch{}
  if(i===39)throw Error('RC137_API_NOT_READY');
  await new Promise(r=>setTimeout(r,200));
 }
 const unsigned=await fetch(base+'/webhooks/stripe',{method:'POST',
  headers:{'content-type':'application/json'},body:payload});
 assert.equal(unsigned.status,400,'Unsigned webhook must be refused');
 assert.equal((await send(payload,'t='+now+',v1='+'a'.repeat(64))).status,400);
 assert.equal((await send(payload+' ',sign(payload))).status,400,
  'Changed body must not verify against original signature');
 const good=await send(payload,sign(payload));
 assert.equal(good.status,200,JSON.stringify(good.result));
 assert.equal(good.result.received,true);
 const replay=await send(payload,sign(payload));
 assert.equal(replay.status,200,'Stripe retry should ACK durable existing event');
 const rows=await client.query(
  'SELECT id,type,"deliveryCount"::int AS delivery_count,"objectId" AS object_id FROM stripe_webhook_events WHERE id=$1',
  [id]);
 assert.equal(rows.rows.length,1,'Exactly one durable provider event');
 assert.equal(rows.rows[0].id,id);
 assert.equal(rows.rows[0].delivery_count,2);
 assert.equal(rows.rows[0].type,'payment_intent.payment_failed');
 assert.ok(rows.rows[0].object_id.startsWith('pi_rc137'));
 const live=JSON.stringify({...JSON.parse(payload),livemode:true,
  id:'evt_rc137LIVE'+randomUUID().replaceAll('-','')});
 assert.equal((await send(live,sign(live))).status,403,
  'Never accept livemode=true provider event in staging');
 const liveCount=await client.query(
  'SELECT COUNT(*)::int AS count FROM stripe_webhook_events WHERE id=$1',
  [JSON.parse(live).id]);
 assert.equal(liveCount.rows[0].count,0);
 console.log('RC137_STRIPE_TEST_HMAC_HTTP_INGRESS_PASS');
 console.log('RC137_UNSIGNED_TAMPERED_LIVE_REFUSED_PASS');
 console.log('RC137_DURABLE_INBOX_REPLAY_DEDUP_PASS');
 console.log('RC137_REAL_PROVIDER_CHARGES_ZERO');
}catch(e){console.error('RC137_INGRESS_FAIL',e);process.exitCode=1;}
finally{await client.end();}
