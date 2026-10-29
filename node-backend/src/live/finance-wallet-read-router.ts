// RC13.4 read-only earnings per account and week. ALL payout amounts remain HOLD.
// No balance can be inferred from these projections; no banking/Stripe writes.
import {Router,type Request} from 'express';
import type {Pool} from 'pg';
import {current} from '../auth/routes.js';

export type WalletKind='restaurant'|'driver';
const value=(v:unknown)=>typeof v==='string'?v:'';
export function mondayWeek(raw:unknown):string{
 const week=value(raw);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(week))throw Error('WALLET_WEEK_FORMAT_INVALID');
 const day=new Date(week+'T00:00:00Z');
 if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==week||
    day.getUTCDay()!==1)throw Error('WALLET_WEEK_MUST_BE_MONDAY');
 return week;
}
export function currentMexicoWeek(now:Date):string{
 const local=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',
  year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const day=new Date(local+'T00:00:00Z');
 const diff=(day.getUTCDay()+6)%7;
 day.setUTCDate(day.getUTCDate()-diff);
 return day.toISOString().slice(0,10);
}
const asCents=(v:string):bigint=>{
 if(!/^\d{1,16}$/.test(v))throw Error('WALLET_CENTS_INVALID');
 return BigInt(v);
};
export type WeeklyLedgerRow={order_id:number;amount_minor:string;state:string;
 tender:string;fulfillment:string;delivered_at:Date;
 custody_collector_kind:string|null;custody_collector_id:number|null;
 custody_collected_minor:string|null;custody_status:string|null;
 open_financial_cases:string;};
