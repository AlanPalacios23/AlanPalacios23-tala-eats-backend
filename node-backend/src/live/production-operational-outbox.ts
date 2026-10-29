/**
 * RC12.0: process NON-FINANCIAL Node outbox notifications.
 * At least once: Redis publish and PostgreSQL COMMIT cannot be atomic;
 * clients must always re-read real order state, not trust events as receipts.
 * Stripe, billing, refunds, payouts and treasury are NEVER dispatched here.
 */
import type {Pool} from 'pg';
import type {Redis} from 'ioredis';
const MAX_BATCH=10,MAX_ATTEMPTS=5,MAX_PAYLOAD=8192;
type OutboxRow={
 id:number;aggregate_id:string;aggregate_type:string;event_type:string;
 payload_json:string;attempts:number;
};
type PublishCommand={kind:'order';channel:string;message:string}|
 {kind:'catalog';key:string};
export function interpretLiveOperationalEvent(row:OutboxRow):PublishCommand|null{
 if(!Number.isSafeInteger(row.id)||row.id<1||
    typeof row.event_type!=='string'||typeof row.payload_json!=='string')
  return null;
 if(row.event_type==='catalog.changed'&&
    row.aggregate_type==='catalog'&&row.payload_json.length<=MAX_PAYLOAD)
  return {kind:'catalog',key:'talaeats:cache:catalog:version'};
 if(row.aggregate_type!=='order'||
    !/^order\.[a-z][a-z0-9_]{1,40}$/.test(row.event_type)||
    !/^[1-9][0-9]{0,9}$/.test(row.aggregate_id)||
    row.payload_json.length>MAX_PAYLOAD)return null;
 const orderId=Number(row.aggregate_id);
 if(!Number.isSafeInteger(orderId))return null;
 let obj:unknown;
 try{obj=JSON.parse(row.payload_json);}catch{return null;}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))return null;
 const input=obj as Record<string,unknown>;
 if('order_id'in input&&input.order_id!==orderId)return null;
 // Never forward accidental PII or financial secrets from outbox JSON.
 const data:Record<string,string|number>={};
 for(const field of ['status','payment_status']){
  const v=input[field];
  if(typeof v==='string'&&/^[a-z_]{2,40}$/.test(v))data[field]=v;
 }
 for(const field of ['restaurant_id','driver_id','user_id']){
  const v=input[field];
  if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=1)data[field]=v;
 }
 return {kind:'order',channel:'talaeats:order:'+orderId,
  message:JSON.stringify({order_id:orderId,event:row.event_type,data})};
}
export type OperationalOutboxResult={
 scanned:number;published:number;retried:number;dead:number;skipped:number;
};
export async function drainLiveOperationalOutbox(
 pool:Pick<Pool,'connect'>,redis:Pick<Redis,'publish'|'incr'>,
 batch=MAX_BATCH,
):Promise<OperationalOutboxResult>{
 if(!Number.isSafeInteger(batch)||batch<1||batch>MAX_BATCH)
  throw Error('OPERATIONAL_OUTBOX_BATCH_OUT_OF_RANGE');
 const client=await pool.connect();
 let transaction=false;
 const result:OperationalOutboxResult={scanned:0,published:0,retried:0,dead:0,skipped:0};
 try{
  await client.query('BEGIN');transaction=true;
  const selected=await client.query<OutboxRow>(
   "SELECT id,aggregate_id,aggregate_type,event_type,payload_json,attempts FROM event_outbox "+
   "WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=NOW()) "+
   "AND ((aggregate_type='order' AND event_type LIKE 'order.%') "+
   "OR (aggregate_type='catalog' AND event_type='catalog.changed')) "+
   "ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",[batch]);
  for(const row of selected.rows){
   result.scanned++;
   const command=interpretLiveOperationalEvent(row);
   if(!command){result.skipped++;continue;} // retain malformed records for review
   const tries=Number.isSafeInteger(row.attempts)&&row.attempts>=0?
    row.attempts+1:MAX_ATTEMPTS;
   try{
    if(command.kind==='order')await redis.publish(command.channel,command.message);
    else await redis.incr(command.key);
    const posted=await client.query(
     "UPDATE event_outbox SET status='published',attempts=$2, "+
     "published_at=NOW(),locked_at=NULL,next_attempt_at=NULL,last_error='' "+
     "WHERE id=$1 AND status IN ('pending','retry')",[row.id,tries]);
    if(posted.rowCount!==1)throw Error('OPERATIONAL_OUTBOX_CAS_FAILED');
    result.published++;
   }catch{
    if(tries>=MAX_ATTEMPTS){
     await client.query(
      "INSERT INTO dead_letter_jobs "+
       "(source,source_id,kind,payload_json,error,attempts,status,created_at) "+
      "VALUES('event_outbox',$1,$2,$3,'Operational notification not delivered',$4,'open',NOW())",
      [String(row.id),row.event_type,row.payload_json,tries]);
     await client.query(
      "UPDATE event_outbox SET status='dead',attempts=$2,locked_at=NULL, "+
      "last_error='Operational notification needs manual review' "+
      "WHERE id=$1 AND status IN ('pending','retry')",[row.id,tries]);
     result.dead++;
    }else{
     const delaySeconds=Math.min(3600,5*2**Math.min(tries-1,8));
     await client.query(
      "UPDATE event_outbox SET status='retry',attempts=$2,locked_at=NULL, "+
      "next_attempt_at=NOW()+($3::integer * INTERVAL '1 second'), "+
      "last_error='Operational delivery temporarily unavailable' "+
      "WHERE id=$1 AND status IN ('pending','retry')",
      [row.id,tries,delaySeconds]);
     result.retried++;
    }
   }
  }
  await client.query('COMMIT');transaction=false;
  return result;
 }catch(err){
  if(transaction)await client.query('ROLLBACK').catch(()=>{});
  throw err;
 }finally{client.release();}
}
