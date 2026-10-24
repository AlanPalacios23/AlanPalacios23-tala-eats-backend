/** RC8.5: restaurant/driver earnings, Connect onboarding, cash audit.
 * No Stripe Transfer/Payout/Refund endpoints. Financial writes are
 * additive HELD allocations and physical-cash evidence, never bank receipts.
 */
import {Router,type Request} from 'express';
import type {Pool,PoolClient} from 'pg';
import type Stripe from 'stripe';
import {current} from '../auth/routes.js';
import {config} from '../config.js';
import {buildMoneyPlan,cashCollectorWhoMaySubmit} from './payee-allocation.js';
type StripeRead=Pick<Stripe,'accounts'|'accountLinks'>;
const numeric=(v:unknown)=>{
 const s=String(v??'');
 if(!/^[1-9][0-9]{0,9}$/.test(s))throw Error('ID_INVALID');
 return Number(s);
};
const centavos=(v:string)=>{
 if(!/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(v))throw Error('AMOUNT_INVALID');
 const [a,b]=v.split('.');return Number(a)*100+Number(b);
};
const evidence=(v:unknown)=>{
 if(typeof v!=='string'|| !/^[A-Za-z0-9_.:/-]{12,300}$/.test(v))
   throw Error('EVIDENCE_INVALID');
 return v;
};
async function admin(req:Request){
 const s=await current(req);
 if(s.user.role!=='admin'||!s.user.twoFactorEnabled||!s.mfaVerified)
   throw Error('ADMIN_MFA_REQUIRED');
 return s.userId;
}
async function driver(req:Request){
 const s=await current(req);
 if(s.user.role!=='driver')throw Error('DRIVER_SESSION_REQUIRED');
 return s.userId;
}
const txt=(v:unknown)=>String(v??'0');
export function buildPayeeFinanceRouter(pool:Pool,stripe:StripeRead){
 const r=Router();
 r.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 r.post('/admin/finance/driver/connect-map',async(req,res)=>{
  try{
   const actor=await admin(req);
   const userId=numeric(req.body?.driver_user_id);
   const account=req.body?.stripe_account_id;
   if(typeof account!=='string'||!/^acct_[A-Za-z0-9]+$/.test(account)||
      account===config.STRIPE_PLATFORM_ACCOUNT_ID)
      {res.status(422).json({error:'CONNECT_ACCOUNT_INVALID'});return;}
   const seller=await pool.query<{email:string}>(
     "SELECT u.email FROM users u JOIN driver_profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.role='driver' AND u.is_active=true AND p.is_verified=true",
     [userId]);
   if(seller.rows.length!==1){res.status(409).json({error:'DRIVER_NOT_VERIFIED'});return;}
   const acct=await stripe.accounts.retrieve(account);
   if(acct.id!==account||acct.country!=='MX'||!acct.email||
      acct.email.trim().toLowerCase()!==seller.rows[0]!.email.trim().toLowerCase()){
     res.status(409).json({error:'DRIVER_STRIPE_ACCOUNT_MISMATCH'});return;
   }
   // Single Connect recipient may not be used for both a restaurant and
   // a courier: each payable beneficiary must remain independently auditable.
   const cross=await pool.query(
     'SELECT restaurant_id FROM tala_live_merchant_accounts WHERE stripe_account_id=$1',
     [account]);
   if(cross.rowCount){res.status(409).json({error:'CONNECT_ACCOUNT_ALREADY_BELONGS_TO_RESTAURANT'});return;}
   const saved=await pool.query(
     'INSERT INTO tala_live_driver_accounts(user_id,stripe_account_id,registered_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',
     [userId,account,actor]);
   res.status(saved.rowCount===1?201:409).json(saved.rowCount===1?
     {driver_user_id:userId,owner_confirmation_required:true}:
     {error:'DRIVER_CONNECT_ALREADY_LINKED'});
  }catch{res.status(403).json({error:'DRIVER_CONNECT_REGISTRATION_DENIED'});}
 });
 r.post('/driver/finance/connect/confirm',async(req,res)=>{
  try{
   const userId=await driver(req);
   const result=await pool.query(
     'UPDATE tala_live_driver_accounts SET owner_approved_at=COALESCE(owner_approved_at,NOW()),updated_at=NOW() WHERE user_id=$1 RETURNING user_id',[userId]);
   res.status(result.rowCount===1?200:404).json(result.rowCount===1?
     {owner_confirmed:true}:{error:'DRIVER_CONNECT_NOT_REGISTERED'});
  }catch{res.status(403).json({error:'DRIVER_SESSION_REQUIRED'});}
 });
 r.get('/driver/finance/connect/status',async(req,res)=>{
  try{
   const userId=await driver(req);
   const rows=await pool.query<{stripe_account_id:string;owner_approved_at:Date|null}>(
     'SELECT stripe_account_id,owner_approved_at FROM tala_live_driver_accounts WHERE user_id=$1',[userId]);
   const map=rows.rows[0];
   if(!map){res.status(404).json({error:'CONNECT_NOT_REGISTERED'});return;}
   const acct=await stripe.accounts.retrieve(map.stripe_account_id);
   res.json({confirmed:Boolean(map.owner_approved_at),
     transfers_active:acct.capabilities?.transfers==='active',
     payouts_enabled:acct.payouts_enabled===true,
     details_submitted:acct.details_submitted===true,bank_transfer_executed:false});
  }catch{res.status(503).json({error:'DRIVER_CONNECT_STATUS_UNAVAILABLE'});}
 });
 r.post('/driver/finance/connect/onboarding-link',async(req,res)=>{
  try{
   const userId=await driver(req);
   const x=await pool.query<{stripe_account_id:string;owner_approved_at:Date|null}>(
     'SELECT stripe_account_id,owner_approved_at FROM tala_live_driver_accounts WHERE user_id=$1',[userId]);
   if(!x.rows[0]?.owner_approved_at){res.status(403).json({error:'OWNER_CONFIRMATION_REQUIRED'});return;}
   const link=await stripe.accountLinks.create({
     account:x.rows[0].stripe_account_id,type:'account_onboarding',
     refresh_url:'https://talaeats.alan-palacios-dev.com/api/v1/connect/onboarding/refresh',
     return_url:'https://talaeats.alan-palacios-dev.com/api/v1/connect/onboarding/return'
   });
   res.json({url:link.url,expires_at:link.expires_at});
  }catch{res.status(503).json({error:'STRIPE_ONBOARDING_UNAVAILABLE'});}
 });
 // Read-only earnings. Held is NOT an available balance and not a bank payout.
 r.get('/driver/finance/earnings',async(req,res)=>{
  try{
   const userId=await driver(req);
   const rows=await pool.query<{
     state:string;total_minor:string;orders:string
   }>('SELECT state,COALESCE(SUM(amount_minor),0)::text AS total_minor,count(*)::text AS orders FROM tala_live_payee_allocations WHERE payee_kind=$1 AND payee_id=$2 GROUP BY state',
      ['driver',userId]);
   const cash=await pool.query<{
     status:string;due_minor:string;orders:string
   }>('SELECT status,COALESCE(SUM(due_platform_minor),0)::text AS due_minor,count(*)::text AS orders FROM tala_live_cash_custody WHERE collector_kind=$1 AND collector_id=$2 GROUP BY status',
      ['driver',userId]);
   res.json({currency:'MXN',unit:'centavos',
     earnings_by_status:rows.rows,
     physical_cash_due_to_platform:cash.rows,
     bank_payouts_not_enabled:true});
  }catch{res.status(503).json({error:'EARNINGS_UNAVAILABLE'});}
 });
 r.get('/owner/finance/earnings/:rid',async(req,res)=>{
  try{
   const s=await current(req),restaurantId=numeric(req.params.rid);
   const owner=await pool.query<{owner_id:number}>(
     'SELECT owner_id FROM restaurants WHERE id=$1',[restaurantId]);
   if(owner.rows[0]?.owner_id!==s.userId){
     res.status(403).json({error:'RESTAURANT_OWNER_REQUIRED'});return;
   }
   const rows=await pool.query(
     'SELECT state,COALESCE(SUM(amount_minor),0)::text AS total_minor,count(*)::text AS orders FROM tala_live_payee_allocations WHERE payee_kind=$1 AND payee_id=$2 GROUP BY state',
      ['restaurant',restaurantId]);
   const cash=await pool.query(
     'SELECT status,COALESCE(SUM(due_platform_minor),0)::text AS due_minor,count(*)::text AS orders FROM tala_live_cash_custody WHERE collector_kind=$1 AND collector_id=$2 GROUP BY status',
      ['restaurant',restaurantId]);
   res.json({restaurant_id:restaurantId,currency:'MXN',unit:'centavos',
     earnings_by_status:rows.rows,
     physical_cash_due_to_platform:cash.rows,
     transfer_not_executed:true});
  }catch{res.status(503).json({error:'RESTAURANT_EARNINGS_UNAVAILABLE'});}
 });
 // ADMIN: prepare *held* obligations from existing delivered server-priced
 // order + delivery proof and verified signed ledger. No funds are sent.
 r.post('/admin/finance/orders/:orderId/prepare-payables',async(req,res)=>{
  let client:PoolClient|null=null;
  try{
   await admin(req);
   const orderId=numeric(req.params.orderId);
   client=await pool.connect();
   await client.query('BEGIN');
   const read=await client.query<{
     id:number;restaurant_id:number;driver_id:number|null;
     order_type:string;status:string;payment_method:string;
     payment_status:string;total:string;tip:string;
     restaurant_payout:string;driver_earning:string;refunded_amount:string;
     delivered_at:Date|null;
   }>(
     "SELECT id,restaurant_id,driver_id,order_type,status,payment_method,payment_status,total::text,tip::text,restaurant_payout::text,driver_earning::text,refunded_amount::text,delivered_at FROM orders WHERE id=$1 FOR UPDATE",
     [orderId]);
   const o=read.rows[0];
   if(!o){throw Error('ORDER_NOT_FOUND');}
   if(centavos(o.refunded_amount)!==0)throw Error('REFUND_HOLD');
   const checks=await client.query<{proof:string;captured:string;open_cases:string}>(
     "SELECT (SELECT count(*) FROM delivery_proofs p WHERE p.order_id=$1 AND p.pin_verified=true)::text AS proof,"+
     "(SELECT count(*) FROM financial_ledger_entries l WHERE l.order_id=$1 AND l.kind='stripe_live_payment' AND l.account='stripe_live_collected' AND l.direction='credit' AND l.idempotency_key=('order:'||$1::text||':stripe-live:collected'))::text AS captured,"+
     "(SELECT count(*) FROM tala_live_financial_cases c WHERE c.order_id=$1 AND c.status<>'resolved')::text AS open_cases",
     [orderId]);
   const check=checks.rows[0];
   if(!check||!o.delivered_at)throw Error('DELIVERY_PROOF_REQUIRED');
   const plan=buildMoneyPlan({
     orderId:o.id,restaurantId:o.restaurant_id,driverUserId:o.driver_id,
     orderType:o.order_type,
     // No persistent self-delivery owner designation in existing schema:
     // reject such orders rather than mistake owner's courier for platform's.
     merchantManagedDelivery:false,
     tender:o.payment_method as 'stripe'|'cash',
     totalMinor:centavos(o.total),
     restaurantPayableMinor:centavos(o.restaurant_payout),
     driverBaseMinor:centavos(o.driver_earning),tipMinor:centavos(o.tip),
     status:o.status,paymentStatus:o.payment_status,
     deliveryProven:check.proof==='1',captured:check.captured==='1',
     openCases:Number(check.open_cases)
   });
   for(const obligation of plan.obligations){
     await client.query(
       "INSERT INTO tala_live_payee_allocations(order_id,payee_kind,payee_id,amount_minor,tender,fulfillment,state) VALUES($1,$2,$3,$4,$5,$6,'held') ON CONFLICT(order_id,payee_kind) DO NOTHING",
       [orderId,obligation.party,obligation.payeeId,obligation.amountMinor,plan.tender,plan.fulfillment]);
     const existing=await client.query<{payee_id:number;amount_minor:string;tender:string;fulfillment:string}>(
       'SELECT payee_id,amount_minor::text,tender,fulfillment FROM tala_live_payee_allocations WHERE order_id=$1 AND payee_kind=$2 FOR UPDATE',
       [orderId,obligation.party]);
     if(existing.rows.length!==1||existing.rows[0]?.payee_id!==obligation.payeeId||
       Number(existing.rows[0]?.amount_minor)!==obligation.amountMinor||
       existing.rows[0]?.tender!==plan.tender||
       existing.rows[0]?.fulfillment!==plan.fulfillment)
       throw Error('PAYEE_ALLOCATION_CONFLICT');
   }
   if(plan.cash){
     const c=plan.cash;
     await client.query(
      "INSERT INTO tala_live_cash_custody(order_id,collector_kind,collector_id,collected_minor,retained_minor,due_platform_minor) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(order_id) DO NOTHING",
      [orderId,c.collectorKind,c.collectorId,c.collectedMinor,c.retainedMinor,c.duePlatformMinor]);
     const q=await client.query<{collector_kind:string;collector_id:number;collected_minor:string;retained_minor:string;due_platform_minor:string}>(
      'SELECT collector_kind,collector_id,collected_minor::text,retained_minor::text,due_platform_minor::text FROM tala_live_cash_custody WHERE order_id=$1 FOR UPDATE',[orderId]);
     const existing=q.rows[0];
     if(!existing||existing.collector_kind!==c.collectorKind||
        existing.collector_id!==c.collectorId||
        Number(existing.collected_minor)!==c.collectedMinor||
        Number(existing.retained_minor)!==c.retainedMinor||
        Number(existing.due_platform_minor)!==c.duePlatformMinor)
       throw Error('CASH_CUSTODY_CONFLICT');
   }
   await client.query('COMMIT');
   res.json({order_id:orderId,financial_state:'held',
     obligations:plan.obligations,physical_cash:plan.cash,transfer_executed:false});
  }catch{
   if(client)await client.query('ROLLBACK').catch(()=>{});
   res.status(409).json({error:'PAYABLE_NOT_ELIGIBLE_OR_CONFLICT'});
  }finally{client?.release();}
 });
 r.post('/finance/cash/:orderId/submit',async(req,res)=>{
  try{
   const session=await current(req);
   const orderId=numeric(req.params.orderId),ref=evidence(req.body?.evidence_ref);
   const row=await pool.query<{collector_kind:'driver'|'restaurant';collector_id:number;owner_id:number|null}>(
     'SELECT c.collector_kind,c.collector_id,r.owner_id FROM tala_live_cash_custody c JOIN orders o ON o.id=c.order_id JOIN restaurants r ON r.id=o.restaurant_id WHERE c.order_id=$1',[orderId]);
   const c=row.rows[0];
   if(!c||!cashCollectorWhoMaySubmit(session.userId,c.collector_kind,c.collector_id,c.owner_id)){
     res.status(403).json({error:'CASH_COLLECTOR_REQUIRED'});return;
   }
   const x=await pool.query(
     "UPDATE tala_live_cash_custody SET status='submitted',evidence_ref=$2,submitted_by=$3,submitted_at=NOW() WHERE order_id=$1 AND status='awaiting_evidence' RETURNING order_id",
     [orderId,ref,session.userId]);
   res.status(x.rowCount===1?200:409).json(x.rowCount===1?
    {status:'submitted',bank_settlement_verified:false}:
    {error:'CASH_ALREADY_SUBMITTED_OR_REVIEWED'});
  }catch{res.status(403).json({error:'CASH_SUBMISSION_DENIED'});}
 });
 r.post('/admin/finance/cash/:orderId/review',async(req,res)=>{
  try{
   const actor=await admin(req);
   const orderId=numeric(req.params.orderId);
   const rcv=await pool.query(
     "UPDATE tala_live_cash_custody SET status='reviewed',reviewed_by=$2,reviewed_at=NOW() WHERE order_id=$1 AND status='submitted' AND submitted_by<>$2 AND evidence_ref IS NOT NULL RETURNING order_id",
     [orderId,actor]);
   res.status(rcv.rowCount===1?200:409).json(rcv.rowCount===1?
     {status:'reviewed',platform_bank_deposit_confirmed:false}:
     {error:'CASH_REVIEW_CONFLICT'});
  }catch{res.status(403).json({error:'CASH_REVIEW_DENIED'});}
 });
 // Intentionally NO /cash/settle: a photo is not a verified bank credit.
 // A future treasury connector must match the bank statement amount and
 // deposit reference before recording an actual settled balance.
 return r;
}
