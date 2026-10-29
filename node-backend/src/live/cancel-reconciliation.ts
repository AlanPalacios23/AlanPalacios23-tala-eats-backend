/**
 * Final Stripe LIVE PI cancellation recovery. Never creates a cancellation,
 * charge, refund, transfer, payout or new order.
 *
 * Only after a signed/durable payment_intent.canceled event AND a fresh,
 * authenticated Stripe GET confirming canceled + amount_received=0, release
 * the reserved pickup inventory in the SAME PostgreSQL transaction as order
 * cancellation and webhook receipt acknowledgement.
 */
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {LiveGateError} from './guard.js';
import {isRealLiveCheckoutProvenance} from '../marketplace/live-delivery-policy.js';

type Provider=Pick<Stripe,'events'|'paymentIntents'>;
type Order={
  id:number;user_id:number;restaurant_id:number;status:string;
  payment_status:string;payment_provider_id:string;payment_method:string;
  payment_provider:string;order_type:string;total:string;
  refunded_amount:string;inventory_reserved_json:string;
  inventory_restored_at:Date|null;
};
const error=(reason:string):never=>{throw new LiveGateError(reason);};
const money=/^(?:0|[1-9]\d{0,7})\.\d{2}$/;
const minor=(v:string):number=>{
  if(!money.test(v))return error('LIVE_CANCEL_AMOUNT_INVALID');
  const [a,b]=v.split('.');return Number(a)*100+Number(b);
};
const milli=(v:string):string=>{
  if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,3})?$/.test(v))
    return error('LIVE_CANCEL_INGREDIENT_INVALID');
  const [a,b='']=v.split('.');
  const units=BigInt(a!)*1000n+BigInt((b+'000').slice(0,3));
  if(units<=0n)return error('LIVE_CANCEL_INGREDIENT_NONPOSITIVE');
  return (units/1000n)+'.'+(units%1000n).toString().padStart(3,'0');
};