export function summarizeWalletRows(kind:WalletKind,id:number,week:string,rows:readonly WeeklyLedgerRow[]){
 let recorded=0n,held=0n,cashInTransit=0n,cashAtMerchantUnverified=0n;
 const items=rows.map(x=>{
  const amount=asCents(x.amount_minor);recorded+=amount;
  if(x.state!=='settled')held+=amount;
  const cash=x.tender==='cash'&&x.custody_collected_minor!==null?
    asCents(x.custody_collected_minor):0n;
  const transit=x.custody_collector_kind==='driver'?
    cash:0n;
  if(kind==='driver'&&x.custody_collector_id===id)cashInTransit+=transit;
  if(kind==='restaurant'&&x.custody_collector_kind==='restaurant'&&
    x.custody_collector_id===id)cashAtMerchantUnverified+=cash;
  const reasons:string[]=[];
  if(x.state!=='settled')reasons.push('ALLOCATION_UNSETTLED');
  if(x.tender==='cash')reasons.push('CASH_CUSTODY_NOT_BANK_SETTLED');
  if(x.tender==='stripe')reasons.push('STRIPE_AVAILABLE_NOT_PROVEN');
  if(BigInt(x.open_financial_cases)>0n)reasons.push('OPEN_FINANCIAL_CASE');
  return {order_id:x.order_id,earned_cents:amount.toString(),
   allocation_state:x.state,payment_method:x.tender,fulfillment:x.fulfillment,
   delivered_at:x.delivered_at,cash_collector_kind:x.custody_collector_kind,
   cash_collector_id:x.custody_collector_id,cash_custody_status:x.custody_status,
   financial_hold_reasons:reasons};
 });
 return {currency:'MXN',unit:'centavos',kind,payee_id:id,
  period_start:week,period_timezone:'America/Mexico_City',
  recorded_earnings_cents:recorded.toString(),
  pending_allocation_cents:held.toString(),
  cash_in_driver_custody_cents:cashInTransit.toString(),
  cash_in_merchant_custody_unverified_cents:cashAtMerchantUnverified.toString(),
  withdrawable_cents:'0',bank_payout_confirmed:false,
  payment_to_bank_status:'NOT_RECONCILED',
  status:'READ_ONLY_NOT_BANK_RECONCILED',
  fiscal_document_issued:false,
  items};
}
function forbidden(res:import('express').Response){
 res.status(403).json({error:'WALLET_PAYEE_NOT_AUTHORIZED'});
}
export function buildFinanceWalletReadRouter(pool:Pool){
 const router=Router();
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 async function serve(req:Request,res:import('express').Response,kind:WalletKind){
  let week:string;
  try{week=req.query.week===undefined?currentMexicoWeek(new Date()):mondayWeek(req.query.week);}
  catch{res.status(422).json({error:'WALLET_WEEK_INVALID'});return;}
  try{
   const s=await current(req);
   if(!s.user.isActive||s.user.role!==kind){forbidden(res);return;}
   let id=s.userId;
   if(kind==='restaurant'){
    const raw=req.params.restaurantId;
    if(typeof raw!=='string'||!/^[1-9][0-9]{0,9}$/.test(raw)){res.status(422).json({error:'WALLET_RESTAURANT_ID_INVALID'});return;}
    id=Number(raw);
    const owner=await pool.query<{owner_id:number}>(
     'SELECT owner_id FROM restaurants WHERE id=$1',[id]);
    if(owner.rows[0]?.owner_id!==s.userId){forbidden(res);return;}
   }else{
    const verified=await pool.query<{user_id:number}>(
     'SELECT user_id FROM driver_profiles WHERE user_id=$1 AND is_verified=true',[s.userId]);
    if(verified.rows.length!==1){forbidden(res);return;}
   }
   const rows=await pool.query<WeeklyLedgerRow>(
    'SELECT a.order_id,a.amount_minor::text,a.state,a.tender,a.fulfillment,'+
    'o.delivered_at,'+
    "CASE WHEN h.order_id IS NOT NULL THEN 'restaurant' ELSE c.collector_kind END AS custody_collector_kind,"+
    'CASE WHEN h.order_id IS NOT NULL THEN h.restaurant_id ELSE c.collector_id END AS custody_collector_id,'+
    'c.collected_minor::text AS custody_collected_minor,'+
    "CASE WHEN h.order_id IS NOT NULL THEN 'merchant_acknowledged_not_bank_settled' ELSE c.status END AS custody_status,"+
    '(SELECT COUNT(*)::text FROM tala_live_financial_cases fc WHERE fc.order_id=o.id AND fc.status<>\'resolved\') AS open_financial_cases '+
    'FROM tala_live_payee_allocations a JOIN orders o ON o.id=a.order_id '+
    'LEFT JOIN tala_live_cash_custody c ON c.order_id=o.id '+
    "LEFT JOIN finance_cash_handoffs_v2 h ON h.order_id=o.id AND h.status='confirmed' "+
    'AND h.expected_minor=c.collected_minor AND h.driver_user_id=o.driver_id '+
    'WHERE a.payee_kind=$1 AND a.payee_id=$2 '+
    "AND o.delivered_at>=($3::date AT TIME ZONE 'America/Mexico_City') "+
    "AND o.delivered_at<(($3::date+INTERVAL '7 days') AT TIME ZONE 'America/Mexico_City') "+
    'ORDER BY o.delivered_at DESC,a.order_id DESC LIMIT 501',
    [kind,id,week]);
   if(rows.rows.length>500){res.status(409).json({error:'WALLET_TOO_MANY_ROWS_USE_AUDITED_EXPORT'});return;}
   const statement=summarizeWalletRows(kind,id,week,rows.rows);
   res.json({...statement,generated_at:new Date().toISOString(),
    completeness:'ALLOCATIONS_ONLY_NO_HISTORICAL_BACKFILL',
    release_approved:false});
  }catch{res.status(503).json({error:'WALLET_RECONCILIATION_READ_UNAVAILABLE'});}
 }
 router.get('/owner/wallet/weekly/:restaurantId',
  (req,res)=>{void serve(req,res,'restaurant');});
 router.get('/driver/wallet/weekly',
  (req,res)=>{void serve(req,res,'driver');});
 return router;
}
