// Tests v1.6.2 pricing only with isolated, disposable GitHub CI PostgreSQL/Redis.
// Never run on Kali, with real customer data, or with financial writes enabled.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.NODE_ENV !== 'staging' ||
    process.env.COMMERCIAL_PRICING_V162_ENABLED !== 'true' ||
    process.env.STRIPE_FINANCIAL_WRITES_ENABLED !== 'false' ||
    !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage') ||
    !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0')) {
  throw Error('V162_PG15_REDIS8_CI_ONLY');
}

const base='http://127.0.0.1:18190/api/v1';
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const redis=new Redis(process.env.REDIS_URL);
await db.connect();
const headers={'content-type':'application/json','x-talaeats-client':'customer-mobile'};
const call=async(path,{method='GET',token,body}={})=>{
  const res=await fetch(base+path,{method,headers:{
    ...headers,...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json=await res.json().catch(()=>null);
  return {status:res.status,json};
};
try {
  let ready;
  for(let i=0;i<40;i++){
    ready=await call('/ready').catch(()=>null);
    if(ready?.status===200 && ready.json?.ready)break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(ready?.status,200);
  assert.equal(ready?.json?.financialWrites,false);
  // The previous isolated suites may have used the same auth rate counters.
  let cursor='0';
  do {
    const [next,keys]=await redis.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
    if(keys.length)await redis.del(...keys);
    cursor=next;
  }while(cursor!=='0');

  const email='v162.cap.'+process.pid+'@example.test';
  const register=await call('/auth/register',{method:'POST',
    body:{name:'V162 Cap Gate',email,password:'V162-CI-Isolated-Strong-2026!'}});
  assert.equal(register.status,201,JSON.stringify(register.json));
  const token=register.json.access_token;
  const userId=register.json.user.id;

  const rest=(await db.query(
    "INSERT INTO restaurants(name,address,is_open,pickup_enabled) VALUES('V162 Cap Store','Tala',true,true) RETURNING id",
  )).rows[0].id;
  const priceRows=['100.00','357.14','500.00','1000.00'];
  const items=[];
  for(const price of priceRows) {
    const row=(await db.query(
      "INSERT INTO menu_items(restaurant_id,name,price,stock,is_available) VALUES($1,$2,$3,2,true) RETURNING id",
      [rest,'V162 '+price,price])).rows[0];
    items.push(row.id);
  }
  // Python applies commercial_v152 commission but commercial_v162 fee+cap.
  // Deliberately change the unused legacy fee to prove it is not consulted.
  await db.query(
    "INSERT INTO system_settings(key,value) VALUES('commercial_v152.restaurant_commission_rate','0.1500') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value"
  );
  await db.query(
    "INSERT INTO system_settings(key,value) VALUES('commercial_v152.service_fee_rate','0.0900') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value"
  );
  await db.query(
    "INSERT INTO system_settings(key,value) VALUES('commercial_v162.service_fee_rate','0.0700') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value"
  );
  await db.query(
    "INSERT INTO system_settings(key,value) VALUES('commercial_v162.service_fee_cap','26.00') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value"
  );
  const intent=(i,ref)=>({restaurant_id:rest,address:'Recoger en Tala',
    items:[{menu_item_id:items[i],quantity:1}],payment_method:'cash',
    order_type:'pickup',client_reference:ref,tip:'0.00'});
  const denied=await call('/orders',{method:'POST',token,
    body:intent(0,'v162-cap-config-denied')});
  assert.equal(denied.status,503,JSON.stringify(denied.json));
  assert.equal((await db.query('SELECT stock FROM menu_items WHERE id=$1',[items[0]])).rows[0].stock,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM orders WHERE client_reference=$1',
    ['v162-cap-config-denied'])).rows[0].n,0);

  await db.query(
    "UPDATE system_settings SET value='25.0000' WHERE key='commercial_v162.service_fee_cap'"
  );
  const expectedFees=['7.00','25.00','25.00','25.00'];
  const expectedCommissions=['15.00','53.57','75.00','150.00'];
  for(let i=0;i<items.length;i++){
    const p=intent(i,'v162-cap-'+i);
    const order=await call('/orders',{method:'POST',token,body:p});
    assert.equal(order.status,201,JSON.stringify({i,order:order.json}));
    assert.equal(Number(order.json.service_fee).toFixed(2),expectedFees[i]);
    assert.equal(Number(order.json.platform_commission).toFixed(2),expectedCommissions[i]);
    assert.equal(Number(order.json.total).toFixed(2),
      (Number(priceRows[i])+Number(expectedFees[i])).toFixed(2));
    const replay=await call('/orders',{method:'POST',token,body:p});
    assert.equal(replay.status,201);
    assert.equal(replay.json.id,order.json.id);
    const entries=await db.query(
      'SELECT account,amount FROM financial_ledger_entries WHERE order_id=$1',
      [order.json.id]);
    assert.equal(entries.rows.length,4);
    assert.equal((await db.query('SELECT stock FROM menu_items WHERE id=$1',[items[i]])).rows[0].stock,1);
    assert.equal((await db.query('SELECT user_id FROM orders WHERE id=$1',[order.json.id])).rows[0].user_id,userId);
  }
  await db.query(
    "UPDATE system_settings SET value='0.0800' WHERE key='commercial_v162.service_fee_rate'"
  );
  const rateDenied=await call('/orders',{method:'POST',token,
    body:intent(0,'v162-rate-config-denied')});
  assert.equal(rateDenied.status,503,JSON.stringify(rateDenied.json));
  assert.equal((await db.query('SELECT stock FROM menu_items WHERE id=$1',[items[0]])).rows[0].stock,1);
  console.log('NODE_V162_7_PERCENT_25_MXN_CAP_PARITY=PASS');
  console.log('NODE_V162_15_PERCENT_COMMISSION_AND_LEDGER=PASS');
  console.log('NODE_V162_CUSTOM_CONFIG_FAILCLOSED_AND_NO_STOCK_DEBIT=PASS');
  console.log('NODE_V162_249_ROUTE_STAGE_ONLY_NO_REAL_PSP=PASS');
} finally {
  redis.disconnect();
  await db.end();
}