export async function reconcileRecordedLiveCanceledIntent(
 eventId:string,provider:Provider,pool:Pool
):Promise<{received:true;alreadyProcessed:boolean;stockRestored:boolean}>{
 if(!/^evt_[A-Za-z0-9]+$/.test(eventId))return error('BAD_LIVE_CANCEL_EVENT');
 const found=await pool.query<{type:string;objectId:string;stripeAccountId:string|null}>(
  'SELECT type,"objectId","stripeAccountId" FROM stripe_webhook_events WHERE id=$1',[eventId]);
 const entry=found.rows[0];
 if(!entry||entry.type!=='payment_intent.canceled'||entry.stripeAccountId!==null||
    !/^pi_[A-Za-z0-9]+$/.test(entry.objectId))
   return error('SIGNED_CANCELLATION_MISSING');
 const event=await provider.events.retrieve(eventId);
 if(!event.livemode||event.account||event.id!==eventId||
    event.type!==entry.type||
    (event.data.object as {id?:string}).id!==entry.objectId)
   return error('STRIPE_CANCEL_EVENT_IDENTITY_MISMATCH');
 const pi=await provider.paymentIntents.retrieve(entry.objectId);
 const orderId=Number(pi.metadata.order_id);
 const buyerId=Number(pi.metadata.buyer_id);
 const fulfillment=pi.metadata.tala_mode==='rc8_live_delivery'?'delivery':
   pi.metadata.tala_mode==='rc8_live_pickup'?'pickup':null;
 if(!pi.livemode||pi.id!==entry.objectId||pi.status!=='canceled'||
    pi.amount_received!==0||pi.currency!=='mxn'||
    !fulfillment||
    !/^[1-9][0-9]{0,9}$/.test(pi.metadata.order_id??'')||
    !/^[1-9][0-9]{0,9}$/.test(pi.metadata.buyer_id??'')||
    !Number.isSafeInteger(orderId)||!Number.isSafeInteger(buyerId)||
    !Number.isSafeInteger(pi.amount)||pi.amount<100)
   return error('PI_NOT_PROVEN_UNPAID_CANCELED');

 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const receipts=await client.query<{type:string;objectId:string;status:string}>(
   'SELECT type,"objectId",status FROM stripe_webhook_events WHERE id=$1 AND "stripeAccountId" IS NULL FOR UPDATE',[eventId]);
  const receipt=receipts.rows[0];
  if(!receipt||receipt.type!==entry.type||receipt.objectId!==entry.objectId)
    return error('CANCEL_RECEIPT_CHANGED');
  if(receipt.status==='PROCESSED'){
   await client.query('COMMIT');
   return {received:true,alreadyProcessed:true,stockRestored:false};
  }
  const foundOrder=await client.query<Order>(
   'SELECT id,user_id,restaurant_id,status,payment_status,payment_provider_id,payment_method,payment_provider,order_type,total::text,refunded_amount::text,inventory_restored_at,inventory_reserved_json FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
  const o=foundOrder.rows[0];
  if(!o||o.user_id!==buyerId||o.payment_method!=='stripe'||
     o.payment_provider!=='stripe'||o.order_type!==fulfillment||
     o.payment_provider_id!==pi.id||minor(o.total)!==pi.amount||
     minor(o.refunded_amount)!==0)
    return error('CANCELED_ORDER_BINDING_MISMATCH');
  // Never release an unpaid delivery reservation that did not originate in
  // the same server-side signed customer checkout used for card capture.
  if(fulfillment==='delivery'){
    const marker=await client.query<{metadata_json:string}>(
      "SELECT metadata_json FROM order_events WHERE order_id=$1 AND status='received' ORDER BY id LIMIT 1 FOR SHARE",[orderId]);
    if(!isRealLiveCheckoutProvenance(marker.rows[0]?.metadata_json??null))
      return error('LIVE_DELIVERY_CANCEL_ORIGIN_INVALID');
  }
  if(o.status==='cancelled'&&o.inventory_restored_at!==null){
   await client.query('UPDATE stripe_webhook_events SET status=$2,"processedAt"=NOW() WHERE id=$1',
    [eventId,'PROCESSED']);
   await client.query('COMMIT');
   return {received:true,alreadyProcessed:true,stockRestored:false};
  }
  if(o.status!=='awaiting_payment'||o.payment_status!=='pending'||
     o.inventory_restored_at!==null)
    return error('CANCEL_ORDER_NOT_PENDING');
  // Any posted financial ledger means we cannot safely undo a captured
  // payment/settlement or release this stock without an operator.
  const ledger=await client.query<{id:number}>(
   'SELECT id FROM financial_ledger_entries WHERE order_id=$1 LIMIT 1 FOR UPDATE',
   [orderId]);
  if(ledger.rowCount!==0)return error('CANCEL_ORDER_HAS_FINANCIAL_LEDGER');

  const lines=await client.query<{menu_item_id:number|null;quantity:number}>(
   'SELECT menu_item_id,quantity FROM order_items WHERE order_id=$1 ORDER BY menu_item_id,id FOR UPDATE',[orderId]);
  if(lines.rows.length===0)return error('CANCEL_NO_ORDER_ITEMS');
  const quantities=new Map<number,number>();
  for(const line of lines.rows){
   if(!Number.isSafeInteger(line.menu_item_id)||!Number.isSafeInteger(line.quantity)||
      (line.menu_item_id??0)<=0||line.quantity<=0||line.quantity>1000)
     return error('CANCEL_INVALID_ORDER_ITEM');
   const id=line.menu_item_id!;
   const n=(quantities.get(id)??0)+line.quantity;
   if(n>100000)return error('CANCEL_ITEM_QUANTITY_OVERFLOW');
   quantities.set(id,n);
  }
  let raw:unknown;
  try{raw=JSON.parse(o.inventory_reserved_json);}
  catch{return error('CANCEL_INGREDIENT_SNAPSHOT_INVALID');}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))
    return error('CANCEL_INGREDIENT_SNAPSHOT_INVALID');
  const ingredients=new Map<number,string>();
  for(const [idText,amount] of Object.entries(raw as Record<string,unknown>)){
   if(!/^[1-9][0-9]*$/.test(idText)||!Number.isSafeInteger(Number(idText))||
      typeof amount!=='string')
     return error('CANCEL_INGREDIENT_SNAPSHOT_INVALID');
   ingredients.set(Number(idText),milli(amount));
  }
  for(const [id,quantity] of [...quantities.entries()].sort((a,b)=>a[0]-b[0])){
   const updated=await client.query(
    'UPDATE menu_items SET stock=stock+$1 WHERE id=$2 AND restaurant_id=$3 AND stock<=2147483647-$1 RETURNING id',
    [quantity,id,o.restaurant_id]);
   if(updated.rowCount!==1)return error('CANCEL_MENU_STOCK_UNRESTORABLE');
  }
  for(const [id,quantity] of [...ingredients.entries()].sort((a,b)=>a[0]-b[0])){
   const updated=await client.query(
    'UPDATE ingredient_stocks SET quantity=quantity+$1::numeric WHERE id=$2 AND restaurant_id=$3 RETURNING id',
    [quantity,id,o.restaurant_id]);
   if(updated.rowCount!==1)return error('CANCEL_INGREDIENT_UNRESTORABLE');
  }
  const done=await client.query(
   "UPDATE orders SET status='cancelled',payment_status='canceled',inventory_restored_at=NOW(),cancelled_reason='Stripe confirmó cancelación sin captura' WHERE id=$1 AND status='awaiting_payment' AND payment_status='pending' AND inventory_restored_at IS NULL RETURNING id",
   [orderId]);
  if(done.rowCount!==1)return error('CANCEL_ORDER_CAS_FAILED');
  await client.query(
   "INSERT INTO order_events(order_id,status,actor_user_id,metadata_json,created_at) VALUES($1,'cancelled',$2,$3,NOW())",
   [orderId,buyerId,JSON.stringify({source:'stripe_live_cancel_verified',stripe_event_id:eventId})]);
  await client.query(
   "INSERT INTO event_outbox(event_key,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,last_error,created_at) VALUES($1,'order',$2,'order.canceled',$3,'pending',0,'',NOW())",
   ['order:'+orderId+':stripe-live-canceled',String(orderId),
    JSON.stringify({order_id:orderId,status:'cancelled',payment_status:'canceled',provider:'stripe_live'})]);
  await client.query(
   'UPDATE stripe_webhook_events SET status=$2,"processedAt"=NOW() WHERE id=$1',
   [eventId,'PROCESSED']);
  await client.query('COMMIT');
  return {received:true,alreadyProcessed:false,stockRestored:true};
 }catch(e){
  await client.query('ROLLBACK').catch(()=>{});
  throw e;
 }finally{client.release();}
}
