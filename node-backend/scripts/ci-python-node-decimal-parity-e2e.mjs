// Python Decimal ↔ live Node PG15/Redis8 checkout and cancellation parity.
// Synthetic GitHub Actions only, *never* Kali or any real money pipeline.
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base='http://127.0.0.1:18190/api/v1';
if(process.env.GITHUB_ACTIONS!=='true'||
   !String(process.env.DATABASE_URL).includes('127.0.0.1:15435/tala_node_stage')||
   !String(process.env.REDIS_URL).includes('127.0.0.1:16379/0')||
   process.env.STAGE_PICKUP_CASH_CHECKOUT_ENABLED!=='true')
  throw Error('PARITY_CI_ONLY_GUARD');
const rclient=new Redis(process.env.REDIS_URL);
// Existing regression tests run sequentially and may have filled 1min
// synthetic auth throttles. Never touch sessions, only local CI counters.
let cursor='0';
do{
  const [next,keys]=await rclient.scan(cursor,'MATCH','tala:node:v02:auth:rate:*','COUNT',100);
  if(keys.length)await rclient.del(...keys);
  cursor=next;
}while(cursor!=='0');
rclient.disconnect();
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
const pwd='Tala-Decimal-Parity-CI-2026!';
const headers={'content-type':'application/json','x-talaeats-client':'customer-mobile'};
async function call(path,{method='GET',token,body}={}){
  const res=await fetch(base+path,{method,headers:{
    ...headers,...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  let json;try{json=await res.json()}catch{json=null}
  return {status:res.status,json};
}
async function register(label) {
  const email='parity.'+process.pid+'.'+label+'@example.test';
  const res=await call('/auth/register',{method:'POST',body:{email,password:pwd,name:label}});
  assert.equal(res.status,201,JSON.stringify(res.json));
  return {id:res.json.user.id,token:res.json.access_token,email};
}
const customer=await register('customer');
const merchant=await register('merchant');
await db.query('UPDATE users SET role=$1 WHERE id=$2',['restaurant',merchant.id]);
const merchantLogin=await call('/auth/login',{method:'POST',
  body:{email:merchant.email,password:pwd}});
assert.equal(merchantLogin.status,200,JSON.stringify(merchantLogin.json));
merchant.token=merchantLogin.json.access_token;
const restaurant=(await db.query(
  "INSERT INTO restaurants(name,address,owner_id,is_open,pickup_enabled) VALUES('C4 Decimal','Tala Centro',$1,true,true) RETURNING id",
  [merchant.id])).rows[0].id;
// Half-even ties (.05 × .10 = .005 => .00; .15 × .30 = .045 => .04)
// plus realistic peso and two-decimal MXN quote combinations.
const vectors=[
  {subtotal:'0.05',tip:'0.00'},
  {subtotal:'0.15',tip:'0.00'},
  {subtotal:'0.25',tip:'0.00'},
  {subtotal:'0.45',tip:'0.00'},
  {subtotal:'1.25',tip:'0.20'},
  {subtotal:'25.50',tip:'1.00'},
  {subtotal:'99.99',tip:'0.00'},
  {subtotal:'100.05',tip:'0.15'},
  {subtotal:'500.25',tip:'2.50'},
];
const here=fileURLToPath(new URL('./python_cash_pickup_decimal_oracle.py',import.meta.url));
const python=JSON.parse(execFileSync('python3',[here],
  {input:JSON.stringify(vectors),encoding:'utf8',timeout:5000}));
assert.equal(python.length,vectors.length);
const created=[];
for(let i=0;i<vectors.length;i++){
  const {subtotal,tip}=vectors[i];
  const expected=python[i];
  const item=(await db.query(
    "INSERT INTO menu_items(restaurant_id,name,price,stock) VALUES($1,$2,$3,1) RETURNING id",
    [restaurant,'Parity '+i,subtotal])).rows[0].id;
  const order=await call('/orders',{method:'POST',token:customer.token,
    body:{restaurant_id:restaurant,address:'Recoger personalmente',tip,
      items:[{menu_item_id:item,quantity:1}],
      payment_method:'cash',order_type:'pickup',client_reference:'decimal-'+i}});
  assert.equal(order.status,201,JSON.stringify({i,order:order.json}));
  for(const field of ['subtotal','tip','platform_commission','service_fee',
                      'restaurant_payout','platform_revenue','contribution_margin','total']){
    const got=Number(order.json[field]).toFixed(2);
    assert.equal(got,expected[field],JSON.stringify({case:i,field,got,expected}));
  }
  const confirm=await call('/owner/orders/'+order.json.id+'/status',{
    method:'PATCH',token:merchant.token,body:{status:'confirmed'}});
  assert.equal(confirm.status,200,JSON.stringify({i,confirm:confirm.json}));
  const p10=await call('/orders/'+order.json.id+'/cancellation-preview',{token:customer.token});
  assert.equal(p10.status,200);
  assert.equal(p10.json.fee,expected.cancellation_confirmed,
    JSON.stringify({i,half_even:expected.cancellation_confirmed,fee:p10.json.fee}));
  const preparing=await call('/owner/orders/'+order.json.id+'/status',{
    method:'PATCH',token:merchant.token,body:{status:'preparing'}});
  assert.equal(preparing.status,200);
  const p30=await call('/orders/'+order.json.id+'/cancellation-preview',{token:customer.token});
  assert.equal(p30.status,200);
  assert.equal(p30.json.fee,expected.cancellation_preparing,
    JSON.stringify({i,half_even:expected.cancellation_preparing,fee:p30.json.fee}));
  const cancelled=await call('/orders/'+order.json.id+'/cancel',{
    method:'POST',token:customer.token});
  assert.equal(cancelled.status,200,JSON.stringify({i,cancelled:cancelled.json}));
  assert.equal(Number(cancelled.json.cancellation_fee).toFixed(2),
    expected.cancellation_preparing);
  const repeated=await call('/orders/'+order.json.id+'/cancel',{
    method:'POST',token:customer.token});
  assert.equal(repeated.status,200);
  assert.equal(repeated.json.id,order.json.id);
  const after=(await db.query(
    "SELECT stock FROM menu_items WHERE id=$1",[item])).rows[0];
  assert.equal(after.stock,1);
  created.push(order.json.id);
}
const events=await db.query(
  "SELECT count(*)::int n FROM order_events WHERE status='cancelled' AND order_id=ANY($1::int[])",
  [created]);
assert.equal(events.rows[0].n,created.length);
const ledger=await db.query(
  "SELECT count(*)::int n FROM financial_ledger_entries WHERE kind='order_cancellation' AND order_id=ANY($1::int[])",
  [created]);
assert.equal(ledger.rows[0].n,4*created.length);
console.log('PYTHON_NODE_DECIMAL_CASH_PICKUP_DIFF_VECTORS='+vectors.length);
console.log('PYTHON_NODE_CANCEL_HALF_EVEN_TIES=PASS');
console.log('PYTHON_NODE_CHECKOUT_HALF_UP_PARITY=PASS');
console.log('PYTHON_NODE_CANCELLATION_IDEMPOTENCY_AND_LEDGER=PASS');
await db.end();
