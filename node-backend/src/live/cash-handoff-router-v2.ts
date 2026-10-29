/** RC13.5 physical cash custody only; NEVER means paid to bank. */
import {Router} from 'express';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
import {current} from '../auth/routes.js';
import {config} from '../config.js';

const id=(raw:unknown)=>{
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,9}$/.test(raw))throw Error('INVALID_ID');
 return Number(raw);
};
const amount=(v:unknown)=>{
 if(typeof v!=='string'||!/^[1-9][0-9]{0,9}$/.test(v))throw Error('INVALID_AMOUNT');
 return v;
};
const codeHash=(orderId:number,code:string)=>createHash('sha256')
 .update('TALA_CASH_HANDOFF_V2:'+orderId+':'+code).digest('hex');
const sameHash=(a:string,b:string)=>{
 if(!/^[0-9a-f]{64}$/.test(a)||!/^[0-9a-f]{64}$/.test(b))return false;
 return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
};
export function buildCashHandoffV2Router(pool:Pool){
 const router=Router();
 router.use((_req,res,next)=>{
  res.setHeader('Cache-Control','private, no-store');next();
 });
 router.post('/driver/finance/cash-handoff/:orderId/start',async(req,res)=>{
  if(config.NODE_ENV!=='production'||config.LIVE_CASH_HANDOFF_V2_ENABLED!=='true')
   {res.status(503).json({error:'CASH_HANDOFF_DISABLED'});return;}
  const client=await pool.connect();let tx=false;
  try{
   const actor=await current(req);
   if(actor.user.role!=='driver'||!actor.user.isActive)
    {res.status(403).json({error:'DRIVER_REQUIRED'});return;}
   const orderId=id(req.params.orderId);
   await client.query('BEGIN');tx=true;
   const rows=await client.query<{restaurant_id:number;driver_id:number;
    status:string;payment_method:string;payment_status:string;
    total_minor:string;collected_minor:string;refunded_minor:string;
    collector_kind:string;collector_id:number;custody_minor:string}>(
    'SELECT o.restaurant_id,o.driver_id,o.status,o.payment_method,o.payment_status,'+
    'round(o.total*100)::text AS total_minor,round(o.cash_collected*100)::text AS collected_minor,'+
    'round(o.refunded_amount*100)::text AS refunded_minor,c.collector_kind,'+
    'c.collector_id,c.collected_minor::text AS custody_minor '+
    'FROM orders o JOIN tala_live_cash_custody c ON c.order_id=o.id '+
    'WHERE o.id=$1 AND o.delivered_at>NOW()-INTERVAL \'24 hours\' FOR UPDATE OF o',[orderId]);
   const o=rows.rows[0];
   if(!o||o.driver_id!==actor.userId||o.status!=='delivered'||
    o.payment_method!=='cash'||o.payment_status!=='paid'||
    o.refunded_minor!=='0'||o.total_minor!==o.collected_minor||
    o.total_minor!==o.custody_minor||
    o.collector_kind!=='driver'||o.collector_id!==actor.userId)
    throw Error('CASH_ORDER_CUSTODY_NOT_VALID');
   const [profile,cases]=await Promise.all([
    client.query('SELECT user_id FROM driver_profiles WHERE user_id=$1 AND is_verified=true',[actor.userId]),
    client.query("SELECT id FROM tala_live_financial_cases WHERE order_id=$1 AND status<>'resolved' LIMIT 1",[orderId])
   ]);
   if(profile.rows.length!==1||cases.rows.length!==0)
    throw Error('CASH_DRIVER_OR_FINANCIAL_HOLD');
   const code=randomBytes(10).toString('hex');
   const result=await client.query(
    'INSERT INTO finance_cash_handoffs_v2(order_id,restaurant_id,driver_user_id,expected_minor,handoff_code_hash) '+
    'VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id) DO NOTHING RETURNING order_id',
    [orderId,o.restaurant_id,actor.userId,o.total_minor,codeHash(orderId,code)]);
   if(result.rowCount!==1)throw Error('HANDOFF_ALREADY_STARTED_CONTACT_ADMIN');
   await client.query(
    'INSERT INTO finance_cash_handoff_events_v2(event_key,order_id,actor_user_id,action,amount_minor) '+
    "VALUES($1,$2,$3,'initiated',$4)",
    ['cash-handoff:'+orderId+':initiated',orderId,actor.userId,o.total_minor]);
   await client.query('COMMIT');tx=false;
   res.status(201).json({order_id:orderId,amount_cents:o.total_minor,
    code,valid_for_minutes:60,state:'awaiting_restaurant_confirmation',
    driver_pay_executed:false,bank_settlement_verified:false});
  }catch{
   if(tx)await client.query('ROLLBACK').catch(()=>{});
   res.status(409).json({error:'CASH_HANDOFF_NOT_ELIGIBLE_OR_ALREADY_EXISTS'});
  }finally{client.release();}
 });
 router.post('/owner/finance/cash-handoff/:orderId/confirm',async(req,res)=>{
  if(config.NODE_ENV!=='production'||config.LIVE_CASH_HANDOFF_V2_ENABLED!=='true')
   {res.status(503).json({error:'CASH_HANDOFF_DISABLED'});return;}
  const client=await pool.connect();let tx=false;
  try{
   const actor=await current(req);
   if(actor.user.role!=='restaurant'||!actor.user.isActive)
    {res.status(403).json({error:'RESTAURANT_OWNER_REQUIRED'});return;}
   const orderId=id(req.params.orderId);
   const cents=amount(req.body?.amount_cents);
   const code=req.body?.code;
   if(typeof code!=='string'||!/^[0-9a-f]{20}$/.test(code))
    {res.status(422).json({error:'CASH_HANDOFF_CODE_INVALID'});return;}
   await client.query('BEGIN');tx=true;
   const rows=await client.query<{restaurant_id:number;driver_user_id:number;
    expected_minor:string;handoff_code_hash:string;status:string;
    initiated_at:Date;owner_id:number}>(
    'SELECT h.restaurant_id,h.driver_user_id,h.expected_minor::text,'+
    'h.handoff_code_hash,h.status,h.initiated_at,r.owner_id '+
    'FROM finance_cash_handoffs_v2 h JOIN restaurants r ON r.id=h.restaurant_id '+
    'WHERE h.order_id=$1 FOR UPDATE OF h',[orderId]);
   const h=rows.rows[0];
   if(!h||h.owner_id!==actor.userId||h.driver_user_id===actor.userId||
    h.status!=='initiated'||h.expected_minor!==cents||
    !sameHash(h.handoff_code_hash,codeHash(orderId,code))||
    Date.now()-new Date(h.initiated_at).getTime()>3600000||
    new Date(h.initiated_at).getTime()>Date.now()+30000)
    throw Error('CASH_HANDOFF_CONFIRMATION_FAILED');
   const changed=await client.query(
    "UPDATE finance_cash_handoffs_v2 SET status='confirmed',acknowledged_by_owner_id=$2,acknowledged_at=NOW() "+
    "WHERE order_id=$1 AND status='initiated' RETURNING order_id",
    [orderId,actor.userId]);
   if(changed.rowCount!==1)throw Error('CASH_HANDOFF_RACE');
   await client.query(
    'INSERT INTO finance_cash_handoff_events_v2(event_key,order_id,actor_user_id,action,amount_minor) '+
    "VALUES($1,$2,$3,'confirmed',$4)",
    ['cash-handoff:'+orderId+':confirmed',orderId,actor.userId,cents]);
   await client.query('COMMIT');tx=false;
   res.json({order_id:orderId,state:'confirmed_merchant_physical_receipt',
    amount_cents:cents,bank_settlement_verified:false,
    driver_pay_executed:false,stripe_transfer_executed:false});
  }catch{
   if(tx)await client.query('ROLLBACK').catch(()=>{});
   res.status(409).json({error:'CASH_HANDOFF_CONFIRMATION_HOLD'});
  }finally{client.release();}
 });
 return router;
}
