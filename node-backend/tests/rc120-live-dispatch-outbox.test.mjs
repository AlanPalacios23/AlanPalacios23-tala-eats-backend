import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {interpretLiveOperationalEvent,drainLiveOperationalOutbox}
 from '../src/live/production-operational-outbox.ts';

const read=(path)=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
const order=(patch={})=>({
 id:7,aggregate_id:'42',aggregate_type:'order',event_type:'order.assigned',
 attempts:0,payload_json:JSON.stringify({
  order_id:42,status:'assigned',driver_id:99,address:'PRIVATE STREET',
  payment_intent_secret:'sk_live_PRIVATE'
 }),...patch,
});
function fake(rows,redisFails=false){
 const sql=[];
 const pool={connect:async()=>({
  query:async(text,params)=>{
   sql.push([text,params]);
   if(text.startsWith('SELECT'))return {rows};
   if(text.startsWith('UPDATE'))return {rowCount:1};
   return {rowCount:1};
  },
  release:()=>{},
 })};
 const published=[];
 const redis={
  publish:async(channel,value)=>{
   if(redisFails)throw Error('Redis unavailable');
   published.push({channel,value});return 1;
  },
  incr:async(key)=>{if(redisFails)throw Error('Redis unavailable');
   published.push({key});return 1;},
 };
 return {pool,redis,published,sql};
}
test('RC12 LIVE cash READY dispatch checks independent release + real tender',()=>{
 const driver=read('marketplace/driver.ts');
 const worker=read('marketplace/live-delivery-dispatch.ts');
 const fn=driver.slice(driver.indexOf('export async function dispatchStageDeliveryReady('));
 assert.ok(fn.includes('(liveDispatchReleased()||liveCashDeliveryReleased())'));
 assert.ok(driver.includes('await liveCashDeliveryTenderAllowed(tx,row)'));
 assert.ok(driver.includes('FOR UPDATE SKIP LOCKED'));
 assert.ok(worker.includes('liveCashDeliveryReleased()'));
 assert.ok(worker.includes('dispatchStageDeliveryReady(row.id)'));
 const liveWorker=read('live/production-worker.ts');
 assert.ok(liveWorker.includes('await sweepLiveDeliveryReady()'));
});
test('RC12 ignores fraudulent events and never emits PII or Stripe keys',()=>{
 const cmd=interpretLiveOperationalEvent(order());
 assert.equal(cmd.kind,'order');
 assert.equal(cmd.channel,'talaeats:order:42');
 assert.deepEqual(JSON.parse(cmd.message),{
  order_id:42,event:'order.assigned',data:{status:'assigned',driver_id:99}
 });
 for(const invalid of [
  order({aggregate_id:'not-an-id'}),
  order({aggregate_type:'payment'}),
  order({event_type:'payout.created'}),
  order({event_type:'payment.captured'}),
  order({payload_json:'{}',aggregate_id:'0'}),
  order({payload_json:JSON.stringify({order_id:43})}),
  order({payload_json:'this is not json'}),
 ])assert.equal(interpretLiveOperationalEvent(invalid),null);
});
test('RC12 sends order redis PubSub and publishes status in PostgreSQL only after ACK',async()=>{
 const m=fake([order()]);
 const result=await drainLiveOperationalOutbox(m.pool,m.redis,10);
 assert.deepEqual(result,{scanned:1,published:1,retried:0,dead:0,skipped:0});
 assert.equal(m.published.length,1);
 const sql=m.sql.map(([q])=>q);
 assert.equal(sql[0],'BEGIN');
 assert.ok(sql[1].includes('FOR UPDATE SKIP LOCKED'));
 assert.ok(sql[2].includes("status='published'"));
 assert.equal(sql[3],'COMMIT');
 assert.equal(sql.filter(s=>s.includes("UPDATE orders ")).length,0);
});
test('RC12 Redis outage does not claim published and schedules bounded retry',async()=>{
 const m=fake([order()],true);
 const result=await drainLiveOperationalOutbox(m.pool,m.redis,10);
 assert.equal(result.retried,1);
 assert.equal(result.published,0);
 const update=m.sql.find(([q])=>q.includes("status='retry'"));
 assert.ok(update);
 assert.deepEqual(update[1],[7,1,5]);
 assert.equal(m.sql.at(-1)[0],'COMMIT');
});
test('RC12 fifth failed notification retains dead letter without losing event',async()=>{
 const m=fake([order({attempts:4})],true);
 const result=await drainLiveOperationalOutbox(m.pool,m.redis,10);
 assert.equal(result.dead,1);
 assert.equal(m.sql.filter(([q])=>q.startsWith('INSERT INTO dead_letter_jobs')).length,1);
 assert.equal(m.sql.filter(([q])=>q.includes("status='dead'")).length,1);
});
test('RC12 catalog invalidation is supported; unknown non-financial events are untouched',async()=>{
 const m=fake([
  order({id:8,aggregate_type:'catalog',event_type:'catalog.changed',payload_json:'{}'}),
  order({id:9,payload_json:'not-json'}),
 ]);
 const result=await drainLiveOperationalOutbox(m.pool,m.redis,10);
 assert.deepEqual(result,{scanned:2,published:1,retried:0,dead:0,skipped:1});
 assert.deepEqual(m.published,[{key:'talaeats:cache:catalog:version'}]);
 const source=read('live/production-operational-outbox.ts');
 assert.doesNotMatch(source,/(?:stripe\.(?:transfers|payouts|refunds|charges|paymentIntents)|withdrawals|financial_ledger_entries)/i);
 const active=read('live/production-worker.ts');
 assert.ok(active.includes('operationalOutboxTimer'));
 assert.ok(active.includes('clearInterval(operationalOutboxTimer)'));
});
