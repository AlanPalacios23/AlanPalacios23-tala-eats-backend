/** RC8.4 seller Connect/onboarding and finance operations, NO funds movement. */
import {Router,type Request} from 'express';
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {current} from '../auth/routes.js';
import {config} from '../config.js';
import {settlementEligibility} from './settlement-eligibility.js';
import {requireTreasuryBankStepUp} from './treasury-connect-step-up.js';
type Provider=Pick<Stripe,'accounts'|'accountLinks'|'refunds'|'disputes'>;
const id=(raw:unknown)=>{const s=String(raw??'');if(!/^[1-9][0-9]{0,9}$/.test(s))throw Error('ID_INVALID');return Number(s);};
const money=(s:string)=>{if(!/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(s))throw Error('MONEY_INVALID');const [a,b]=s.split('.');return Number(a)*100+Number(b);};
async function admin(req:Request){
 const s=await current(req);
 if(s.user.role!=='admin'||!s.user.twoFactorEnabled||!s.mfaVerified)throw Error('MFA_REQUIRED');
 return s.userId;
}
export function buildLiveMerchantFinanceRouter(pool:Pool,stripe:Provider){
 const r=Router();
 r.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 r.post('/admin/finance/connect-map',async(req,res)=>{
  try{
   const actor=await admin(req),rid=id(req.body?.restaurant_id);
   const account=req.body?.stripe_account_id;
   if(typeof account!=='string'||!/^acct_[A-Za-z0-9]+$/.test(account))throw Error('BAD_ACCT');
   const owners=await pool.query<{owner_id:number;email:string}>(
    "SELECT r.owner_id,u.email FROM restaurants r JOIN users u ON u.id=r.owner_id WHERE r.id=$1 AND r.owner_id IS NOT NULL AND u.is_active=true AND u.role='restaurant'",[rid]);
   if(owners.rows.length!==1){res.status(404).json({error:'SELLER_OWNER_REQUIRED'});return;}
   // Platform funds must never be mapped as a seller's Connect recipient.
   // Both accounts are read through Stripe: IDs aren't trusted from the app.
   if(account===config.STRIPE_PLATFORM_ACCOUNT_ID){
    res.status(409).json({error:'PLATFORM_ACCOUNT_IS_NOT_MERCHANT'});return;
   }
   const remote=await stripe.accounts.retrieve(account);
   if(remote.id!==account||remote.country!=='MX'||!remote.email||
      remote.email.trim().toLowerCase()!==owners.rows[0]!.email.trim().toLowerCase()){
    res.status(409).json({error:'SELLER_STRIPE_EMAIL_MISMATCH'});return;
   }
   const driverAccount=await pool.query(
    'SELECT user_id FROM tala_live_driver_accounts WHERE stripe_account_id=$1',[account]);
   if(driverAccount.rowCount){
    res.status(409).json({error:'CONNECT_ACCOUNT_ALREADY_BELONGS_TO_DRIVER'});return;
   }
   const created=await pool.query(
    'INSERT INTO tala_live_merchant_accounts(restaurant_id,stripe_account_id,registered_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING restaurant_id',
    [rid,account,actor]);
   res.status(created.rowCount===1?201:409).json(created.rowCount===1?
     {restaurant_id:rid,status:'owner_confirmation_required'}:{error:'ACCOUNT_ALREADY_MAPPED'});
  }catch{res.status(403).json({error:'CONNECT_MAPPING_DENIED'});}
 });
 r.post('/owner/finance/connect/:rid/confirm',async(req,res)=>{
  try{
   const s=await current(req),rid=id(req.params.rid);
   if(s.user.role!=='restaurant'||!s.user.isActive){
    res.status(403).json({error:'NOT_ACTIVE_SELLER_OWNER'});return;
   }
   const owner=await pool.query<{owner_id:number;stripe_account_id:string;email:string}>(
    "SELECT r.owner_id,m.stripe_account_id,u.email FROM restaurants r JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id JOIN users u ON u.id=r.owner_id WHERE r.id=$1 AND u.is_active=true",[rid]);
   const mapped=owner.rows[0];
   if(mapped?.owner_id!==s.userId||mapped.stripe_account_id===config.STRIPE_PLATFORM_ACCOUNT_ID){
    res.status(403).json({error:'NOT_SELLER_OWNER'});return;
   }
   await requireTreasuryBankStepUp(pool,s,req.body?.totp);
   const remote=await stripe.accounts.retrieve(mapped.stripe_account_id);
   if(remote.id!==mapped.stripe_account_id||remote.country!=='MX'||
     remote.email?.trim().toLowerCase()!==mapped.email.trim().toLowerCase()){
     res.status(409).json({error:'CONNECT_OWNER_MISMATCH'});return;
   }
   await pool.query('UPDATE tala_live_merchant_accounts SET owner_approved_at=COALESCE(owner_approved_at,NOW()),updated_at=NOW() WHERE restaurant_id=$1 AND stripe_account_id=$2',[rid,mapped.stripe_account_id]);
   res.json({restaurant_id:rid,owner_confirmed:true});
  }catch{res.status(403).json({error:'OWNER_CONFIRMATION_DENIED'});}
 });
 r.get('/admin/finance/connect/:rid/status',async(req,res)=>{
  try{
   await admin(req);
   const rid=id(req.params.rid);
   const rows=await pool.query<{stripe_account_id:string;owner_approved_at:Date|null}>(
    'SELECT stripe_account_id,owner_approved_at FROM tala_live_merchant_accounts WHERE restaurant_id=$1',[rid]);
   if(!rows.rows[0]){res.status(404).json({error:'ACCOUNT_NOT_MAPPED'});return;}
   const x=await stripe.accounts.retrieve(rows.rows[0].stripe_account_id);
   res.json({restaurant_id:rid,owner_approved:Boolean(rows.rows[0].owner_approved_at),
    charges_enabled:x.charges_enabled,transfers_active:x.capabilities?.transfers==='active',
    payouts_enabled:x.payouts_enabled,details_submitted:x.details_submitted,
    transfer_automation_enabled:false});
  }catch{res.status(503).json({error:'CONNECT_STATUS_UNAVAILABLE'});}
 });
 r.get('/owner/finance/connect/:rid/status',async(req,res)=>{
  try{
   const s=await current(req),rid=id(req.params.rid);
   const rows=await pool.query<{owner_id:number;stripe_account_id:string;owner_approved_at:Date|null;owner_email:string;owner_active:boolean}>(
    'SELECT r.owner_id,m.stripe_account_id,m.owner_approved_at,u.email AS owner_email,u.is_active AS owner_active FROM restaurants r JOIN tala_live_merchant_accounts m ON m.restaurant_id=r.id JOIN users u ON u.id=r.owner_id WHERE r.id=$1',
    [rid]);
   const x=rows.rows[0];
   if(!x||x.owner_id!==s.userId){
    res.status(403).json({error:'OWNER_CONNECT_NOT_REGISTERED'});return;
   }
   const stripeAccount=await stripe.accounts.retrieve(x.stripe_account_id);
   const ownerApproved=Boolean(x.owner_approved_at);
   const transferActive=stripeAccount.capabilities?.transfers==='active';
   const payoutsEnabled=stripeAccount.payouts_enabled===true;
   const submitted=stripeAccount.details_submitted===true;
   const identityMatches=x.owner_active===true&&
     stripeAccount.id===x.stripe_account_id&&
     stripeAccount.id!==config.STRIPE_PLATFORM_ACCOUNT_ID&&
     stripeAccount.country==='MX'&&
     typeof stripeAccount.email==='string'&&
     stripeAccount.email.trim().toLowerCase()===x.owner_email.trim().toLowerCase();
   const requirementsClear=!stripeAccount.requirements?.disabled_reason&&
     (stripeAccount.requirements?.currently_due?.length??0)===0&&
     (stripeAccount.requirements?.past_due?.length??0)===0;
   res.json({restaurant_id:rid,owner_approved:ownerApproved,
    transfers_active:transferActive,payouts_enabled:payoutsEnabled,
    details_submitted:submitted,
    ready:ownerApproved&&transferActive&&payoutsEnabled&&submitted&&identityMatches&&requirementsClear,
    bank_payout_executed:false});
  }catch{res.status(503).json({error:'OWNER_CONNECT_STATUS_UNAVAILABLE'});}
 });
 r.post('/owner/finance/connect/:rid/onboarding-link',async(req,res)=>{
  try{
   const s=await current(req),rid=id(req.params.rid);
   if(s.user.role!=='restaurant'||!s.user.isActive){
    res.status(403).json({error:'SELLER_NOT_AUTHORIZED'});return;
   }
   const accounts=await pool.query<{owner_id:number;stripe_account_id:string;owner_approved_at:Date|null;email:string}>(
    "SELECT r.owner_id,m.stripe_account_id,m.owner_approved_at,u.email FROM restaurants r JOIN tala_live_merchant_accounts m ON r.id=m.restaurant_id JOIN users u ON u.id=r.owner_id WHERE r.id=$1 AND u.is_active=true",[rid]);
   const x=accounts.rows[0];
   if(!x||x.owner_id!==s.userId||!x.owner_approved_at||
      x.stripe_account_id===config.STRIPE_PLATFORM_ACCOUNT_ID){
    res.status(403).json({error:'SELLER_NOT_AUTHORIZED'});return;
   }
   await requireTreasuryBankStepUp(pool,s,req.body?.totp);
   const remote=await stripe.accounts.retrieve(x.stripe_account_id);
   if(remote.id!==x.stripe_account_id||remote.country!=='MX'||
      remote.email?.trim().toLowerCase()!==x.email.trim().toLowerCase()){
    res.status(409).json({error:'SELLER_STRIPE_OWNER_CHANGED'});return;
   }
   const link=await stripe.accountLinks.create({
    account:x.stripe_account_id,type:'account_onboarding',
    refresh_url:'https://talaeats.alan-palacios-dev.com/api/v1/connect/onboarding/refresh',
    return_url:'https://talaeats.alan-palacios-dev.com/api/v1/connect/onboarding/return',
   });
   res.json({url:link.url,expires_at:link.expires_at});
  }catch(e){
   const msg=e instanceof Error?e.message:'';
   if(msg.startsWith('CONNECT_FRESH_TOTP_')||msg==='TREASURY_TOTP_RATE_LIMITED'){
    res.status(msg==='TREASURY_TOTP_RATE_LIMITED'?429:403).json({error:msg});return;
   }
   res.status(503).json({error:'ONBOARDING_LINK_UNAVAILABLE'});
  }
 });
 // Stripe sends no proof of approval to return_url; NEVER mark the bank
 // verified or write a withdrawal based on this unauthenticated callback.
 r.get('/connect/onboarding/:step',(req,res)=>{
  const step=req.params.step;
  if(step!=='return'&&step!=='refresh'){res.status(404).end();return;}
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const expired=step==='refresh';
  const heading=expired?'Tu enlace de Stripe venció':'Volviste desde Stripe';
  const detail=expired?
   'Regresa a Tala Eats y solicita un nuevo enlace desde Wallet. No necesitas compartir tus datos bancarios con Tala Eats.':
   'Stripe ha terminado este paso. Regresa a Tala Eats y abre Wallet: la app consultará el estado actualizado directamente en Stripe. Este retorno no significa que tu banco ya esté aprobado.';
  res.status(200).type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tala Eats | Stripe Connect</title><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;background:#faf9f6;color:#171717;font-family:system-ui,-apple-system,sans-serif;padding:24px}main{width:100%;max-width:480px;background:white;border-radius:24px;border:1px solid #eee;padding:32px 28px;box-shadow:0 16px 56px #1717170b}h1{font-size:26px;line-height:1.2;margin:0 0 18px}p{font-size:16px;line-height:1.6;margin:0 0 14px;color:#4b4b4b}.brand{font-weight:750;letter-spacing:-.02em;color:#ef7d23;margin:0 0 28px}.note{background:#fff5eb;border-radius:12px;padding:16px;margin-top:20px;color:#5f3b19;font-size:14px}@media(max-width:375px){main{padding:24px}}</style></head><body><main><div class="brand">Tala Eats</div><h1>${heading}</h1><p>${detail}</p><div class="note">En Android, cambia de Chrome a Tala Eats desde tus aplicaciones recientes. En Wallet, consulta el estado del banco o desliza para actualizar.</div></main></body></html>`);
 });
 r.get('/admin/finance/cases',async(req,res)=>{
  try{
   await admin(req);
   const rows=await pool.query('SELECT id,order_id,case_type,stripe_object_id,status,created_at,reviewed_at,resolved_at FROM tala_live_financial_cases ORDER BY (CASE WHEN status=\'resolved\' THEN 1 ELSE 0 END),created_at DESC LIMIT 100');
   res.json({cases:rows.rows});
  }catch{res.status(503).json({error:'CASES_UNAVAILABLE'});}
 });
 r.post('/admin/finance/cases/:id/review',async(req,res)=>{
  try{
   const actor=await admin(req),caseId=id(req.params.id);
   const evidence=req.body?.evidence_ref;
   if(typeof evidence!=='string'||!/^[A-Za-z0-9_:/.-]{12,300}$/.test(evidence)){
    res.status(422).json({error:'VERIFIABLE_EVIDENCE_REFERENCE_REQUIRED'});return;
   }
   const row=await pool.query(
    'UPDATE tala_live_financial_cases SET status=\'reviewed\',reviewed_by_user_id=$2,reviewed_at=NOW(),evidence_ref=$3,updated_at=NOW() WHERE id=$1 AND status=\'open\' RETURNING id',
    [caseId,actor,evidence]);
   res.status(row.rowCount===1?200:409).json(row.rowCount===1?
    {status:'reviewed',case_id:caseId}:{error:'CASE_STATUS_CONFLICT'});
  }catch{res.status(403).json({error:'REVIEW_DENIED'});}
 });
 r.post('/admin/finance/cases/:id/resolve',async(req,res)=>{
  try{
   const actor=await admin(req),caseId=id(req.params.id);
   const found=await pool.query<{case_type:string;stripe_object_id:string;last_event_id:string;status:string}>(
    'SELECT case_type,stripe_object_id,last_event_id,status FROM tala_live_financial_cases WHERE id=$1',[caseId]);
   const c=found.rows[0];
   if(!c||c.status!=='reviewed'){res.status(409).json({error:'CASE_NOT_REVIEWED'});return;}
   if(c.case_type==='dispute'){
     const x=await stripe.disputes.retrieve(c.stripe_object_id);
     if(x.status!=='won'){res.status(409).json({error:'DISPUTE_NOT_WON'});return;}
   }else if(c.case_type==='refund'||c.case_type==='refund_failure'){
     const x=await stripe.refunds.retrieve(c.stripe_object_id);
     if(x.status!==(c.case_type==='refund'?'succeeded':'failed')){
       res.status(409).json({error:'REFUND_STATUS_MISMATCH'});return;
     }
   }else{res.status(409).json({error:'UNSUPPORTED_FINANCIAL_CASE'});return;}
   const done=await pool.query(
    'UPDATE tala_live_financial_cases SET status=\'resolved\',resolved_by_user_id=$2,resolved_at=NOW(),updated_at=NOW() WHERE id=$1 AND status=\'reviewed\' AND reviewed_by_user_id<>$2 AND last_event_id=$3 RETURNING id',
    [caseId,actor,c.last_event_id]);
   res.status(done.rowCount===1?200:409).json(done.rowCount===1?
    {status:'resolved',settlement_executed:false}:{error:'INDEPENDENT_APPROVAL_REQUIRED'});
  }catch{res.status(503).json({error:'RESOLUTION_EVIDENCE_INSUFFICIENT'});}
 });
 r.get('/admin/finance/settlement-preview/:id',async(req,res)=>{
  try{
   await admin(req);
   const orderId=id(req.params.id);
   const query=await pool.query<{
    order_id:number;restaurant_id:number;status:string;payment_status:string;
    total:string;restaurant_payout:string;refunded_amount:string;
    stripe_account_id:string|null;owner_approved_at:Date|null;
    captures:string;open_cases:string;prior_approvals:string;
   }>(
    "SELECT o.id AS order_id,o.restaurant_id,o.status,o.payment_status,o.total::text,o.restaurant_payout::text,o.refunded_amount::text,m.stripe_account_id,m.owner_approved_at,"+
    "(SELECT count(*) FROM financial_ledger_entries l WHERE l.order_id=o.id AND l.kind='stripe_live_payment' AND l.direction='credit' AND l.account='stripe_live_collected' AND l.amount=o.total) AS captures,"+
    "(SELECT count(*) FROM tala_live_financial_cases c WHERE c.order_id=o.id AND c.status<>'resolved') AS open_cases,"+
    "(SELECT count(*) FROM tala_live_settlement_proposals p WHERE p.order_id=o.id AND p.state IN('approved','transferred')) AS prior_approvals "+
    "FROM orders o LEFT JOIN tala_live_merchant_accounts m ON m.restaurant_id=o.restaurant_id WHERE o.id=$1",
    [orderId]);
   const o=query.rows[0];
   if(!o){res.status(404).json({error:'ORDER_NOT_FOUND'});return;}
   const x=o.stripe_account_id?await stripe.accounts.retrieve(o.stripe_account_id):null;
   const gate=settlementEligibility({
    status:o.status,paymentStatus:o.payment_status,
    total:money(o.total),payout:money(o.restaurant_payout),
    refunded:money(o.refunded_amount),captured:o.captures==='1',
    cases:Number(o.open_cases),approved:Boolean(o.owner_approved_at),
    transfers:x?.capabilities?.transfers==='active',
    payouts:x?.payouts_enabled===true,details:x?.details_submitted===true,
    transferRecorded:o.prior_approvals!=='0',
   });
   res.json({order_id:orderId,restaurant_id:o.restaurant_id,
     seller_amount_minor:money(o.restaurant_payout),currency:'mxn',
     ...gate,transfer_created:false,policy:'separate_charges_and_transfers_hold'});
  }catch{res.status(503).json({error:'SETTLEMENT_PREVIEW_UNAVAILABLE'});}
 });
 return r;
}
