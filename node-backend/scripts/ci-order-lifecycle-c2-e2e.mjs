// C2 stage-only cancellation/merchant lifecycle E2E against disposable PG15.
// Do not run against Kali or any real financial database.
import assert from 'node:assert/strict';
import pg from 'pg';
const base='http://127.0.0.1:18190/api/v1';
const headers={'content-type':'application/json','x-talaeats-client':'customer-mobile'};
const password='Stage-Cancel-Test-Only-2026!';
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
async function call(path,{token,method='GET',body}={}){
  const response=await fetch(base+path,{method,
    headers:{...headers,...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  let json=null;try{json=await response.json();}catch{}
  return {status:response.status,json};
}
async function register(name){
  const email='stagecancel.'+process.pid+'.'+name+'@example.test';
  const created=await call('/auth/register',{method:'POST',body:{name:'C2 '+name,email,password}});
  assert.equal(created.status,201,JSON.stringify(created.json));
  return {id:created.json.user.id,email,token:created.json.access_token};
}
async function promote(u,role){
  await client.query('UPDATE users SET role=$1 WHERE id=$2',[role,u.id]);
  const res=await call('/auth/login',{method:'POST',body:{email:u.email,password}});
  assert.equal(res.status,200,JSON.stringify(res.json));
  u.token=res.json.access_token;
}
const owner=await register('owner');
const buyer=await register('buyer');
const stranger=await register('stranger');
const otherMerchant=await register('merchant2');
await client.connect();
await promote(owner,'restaurant');
await promote(otherMerchant,'restaurant');
const rest=await client.query(
  `INSERT INTO restaurants(name,address,is_open,pickup_enabled,owner_id)
   VALUES('C2 Shop','Tala Centro',true,true,$1) RETURNING id`,[owner.id]);
const rid=rest.rows[0].id;
const item=await client.query(
  `INSERT INTO menu_items(restaurant_id,name,price,stock)
   VALUES($1,'Carne 1 kg',40.00,10) RETURNING id`,[rid]);
const mid=item.rows[0].id;
const ingredient=await client.query(
  `INSERT INTO ingredient_stocks(restaurant_id,name,quantity,unit)
  VALUES($1,'Carne',10.000,'kg') RETURNING id`,[rid]);
const iid=ingredient.rows[0].id;
await client.query(
  'INSERT INTO menu_recipes(menu_item_id,ingredient_id,quantity_required) VALUES($1,$2,1.000)',
  [mid,iid]);
const intent=(ref)=>({restaurant_id:rid,address:'Recojo personalmente',payment_method:'cash',
  order_type:'pickup',client_reference:ref,items:[{menu_item_id:mid,quantity:1}],tip:'1.00'});
const create=async(ref)=>{
  const resp=await call('/orders',{token:buyer.token,method:'POST',body:intent(ref)});
  assert.equal(resp.status,201,JSON.stringify(resp.json));
  return resp.json.id;
};
const ownerStatus=(id,status,token=owner.token)=>call('/owner/orders/'+id+'/status',
  {method:'PATCH',token,body:{status}});
const cancel=(id,token=buyer.token)=>call('/orders/'+id+'/cancel',
  {method:'POST',token});
async function stock(){
  const menu=await client.query('SELECT stock FROM menu_items WHERE id=$1',[mid]);
  const recipe=await client.query('SELECT quantity FROM ingredient_stocks WHERE id=$1',[iid]);
  return {menu:menu.rows[0].stock,ingredient:recipe.rows[0].quantity};
}
async function cancelProof(id,expectedFee){
  const o=await client.query(
    'SELECT status,cancellation_fee,inventory_restored_at FROM orders WHERE id=$1',[id]);
  assert.equal(o.rows[0].status,'cancelled');
  assert.equal(o.rows[0].cancellation_fee,expectedFee);
  assert.ok(o.rows[0].inventory_restored_at);
  const events=await client.query(
    "SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND status='cancelled'",[id]);
  assert.equal(events.rows[0].n,1);
  const outbox=await client.query(
    'SELECT count(*)::int n FROM event_outbox WHERE event_key=$1',
    ['order:'+id+':cancelled']);
  assert.equal(outbox.rows[0].n,1);
  const original=await client.query(
    "SELECT account,direction,amount FROM financial_ledger_entries WHERE order_id=$1 AND kind='order_settlement' ORDER BY account",[id]);
  const reversed=await client.query(
    "SELECT account,direction,amount FROM financial_ledger_entries WHERE order_id=$1 AND kind='order_cancellation' ORDER BY account",[id]);
  assert.equal(original.rowCount,4);
  assert.equal(reversed.rowCount,4);
  for(let i=0;i<4;i++){
    assert.equal(original.rows[i].account,reversed.rows[i].account);
    assert.equal(original.rows[i].amount,reversed.rows[i].amount);
    assert.equal(original.rows[i].direction,'credit');
    assert.equal(reversed.rows[i].direction,'debit');
  }
}
const firstId=await create('cancel-atomic-1');
assert.deepEqual(await stock(),{menu:9,ingredient:'9.000'});
const unknown=await cancel(firstId,stranger.token);
assert.equal(unknown.status,404); // same response as nonexistent order
assert.equal((await call('/orders/9999999/cancel',{method:'POST',token:stranger.token})).status,404);
assert.equal((await cancel(firstId,owner.token)).status,403);
const preview=await call('/orders/'+firstId+'/cancellation-preview',{token:buyer.token});
assert.equal(preview.status,200);
assert.equal(preview.json.fee,'0.00');
assert.equal((await call('/orders/'+firstId+'/cancellation-preview',{token:stranger.token})).status,404);
const many=await Promise.all(Array.from({length:6},()=>cancel(firstId)));
assert.ok(many.every(x=>x.status===200&&x.json?.status==='cancelled'),
  JSON.stringify(many.map(x=>[x.status,x.json?.detail])));
assert.deepEqual(await stock(),{menu:10,ingredient:'10.000'});
await cancelProof(firstId,'0.00');
assert.equal((await ownerStatus(firstId,'confirmed')).status,409);
const confirmed=await create('cancel-atomic-2');
assert.equal((await ownerStatus(confirmed,'confirmed')).status,200);
assert.equal((await ownerStatus(confirmed,'confirmed')).status,409);
const cPrev=await call('/orders/'+confirmed+'/cancellation-preview',{token:buyer.token});
assert.equal(cPrev.status,200);
assert.equal(cPrev.json.fee,'4.00');
const cCancel=await cancel(confirmed);
assert.equal(cCancel.status,200,JSON.stringify(cCancel.json));
await cancelProof(confirmed,'4.00');
assert.deepEqual(await stock(),{menu:10,ingredient:'10.000'});
const preparing=await create('cancel-atomic-3');
assert.equal((await ownerStatus(preparing,'confirmed')).status,200);
assert.equal((await ownerStatus(preparing,'preparing')).status,200);
const pPrev=await call('/orders/'+preparing+'/cancellation-preview',{token:buyer.token});
assert.equal(pPrev.json.fee,'12.00');
assert.equal((await ownerStatus(preparing,'cancelled',otherMerchant.token)).status,403);
const merchantCancelled=await ownerStatus(preparing,'cancelled');
assert.equal(merchantCancelled.status,200,JSON.stringify(merchantCancelled.json));
assert.equal(Object.hasOwn(merchantCancelled.json,'delivery_pin'),false);
await cancelProof(preparing,'0.00'); // merchant-initiated cancellation doesn't charge customer
assert.deepEqual(await stock(),{menu:10,ingredient:'10.000'});
const ready=await create('cancel-atomic-4');
assert.equal((await ownerStatus(ready,'confirmed')).status,200);
assert.equal((await ownerStatus(ready,'preparing')).status,200);
assert.equal((await ownerStatus(ready,'ready')).status,200);
const kds=await call('/owner/kds',{token:owner.token});
assert.equal(kds.status,200);
assert.ok(kds.json.ready.some(x=>x.id===ready));
assert.equal((await cancel(ready)).status,400); // beyond self-service cancellation
assert.equal((await ownerStatus(ready,'ready')).status,409);
assert.equal((await ownerStatus(ready,'on_the_way')).status,503);
assert.equal((await call('/orders/'+ready+'/cancellation-preview',{token:buyer.token})).json.cancellable,false);
// Invalid recipe snapshot must fail closed and atomically rollback the entire
// cancellation. Restore valid snapshot then allow cancellation.
const corrupted=await create('cancel-atomic-5');
await client.query("UPDATE orders SET inventory_reserved_json='broken-json' WHERE id=$1",[corrupted]);
const before=await stock();
const bad=await cancel(corrupted);
assert.equal(bad.status,503);
assert.deepEqual(await stock(),before);
assert.equal((await client.query('SELECT status FROM orders WHERE id=$1',[corrupted])).rows[0].status,'received');
await client.query('UPDATE orders SET inventory_reserved_json=$1 WHERE id=$2',
  [JSON.stringify({[iid]:'1.000'}),corrupted]);
assert.equal((await cancel(corrupted)).status,200);
await cancelProof(corrupted,'0.00');
// Race between authorized customer cancel and owner state transition cannot
// duplicate stock. Only one cancelled event and reversal group can exist.
const racing=await create('cancel-atomic-6');
const results=await Promise.all([cancel(racing),ownerStatus(racing,'confirmed')]);
assert.ok(results.every(x=>x.status===200||x.status===409),
  JSON.stringify(results.map(x=>[x.status,x.json?.detail])));
assert.equal((await call('/orders/'+racing,{token:buyer.token})).json.status,'cancelled');
await cancelProof(racing,results[1].status===200?'4.00':'0.00');
assert.deepEqual(await stock(),{menu:9,ingredient:'9.000'}); // ready order only
const finalOrders=await client.query(
 "SELECT COUNT(*)::int n FROM orders WHERE restaurant_id=$1 AND status='cancelled'",[rid]);
assert.equal(finalOrders.rows[0].n,5);
const buyerOrders=await call('/orders/mine',{token:buyer.token});
assert.ok(buyerOrders.json.find(x=>x.id===firstId && x.status==='cancelled'));
console.log('NODE_C2_ATOMIC_CANCELLATION_RESTORE_ONCE_CONCURRENT=PASS');
console.log('NODE_C2_COMPENSATING_IMMUTABLE_LEDGER_OUTBOX=PASS');
console.log('NODE_C2_OWNER_STATUS_AND_RBAC=PASS');
console.log('NODE_C2_FAILED_RESTORE_ROLLBACK_AND_NO_LIVE=PASS');
await client.end();
